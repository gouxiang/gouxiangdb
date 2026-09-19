// M5/S9 /api/v1/admin/search + embedding 管理面六端点（M5-implementation-plan §9、§5.4）。
//
// 挂载纪律：与 /search 同门，仅 config.m5Search !== "off" 时由 routes/v1/index.ts 条件挂载；
// off 时六端点全部落 v1 自身 404（gate 有"零建库"文件系统断言）。
//
// 授权：六端点全部限工作区 role_owner，照 routes/v1/scope.ts 的 resolveSubject 范式，
// 不新增 manage_search 动作（§9）。业务在 domain/search/{reindex,adminStatus,adminEmbedding}，
// 本文件只做 owner 校验、审计、错误信封（{error,code}），不写业务/不直连 ORM 查询逻辑。
// 审计 detail 脱敏在 writeAudit 统一做（apiKey 命中即 [REDACTED]）；本文件从不把 key 值传入。

import { Hono } from "hono";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { resolveSubject } from "../../domain/authz/subjects.js";
import { resolveSearchDbPath } from "../../domain/search/searchStore.js";
import { startReindex, ReindexInProgressError } from "../../domain/search/reindex.js";
import { buildSearchStatus } from "../../domain/search/adminStatus.js";
import {
  getEmbeddingConfig,
  patchEmbeddingConfig,
  rotateApiKey,
  clearApiKey,
  EmbeddingConfigInvalid,
  NeedCloudConfirm,
} from "../../domain/search/adminEmbedding.js";
import { testEmbeddingConnection } from "../../domain/search/embeddingProbe.js";
import { writeAudit, type AuditEventName } from "../../audit/audit.js";
import { sourceIp } from "../../utils/client-ip.js";

export const adminSearchRoutes = new Hono();

const REINDEX_TYPES = new Set(["record", "doc", "canvas"]);

function searchPath(): string {
  return resolveSearchDbPath(process.env, config.dataDir);
}

/** role_owner 闸门（fail-closed）。 */
async function assertOwner(userId: string): Promise<void> {
  const actor = await resolveSubject(userId, prisma);
  if (!actor.isWorkspaceOwner) throw new HttpError(403, "检索管理面仅工作区 owner 可用", "FORBIDDEN");
}

function recordAudit(
  event: AuditEventName,
  status: number,
  actorId: string,
  ip: string,
  method: string,
  urlPath: string,
  detail?: Record<string, unknown>,
): void {
  writeAudit(config.auditDir, { event, actorId, ip, method, path: urlPath, status, detail });
}

// 1) POST /admin/reindex（异步 202；进行中 409）。
adminSearchRoutes.post("/reindex", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);

  let body: { type?: string; entityId?: string } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as { type?: string; entityId?: string };
  } catch {
    body = {};
  }
  const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
  const typeRaw = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
  const scope = entityId
    ? { type: (REINDEX_TYPES.has(typeRaw) ? typeRaw : "record") as "record" | "doc" | "canvas", entityId }
    : {};

  const ip = sourceIp(c);
  const urlPath = c.req.path;
  let task: Promise<unknown>;
  try {
    task = startReindex(
      {
        prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir,
        jwtSecret: config.jwtSecret, searchPath: searchPath(),
      },
      scope,
    );
  } catch (err) {
    if (err instanceof ReindexInProgressError) {
      throw new HttpError(409, "重建正在进行中", "REINDEX_IN_PROGRESS");
    }
    throw err;
  }
  recordAudit("search_reindex_started", 202, userId, ip, "POST", urlPath, {
    scope: scope.entityId ? { type: scope.type, entityIdPresent: true } : { full: true },
  });
  // 异步重建：立即 202；完成/失败在后台留痕（detail 只带计数/范围，不含查询词/key）。
  task
    .then((r) => {
      const x = r as {
        mode: string; entities: number; chunksWritten: number; vecWritten: number;
        vecDebt: number; swapped: boolean;
      };
      recordAudit("search_reindex_done", 200, userId, ip, "POST", urlPath, {
        mode: x.mode, entities: x.entities, chunksWritten: x.chunksWritten,
        vecWritten: x.vecWritten, vecDebt: x.vecDebt, swapped: x.swapped,
      });
    })
    .catch((e: unknown) => recordAudit("search_reindex_failed", 500, userId, ip, "POST", urlPath, {
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
    }));
  return c.json({ job: "reindex", status: "started" }, 202);
});

