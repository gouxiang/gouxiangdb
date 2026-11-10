// /api/v1/admin/update/* 应用版本更新管理面（DESIGN §6.1/§5.5）。
//
// 挂载：routes/v1/index.ts 仅在 config.update.enabled（默认 on，GX_UPDATE_ENABLED=off 关闭）
// 时以同前缀 /admin 分路由器叠加挂载；未挂载时落 v1 自身 404。
// 授权：复用 v1 的 requireActiveUser 链 + role_owner owner 闸（同 adminSearch 口径）。
// 本文件只做参数校验、owner 闸、调 UpdateService、错误码→HTTP 映射、审计；
// 业务编排在 domain/update/service.ts，本文件不直连 ORM、不拼上游地址。
//
// 审计铁律（§5.5）：update_checked detail 只带 channel/currentVersion/candidateVersion?/
// verdict/sourceKind/durationMs/errorCode?；禁止 url / token / Authorization / 上游错误体。

import { Hono } from "hono";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { resolveSubject } from "../../domain/authz/subjects.js";
import type { CheckParams, UpdateService } from "../../domain/update/service.js";
import { issueDownloadTicket } from "../../domain/update/download.js";
import {
  UpdateSourceError,
  type UpdateSourceErrorCode,
} from "../../domain/update/types.js";
import { writeAudit, type AuditEventName } from "../../audit/audit.js";
import { sourceIp } from "../../utils/client-ip.js";
import { updateService, updatePrefetcher, updatePrefetcherReady } from "./updateRuntime.js";

export const adminUpdateRoutes = new Hono();

const ARCHES = new Set(["x64", "arm64"]);
const PLATFORMS = new Set(["linux", "darwin", "win32"]);

/** role_owner 闸门（fail-closed），口径同 adminSearch.assertOwner。 */
async function assertOwner(userId: string): Promise<void> {
  const actor = await resolveSubject(userId, prisma);
  if (!actor.isWorkspaceOwner) {
    throw new HttpError(403, "仅工作区所有者可检查更新", "FORBIDDEN");
  }
}

function badRequest(message: string): never {
  throw new HttpError(400, message, "BAD_REQUEST");
}

/** 解析并校验 query；channel 合法性（须 remoteDeclarable，当前仅 desktop-client）交给 service 裁决，注册表外即 400。 */
function parseQuery(q: Record<string, string | undefined>): CheckParams {
  const params: CheckParams = {};
  if (q.channel !== undefined) params.channel = q.channel;
  if (q.arch !== undefined) {
    if (!ARCHES.has(q.arch)) badRequest("请求参数有误：arch 仅支持 x64 / arm64");
    params.arch = q.arch;
  }
  if (q.platform !== undefined) {
    if (!PLATFORMS.has(q.platform)) badRequest("请求参数有误：platform 仅支持 linux / darwin / win32");
    params.platform = q.platform;
  }
  if (q.force !== undefined) {
    if (q.force !== "1") badRequest("请求参数有误：force 仅支持 1");
    params.force = true;
  }
  return params;
}

/** 源错误码 → HTTP 状态（UNCONFIGURED/AUTH/UNREACHABLE/MANIFEST_INVALID→502；TIMEOUT→504）。 */
function statusForErrorCode(code: UpdateSourceErrorCode): number {
  return code === "UPDATE_SOURCE_TIMEOUT" ? 504 : 502;
}

/** 源错误码 → 面板可展示中性中文文案（不含内网细节，错误表 §6.1）。 */
const ERROR_MESSAGES: Record<UpdateSourceErrorCode, string> = {
  UPDATE_SOURCE_UNCONFIGURED: "更新源尚未配置，请联系部署人员",
  UPDATE_SOURCE_AUTH: "更新源凭证无效，请联系部署人员",
  UPDATE_SOURCE_UNREACHABLE: "暂时无法连接更新服务，您可以稍后重试",
  UPDATE_SOURCE_TIMEOUT: "连接更新服务超时，请稍后重试",
  UPDATE_MANIFEST_INVALID: "更新清单暂时不可用，请联系支持",
};

function recordChecked(
  status: number,
  actorId: string,
  ip: string,
  detail: Record<string, unknown>,
): void {
  writeAudit(config.auditDir, {
    event: "update_checked" as AuditEventName,
    actorId,
    ip,
    method: "GET",
    path: "/api/v1/admin/update/status",
    status,
    detail,
  });
}

// GET /admin/update/status —— 当前唯一检查端点（下载票据/代理在 S4 追加）。
adminUpdateRoutes.get("/update/status", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);
  const params = parseQuery({
    channel: c.req.query("channel"),
    arch: c.req.query("arch"),
    platform: c.req.query("platform"),
    force: c.req.query("force"),
  });

  const service = updateService();
  const ip = sourceIp(c);
  const startedAt = Date.now();

  // 身份快照用于「源错误」时仍能写出有意义的审计；非法声明通道在此抛 400（不写更新审计）。
  let identity: ReturnType<UpdateService["identitySnapshot"]>;
  try {
    identity = service.identitySnapshot(params);
  } catch (err) {
    if (err instanceof UpdateSourceError) throw err; // 理论不会：快照不拉源
    throw err;
  }

  try {
    const result = await service.check(params);
    recordChecked(200, userId, ip, {
      channel: identity.channel,
      currentVersion: identity.currentVersion,
      ...(result.candidateVersion ? { candidateVersion: result.candidateVersion } : {}),
      verdict: result.verdict,
      sourceKind: result.sourceKind,
      durationMs: Date.now() - startedAt,
    });
    // 方案 A：on 时附加后台预缓存快照（off 时不附，响应与旧版逐字节一致）。
    if (config.update.prefetchEnabled) {
      await updatePrefetcherReady();
      result.dto.prefetch = updatePrefetcher().snapshot();
    }
    return c.json(result.dto);
  } catch (err) {
    if (err instanceof UpdateSourceError) {
      const httpStatus = statusForErrorCode(err.code);
      recordChecked(httpStatus, userId, ip, {
        channel: identity.channel,
        currentVersion: identity.currentVersion,
        verdict: "source_error",
        sourceKind: config.update.source,
        durationMs: Date.now() - startedAt,
        errorCode: err.code,
      });
      // 显式传 code：HttpError 的 errorCodeForStatus 不覆盖 5xx（否则会退化为 HTTP_502）。
      throw new HttpError(httpStatus, ERROR_MESSAGES[err.code], err.code);
    }
    throw err;
  }
});

