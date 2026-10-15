// /api/v1/sync：离线优先 + 操作级双向同步服务端面（YN0 地基）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §11/§13。
//
// 挂载纪律（与 /api/v1/search「恒挂载 + 请求期闸门」同款，刻意区别于按启动 flag 静态摘挂）：
//   - 本子路由在 app.ts 中【独立于企业双 flag】恒挂到 mount 的 /api/v1/sync；
//     即使 GX_ENTERPRISE_ORG/NAV 全 off，同步面仍按自己的总门 GX_SYNC_SERVER 决定可达性。
//   - 组首中间件每次请求读 env 判定（syncServerEnabled）：off（出厂默认）-> 在【任何 DB
//     访问之前】直接 404 SYNC_DISABLED，因此默认安装不写任何 sync_* 表、不暴露同步能力，
//     旧行为逐字节不变；on -> 继续鉴权链与各子端点。
//   - 运维改 env 后无需重启即生效；测试也能在同一进程内切开/关（config 是冻结快照）。
//
// 分期：YN0 立总门 + 鉴权 + 能力探针；subscribe/snapshot/pull 在 YN2 接入；push 在 YN4 接入；
// YN5 接入逐 op 当前权限裁决 + rejected/quarantined 隔离 + incoming 同步中心（retry/discard）+
// visibility 失权对账可见集 + 审计；resolve 冲突弹窗在 YN6 接入。未落地的路径不在此预注册，以免
// 客户端把"还没做"误当成"已支持"。

import { Hono } from "hono";
import { syncServerEnabled } from "../../../configSync.js";
import { HttpError } from "../../../httpError.js";
import { requireActiveUser } from "../../../middleware/authActive.js";
import { VERSION } from "../../../version.js";
import { audit } from "../../../audit/emit.js";
import type { AuditEventName } from "../../../audit/audit.js";
import { buildBaseSnapshot, markSnapshotDone, subscribeBase, authorizeBaseRead } from "../../../domain/sync/snapshot.js";
import { pullBaseOps } from "../../../domain/sync/pull.js";
import { pushBaseOps, retryIncoming, type IncomingOp, type PushResult } from "../../../domain/sync/push.js";
import { listIncoming, discardIncoming } from "../../../domain/sync/incoming.js";
import { buildVisibilityReport } from "../../../domain/sync/visibility.js";

export const syncRoutes = new Hono();

// ① 总门：最先执行，off 即 404，且短路在鉴权/DB 之前（默认零行为、零额外写）。
syncRoutes.use("*", async (c, next) => {
  if (!syncServerEnabled()) {
    // 与统一 404 信封一致：{error,code,path}（NOT_FOUND 不透露"同步存在但关闭"以外的信息）。
    throw new HttpError(404, "同步服务未启用", "SYNC_DISABLED");
  }
  return next();
});

// ② 鉴权：同步面全部要求登录且账号 ACTIVE/tv 匹配（与 v1 主链同源，令牌头 X-GX-Token/Authorization 均收）。
syncRoutes.use("*", requireActiveUser);

// ③ 能力探针：on 且登录后可达，供客户端（Mac 侧车/节点）判定本节点是否支持离线同步与当前阶段。
//    不触碰任何 sync_* 表（只读 env/版本），故即便 on 也不产生写入。
syncRoutes.get("/", (c) => {
  const auth = c.get("auth");
  return c.json({
    apiVersion: "v1",
    sync: true,
    // 阶段标识随 YN 推进刷新；客户端据此判断可用端点集。
    phase: "YN5",
    serverVersion: VERSION,
    auth: {
      userId: auth.userId,
      workspaceId: auth.workspaceId,
    },
  });
});

// ───────────────────────── YN2a：订阅 + 权限裁剪基线快照 ─────────────────────────

/** POST /subscribe {clientId, scopeType:"base", scopeId:<baseId>} → 订阅记账 + 当前游标/权限版本。 */
syncRoutes.post("/subscribe", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as
    | { clientId?: unknown; scopeType?: unknown; scopeId?: unknown }
    | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const scopeType = body?.scopeType;
  const scopeId = typeof body?.scopeId === "string" ? body.scopeId.trim() : "";
  if (!clientId || !scopeId) throw new HttpError(400, "缺少 clientId 或 scopeId", "SYNC_BAD_REQUEST");
  // YN2 只支持按 base 订阅（kb/doc 走协同轨，后续阶段）。
  if (scopeType !== "base") throw new HttpError(400, "本期仅支持 scopeType=base", "SYNC_BAD_SCOPE");

  const result = await subscribeBase(auth.userId, clientId, scopeId);
  return c.json({ result });
});