// 2) GET /admin/search/status。
adminSearchRoutes.get("/search/status", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  const status = await buildSearchStatus({
    prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir,
    jwtSecret: config.jwtSecret, searchPath: searchPath(),
  });
  return c.json(status);
});

// 3) GET /admin/embedding/config。
adminSearchRoutes.get("/embedding/config", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  const cfg = await getEmbeddingConfig({
    prisma, env: process.env, jwtSecret: config.jwtSecret, searchPath: searchPath(),
  });
  return c.json(cfg);
});

function mapConfigError(err: unknown): never {
  if (err instanceof EmbeddingConfigInvalid) {
    throw new HttpError(400, err.message, "EMBEDDING_CONFIG_INVALID");
  }
  if (err instanceof NeedCloudConfirm) {
    throw new HttpError(409, err.message, "NEED_CLOUD_CONFIRM");
  }
  throw err;
}

// 4) PATCH /admin/embedding/config。
adminSearchRoutes.patch("/embedding/config", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "请求体必须是合法 JSON", "EMBEDDING_CONFIG_INVALID");
  }
  let result: Awaited<ReturnType<typeof patchEmbeddingConfig>>;
  try {
    result = await patchEmbeddingConfig(
      { prisma, env: process.env, jwtSecret: config.jwtSecret, searchPath: searchPath() },
      body,
    );
  } catch (err) {
    mapConfigError(err);
  }
  recordAudit("embedding_config_changed", 200, userId, sourceIp(c), "PATCH", c.req.path, {
    changed: result!.changed, reindexRequired: result!.reindexRequired,
  });
  return c.json({ ...result!.config, reindexRequired: result!.reindexRequired });
});

// 5) POST /admin/embedding/api-key/rotate。
adminSearchRoutes.post("/embedding/api-key/rotate", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "请求体必须是合法 JSON", "EMBEDDING_CONFIG_INVALID");
  }
  let status: Awaited<ReturnType<typeof rotateApiKey>>;
  try {
    status = await rotateApiKey(
      { prisma, env: process.env, jwtSecret: config.jwtSecret, searchPath: searchPath() },
      body,
    );
  } catch (err) {
    mapConfigError(err);
  }
  recordAudit("embedding_api_key_rotated", 200, userId, sourceIp(c), "POST", c.req.path, {
    configured: status!.configured, source: status!.source,
  });
  return c.json(status);
});

// 7) POST /admin/embedding/test-connection（只探活，不落库、不回凭据）。
adminSearchRoutes.post("/embedding/test-connection", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  const result = await testEmbeddingConnection({
    prisma, env: process.env, jwtSecret: config.jwtSecret,
  });
  recordAudit("embedding_connection_tested", 200, userId, sourceIp(c), "POST", c.req.path, {
    ok: result.ok, latencyMs: result.latencyMs, errorKind: result.errorKind,
  });
  // 探活结论一律 200：失败是"没通"这一事实，不是服务端故障，别把配置页刷成红色错误。
  return c.json(result);
});

// 6) DELETE /admin/embedding/api-key。
adminSearchRoutes.delete("/embedding/api-key", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  const status = await clearApiKey({
    prisma, env: process.env, jwtSecret: config.jwtSecret, searchPath: searchPath(),
  });
  recordAudit("embedding_api_key_cleared", 204, userId, sourceIp(c), "DELETE", c.req.path, {
    configured: status.configured, source: status.source,
  });
  return c.body(null, 204);
});
