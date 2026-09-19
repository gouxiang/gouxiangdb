// M5/S9 /api/v1/admin/search + embedding 管理面六端点（M5-implementation-plan §9、§5.4）。
//
// 挂载纪律：与 /search 同门——**恒挂载**，是否可用在请求期按总门判定（db 覆盖优先于 env）：
// 目标态 off 时六端点全部 404 NOT_FOUND，且在任何 search.db 访问之前短路（零建库断言不变）。
// 之所以改成请求期闸门：后台 app_settings 的 search.enabled=on 必须在 GX_M5_SEARCH=off 时也能
// 打开管理面，否则配置页本身就是个点了没反应的开关。
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
import { loadSearchGateFlag } from "../../domain/search/searchGate.js";
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

/**
 * 总门闸门（请求期，db 覆盖优先于 env）：目标态 off 一律 404 NOT_FOUND。
 *
 * 只加在【运营面与出网面】（reindex / status / test-connection）：它们会打开或触碰 search.db、
 * 或向外部服务发请求，总门关着就不该发生（零建库、零出网断言的前提）。
 *
 * 配置面（embedding config GET/PATCH、api-key rotate/clear）**故意不加这道门**：它们只读写
 * app_settings，而 search.enabled 本身正是要在这里被打开的——若连配置面也被总门挡在门外，
 * env=off 时管理员就永远无法在界面上把检索打开，开关成了死结（先有鸡还是先有蛋）。
 * 这些端点仍受 role_owner 硬门（assertOwner），并未放开任何权限。
 */
async function assertSearchGate(): Promise<void> {
  const gateFlag = await loadSearchGateFlag(prisma, config.jwtSecret, process.env, config.m5Search);
  if (gateFlag === "off") throw new HttpError(404, "统一检索未启用", "NOT_FOUND");
}

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
  // 总门判定先于 owner 判定：off 时对任何人都是 404（与"端点未挂载"同口径，不区分身份）。
  await assertSearchGate();
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
  // 状态面要读 search.db：总门 off 时不碰库，直接 404（先于 owner 判定）
  await assertSearchGate();
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
  // 出网探活：总门 off 时零出网（与既有 zero-egress 断言同口径），同样先于 owner 判定
  await assertSearchGate();
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