/** GET /snapshot?baseId=&clientId=&limit= → 按【当前权限】裁剪的基线快照（与在线列表同口径）。 */
syncRoutes.get("/snapshot", async (c) => {
  const auth = c.get("auth");
  const baseId = (c.req.query("baseId") ?? "").trim();
  if (!baseId) throw new HttpError(400, "缺少 baseId", "SYNC_BAD_REQUEST");
  const limitRaw = Number(c.req.query("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  // clientId 可选：带了就把该订阅标记为快照已完成（游标推进由 pull 的 after 负责）。
  const clientId = (c.req.query("clientId") ?? "").trim() || null;

  const page = await buildBaseSnapshot(auth.userId, baseId, limit ? { limit } : {});
  // clientId 可选：带了就标记快照完成（订阅尚未建立时 updateMany 命中 0 行，不影响快照成功）。
  if (clientId) await markSnapshotDone(clientId, baseId);
  return c.json({ result: page });
});

/**
 * GET /pull?baseId=&after=<seq>&clientId=&limit= → 游标增量 oplog，按【当前权限】逐条过滤。
 * after 缺省 0（未做过快照的客户端会从最早 op 拉，但通常先 snapshot 再以 snapshotSeq 为起点）。
 */
syncRoutes.get("/pull", async (c) => {
  const auth = c.get("auth");
  const baseId = (c.req.query("baseId") ?? "").trim();
  if (!baseId) throw new HttpError(400, "缺少 baseId", "SYNC_BAD_REQUEST");
  const afterRaw = (c.req.query("after") ?? "0").trim();
  if (!/^\d+$/.test(afterRaw)) throw new HttpError(400, "after 必须是非负整数", "SYNC_BAD_CURSOR");
  const after = BigInt(afterRaw);
  const limitRaw = Number(c.req.query("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 500;
  const clientId = (c.req.query("clientId") ?? "").trim() || null;

  // 当前库门裁决（enter）；pull 内部再逐表按当前 r/行/字段权限二次过滤。
  const access = await authorizeBaseRead(auth.userId, baseId);
  const page = await pullBaseOps(auth.userId, access, clientId, baseId, after, limit);
  return c.json({ result: page });
});

// ───────────────────────── YN4：push 回放 + 幂等/顺序 + 接受 ─────────────────────────

/** 单批 push 上限（超大库保护；超出客户端应拆批，§14「分批 + 写队列 + 限流」）。 */
const PUSH_MAX_OPS = 1000;

/**
 * 对本次请求【新落】的终态回执发审计（§9.5）。只认 _freshTerminal（幂等重放回执不带，不刷审计）。
 * accepted/rejected/quarantined 三态落 sync_push_*；conflict 属 YN6（sync_conflict_resolved 在用户
 * 弹窗裁决时才产生，单纯版本冲突不在 push 打点）。detail 只带标识与原因码，【绝不落字段明文】。
 */
function auditFreshTerminal(
  c: Parameters<typeof audit>[0],
  r: PushResult,
  actorId: string,
  baseId: string,
): void {
  if (!r._freshTerminal) return;
  let event: AuditEventName | null = null;
  let httpStatus = 200;
  if (r.status === "accepted") { event = "sync_push_accepted"; httpStatus = 200; }
  else if (r.status === "rejected") { event = "sync_push_rejected"; httpStatus = 403; }
  else if (r.status === "quarantined") { event = "sync_push_quarantined"; httpStatus = 200; }
  if (!event) return;
  audit(c, {
    event,
    status: httpStatus,
    actorId,
    detail: {
      baseId,
      clientOpId: r.clientOpId,
      ...(r.entityId ? { entityId: r.entityId } : {}),
      ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
    },
  });
}

/**
 * POST /push {baseId, clientId, ops:[{clientOpId,entityType,entityId,op,baseVersion,payload}]}
 *   → {results:[{clientOpId,status,reasonCode?,reasonDetail?,seq?,newVersion?,entityId?,serverVersion?}]}
 * 每条 op 独立裁决、部分接受（§8.5）；BigInt 全部序列化为字符串（与 pull 同口径）。
 */
syncRoutes.post("/push", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as
    | { baseId?: unknown; clientId?: unknown; ops?: unknown }
    | null;

  const baseId = typeof body?.baseId === "string" ? body.baseId.trim() : "";
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  if (!baseId || !clientId) throw new HttpError(400, "缺少 baseId 或 clientId", "SYNC_BAD_REQUEST");
  if (!Array.isArray(body?.ops)) throw new HttpError(400, "ops 必须是数组", "SYNC_BAD_REQUEST");
  if (body.ops.length === 0) throw new HttpError(400, "ops 不能为空", "SYNC_BAD_REQUEST");
  if (body.ops.length > PUSH_MAX_OPS) {
    throw new HttpError(400, `单批最多 ${PUSH_MAX_OPS} 条操作，请拆批`, "SYNC_BAD_REQUEST");
  }

  // 逐条结构校验（在任何 DB 访问之前）：形状不对整单 400（客户端 bug，不进幂等表）。
  const ops: IncomingOp[] = [];
  for (const raw of body.ops) {
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new HttpError(400, "op 必须是对象", "SYNC_BAD_REQUEST");
    const clientOpId = typeof o.clientOpId === "string" ? o.clientOpId.trim() : "";
    const entityType = typeof o.entityType === "string" ? o.entityType.trim() : "";
    const entityId = typeof o.entityId === "string" ? o.entityId.trim() : "";
    const op = typeof o.op === "string" ? o.op.trim() : "";
    const baseVersionRaw = typeof o.baseVersion === "string" ? o.baseVersion.trim() : "";
    if (!clientOpId || !entityType || !entityId || !op) {
      throw new HttpError(400, "op 缺少 clientOpId/entityType/entityId/op", "SYNC_BAD_REQUEST");
    }
    if (!/^\d+$/.test(baseVersionRaw)) {
      throw new HttpError(400, `op ${clientOpId} 的 baseVersion 必须是非负整数串`, "SYNC_BAD_CURSOR");
    }
    const payload = o.payload && typeof o.payload === "object" && !Array.isArray(o.payload)
      ? (o.payload as Record<string, unknown>)
      : {};
    ops.push({ clientOpId, entityType, entityId, op, baseVersion: BigInt(baseVersionRaw), payload });
  }

  const outcome = await pushBaseOps(auth.userId, clientId, baseId, ops);

  // 审计：对本批【新落】终态逐条发 sync_push_accepted/rejected/quarantined（幂等重放不刷，§9.5）。
  for (const r of outcome.results) auditFreshTerminal(c, r, auth.userId, baseId);

  // BigInt → 字符串（JSON 安全）；与 pull 输出一致，客户端统一按字符串解析版本/seq。
  const results = outcome.results.map((r) => ({
    clientOpId: r.clientOpId,
    status: r.status,
    ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
    ...(r.reasonDetail ? { reasonDetail: r.reasonDetail } : {}),
    ...(r.seq !== undefined ? { seq: r.seq.toString() } : {}),
    ...(r.newVersion !== undefined ? { newVersion: r.newVersion.toString() } : {}),
    ...(r.entityId ? { entityId: r.entityId } : {}),
    ...(r.serverVersion !== undefined ? { serverVersion: r.serverVersion.toString() } : {}),
  }));
  return c.json({ result: { baseId: outcome.baseId, results } });
});

// ───────────────── YN5：同步中心（隔离/未生效/冲突列表 + 重试 + 放弃） ─────────────────

/**
 * GET /incoming?status=&baseId=&limit= → 当前用户的待处理项（只看本人）。
 * status 缺省＝quarantined/conflict/rejected/pending_approval 四态；可逗号组合，或含 accepted/dropped。
 */
syncRoutes.get("/incoming", async (c) => {
  const auth = c.get("auth");
  const statusCsv = c.req.query("status") ?? null;
  const baseId = (c.req.query("baseId") ?? "").trim() || null;
  const limitRaw = Number(c.req.query("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  const page = await listIncoming(auth.userId, { statusCsv, baseId, limit });
  return c.json({ result: page });
});

/**
 * POST /incoming/:id/retry → 重新授权后重试一条隔离项。按【当前】权限重裁：
 * accepted（已生效）/ rejected（仍无权）/ quarantined（仍被移出）/ conflict（交 YN6 弹窗）。
 */
syncRoutes.post("/incoming/:id/retry", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const r = await retryIncoming(auth.userId, id);
  // 重试产生的是一次【新裁决】，按其新鲜终态发审计（_freshTerminal 由重放路径置位；幂等命中不刷）。
  if (r.baseId) auditFreshTerminal(c, r, auth.userId, r.baseId);
  return c.json({
    result: {
      id,
      clientOpId: r.clientOpId,
      status: r.status,
      attempts: r.attempts,
      ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
      ...(r.reasonDetail ? { reasonDetail: r.reasonDetail } : {}),
      ...(r.seq !== undefined ? { seq: r.seq.toString() } : {}),
      ...(r.newVersion !== undefined ? { newVersion: r.newVersion.toString() } : {}),
      ...(r.entityId ? { entityId: r.entityId } : {}),
      ...(r.serverVersion !== undefined ? { serverVersion: r.serverVersion.toString() } : {}),
    },
  });
});

/** POST /incoming/:id/discard {confirm:true} → 显式放弃（留痕 dropped，绝不静默丢）。 */
syncRoutes.post("/incoming/:id/discard", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
  const confirm = body?.confirm === true;
  const r = await discardIncoming(auth.userId, id, confirm);
  return c.json({ result: r });
});

// ───────────────── YN5：失权对账可见集（差集擦除在 Mac 侧车执行） ─────────────────

/**
 * GET /visibility?baseId= → 按【当前权限】收敛的可见集（逐表 readable + visibleEntityIds +
 * visibleFieldIds）+ authzVersion。服务端不算差集（不持有客户端副本状态）；侧车拿它与本地副本
 * 对比，把不再可见的 record/字段擦除；库门 403 由侧车解释为"整节点失权＝销毁加密镜像"（§9.3/§18.3）。
 */
syncRoutes.get("/visibility", async (c) => {
  const auth = c.get("auth");
  const baseId = (c.req.query("baseId") ?? "").trim();
  if (!baseId) throw new HttpError(400, "缺少 baseId", "SYNC_BAD_REQUEST");
  const report = await buildVisibilityReport(auth.userId, baseId);
  return c.json({ result: report });
});