// POST /admin/update/download-ticket —— 第一段：owner 现场重算后换 120s HMAC 下载票。
adminUpdateRoutes.post("/update/download-ticket", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);

  // 请求体可选；解析失败/非对象按空身份处理（服务端自识别通道）。
  let rawBody: unknown = {};
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const params = parseQuery({
    channel: typeof body.channel === "string" ? body.channel : undefined,
    arch: typeof body.arch === "string" ? body.arch : undefined,
    platform: typeof body.platform === "string" ? body.platform : undefined,
  });

  const service = updateService();
  // 现场重算一次「有更新且 eligible 且 artifact 存在」，防止拿旧 DTO 反复换票（§6.2）。
  const result = await service.check(params);
  const info = result.dto.update;
  if (result.verdict !== "upgrade" || !info || !info.eligible || !info.artifact) {
    throw new HttpError(409, "当前没有可下载的更新", "UPDATE_NOT_AVAILABLE");
  }
  const identity = service.identitySnapshot(params);

  const { ticket, expiresAt } = issueDownloadTicket({
    secret: config.jwtSecret,
    uid: userId,
    channel: identity.channel,
    arch: identity.arch,
    platform: identity.platform,
    version: info.version,
    filename: info.artifact.filename,
    ttlMs: config.update.ticketTtlMs,
  });

  return c.json({
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
    downloadPath: `/api/v1/admin/update/download?ticket=${encodeURIComponent(ticket)}`,
  });
});

// POST /admin/update/prefetch —— 方案 A：owner 触发后端【后台】分块预拉更新包到 NAS 本地。
// 现场重算「有更新且 eligible 且 artifact 存在」（与换票同门），再凭本地身份 resolveDownload
// 定位真实资产，交给 prefetcher 后台下载；同步返回 202/200/409 + 当前快照。
// 完成/失败审计由 updateRuntime 的 onSettle 回调在后台落定时写（update_prefetch_completed/failed）。
adminUpdateRoutes.post("/update/prefetch", async (c) => {
  const userId = c.get("auth").userId;
  await assertOwner(userId);

  // 预缓存独立开关：off 时等同未注册（下载仍可走上游代理），返回 404。
  if (!config.update.prefetchEnabled) {
    throw new HttpError(404, "未启用后台预缓存", "NOT_FOUND");
  }

  let rawBody: unknown = {};
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const params = parseQuery({
    channel: typeof body.channel === "string" ? body.channel : undefined,
    arch: typeof body.arch === "string" ? body.arch : undefined,
    platform: typeof body.platform === "string" ? body.platform : undefined,
  });

  const service = updateService();
  const result = await service.check(params);
  const info = result.dto.update;
  if (result.verdict !== "upgrade" || !info || !info.eligible || !info.artifact) {
    throw new HttpError(409, "当前没有可预缓存的更新", "UPDATE_NOT_AVAILABLE");
  }
  const identity = service.identitySnapshot(params);

  // 凭本地身份定位真实资产（与下载票第二段同口径，内部再过一遍 upgrade/minVersion/filename）。
  const resolved = await service.resolveDownload({
    channel: identity.channel,
    arch: identity.arch,
    platform: identity.platform,
    version: info.version,
    filename: info.artifact.filename,
  });
  if (!resolved) {
    throw new HttpError(409, "当前没有可预缓存的更新", "UPDATE_NOT_AVAILABLE");
  }

  await updatePrefetcherReady();
  const prefetcher = updatePrefetcher();
  let decision;
  try {
    decision = prefetcher.start(resolved, {
      actorId: userId,
      ip: sourceIp(c),
      channel: identity.channel,
      arch: identity.arch,
      platform: identity.platform,
    });
  } catch {
    // 清单 sha 非法等本地状态异常：不暴露细节。
    throw new HttpError(409, "更新包状态异常，无法预缓存", "UPDATE_NOT_AVAILABLE");
  }

  // 仅「确有新任务受理」写 started 审计；幂等命中 running/ready/busy 不重复打点。
  if (decision.kind === "started") {
    writeAudit(config.auditDir, {
      event: "update_prefetch_started" as AuditEventName,
      actorId: userId,
      ip: sourceIp(c),
      method: "POST",
      path: "/api/v1/admin/update/prefetch",
      status: 202,
      detail: {
        channel: identity.channel,
        arch: identity.arch,
        platform: identity.platform,
        version: resolved.version,
        filename: resolved.artifact.filename,
        sha256: resolved.artifact.sha256,
      },
    });
  }

  const status = decision.kind === "ready" ? 200 : decision.kind === "busy" ? 409 : 202;
  return c.json({ decision: decision.kind, prefetch: prefetcher.snapshot() }, status as 200 | 202 | 409);
});
