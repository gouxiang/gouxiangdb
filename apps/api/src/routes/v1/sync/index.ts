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
// visibility 失权对账可见集 + 审计；YN6 接入冲突双版本快照 + 人工 resolve（mine/theirs/custom）+
// sync_conflict_resolved 审计。未落地的路径不在此预注册，以免客户端把"还没做"误当成"已支持"。

import { Hono } from "hono";
import { syncServerEnabled } from "../../../configSync.js";
import { HttpError } from "../../../httpError.js";
import { requireActiveUser } from "../../../middleware/authActive.js";
import { VERSION } from "../../../version.js";
import { audit } from "../../../audit/emit.js";
import type { AuditEventName } from "../../../audit/audit.js";
import { buildBaseSnapshot, markSnapshotDone, subscribeBase, subscribeTree, authorizeBaseRead } from "../../../domain/sync/snapshot.js";
import { pullBaseOps, pullTreeOps } from "../../../domain/sync/pull.js";
import { pushBaseOps, pushTreeOps, retryIncoming, resolveConflict, type IncomingOp, type PushResult } from "../../../domain/sync/push.js";
import { listIncoming, discardIncoming } from "../../../domain/sync/incoming.js";
import { buildVisibilityReport } from "../../../domain/sync/visibility.js";
import {
  gateClientProtocol,
  SYNC_PROTOCOL_VERSION,
  SYNC_PROTOCOL_MIN_VERSION,
  SYNC_PROTOCOL_MAX_VERSION,
  SYNC_CAPABILITIES,
} from "../../../domain/sync/protocol.js";

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
    phase: "YN8",
    serverVersion: VERSION,
    // S0 协议握手：探针只读宣告协议协商窗口与能力（additive，旧键全部保留）。
    // 读端点不做协议门；客户端据此在写之前判断是否需要升级自己或服务端（脑裂防护）。
    protocolVersion: SYNC_PROTOCOL_VERSION,
    minProtocolVersion: SYNC_PROTOCOL_MIN_VERSION,
    maxProtocolVersion: SYNC_PROTOCOL_MAX_VERSION,
    capabilities: [...SYNC_CAPABILITIES],
    auth: {
      userId: auth.userId,
      workspaceId: auth.workspaceId,
    },
  });
});

// ───────────────────────── YN2a：订阅 + 权限裁剪基线快照 ─────────────────────────

/**
 * POST /subscribe {clientId, scopeType, scopeId} → 订阅记账 + 当前游标/权限版本。
 *   - scopeType="base"           scopeId=<baseId>：库订阅，过当前库门，回 cursorSeq/authzVersion（YN2）。
 *   - scopeType="workspace_tree" scopeId="ws_default"：工作区导航树订阅（YN8），跨库、不过 base 库门，
 *                                另回当前 treeVersion；写树仍由 /push/tree 按 manage_menu 裁决。
 */
syncRoutes.post("/subscribe", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as
    | { clientId?: unknown; scopeType?: unknown; scopeId?: unknown }
    | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const scopeType = body?.scopeType;
  const scopeId = typeof body?.scopeId === "string" ? body.scopeId.trim() : "";
  if (!clientId || !scopeId) throw new HttpError(400, "缺少 clientId 或 scopeId", "SYNC_BAD_REQUEST");

  // YN8：工作区导航树订阅（本期单工作区，仅收 ws_default）。
  if (scopeType === "workspace_tree") {
    if (scopeId !== "ws_default") {
      throw new HttpError(400, "workspace_tree 订阅的 scopeId 必须是 ws_default", "SYNC_BAD_SCOPE");
    }
    const result = await subscribeTree(auth.userId, clientId, scopeId);
    return c.json({ result });
  }

  // YN2 base 订阅。
  if (scopeType !== "base") throw new HttpError(400, "scopeType 仅支持 base 或 workspace_tree", "SYNC_BAD_SCOPE");
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

/**
 * GET /pull/tree?after=<seq>&clientId=&limit= → 工作区导航树（navnode）游标增量。
 * 读操作：登录成员即可（同步总门 + requireActiveUser），不过 base 库门、不做记录裁剪；
 * 回当前 treeVersion。after 缺省 0；clientId 可选，带了就推进 workspace_tree 订阅游标。
 */
syncRoutes.get("/pull/tree", async (c) => {
  const afterRaw = (c.req.query("after") ?? "0").trim();
  if (!/^\d+$/.test(afterRaw)) throw new HttpError(400, "after 必须是非负整数", "SYNC_BAD_CURSOR");
  const after = BigInt(afterRaw);
  const limitRaw = Number(c.req.query("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 500;
  const clientId = (c.req.query("clientId") ?? "").trim() || null;

  const page = await pullTreeOps(clientId, after, limit);
  return c.json({ result: page });
});

// ───────────────────────── YN4：push 回放 + 幂等/顺序 + 接受 ─────────────────────────

/** 单批 push 上限（超大库保护；超出客户端应拆批，§14「分批 + 写队列 + 限流」）。 */
const PUSH_MAX_OPS = 1000;

/**
 * S0 写端点协议门（脑裂防护）：在 body 已解析、但遍历 ops 与【任何 DB 访问之前】裁决。
 * 三种不通过情形都抛 HttpError(400, message, code)；此处绝不落任何 sync_incoming/op_log。
 * 缺省（旧客户端不带 protocolVersion）由 gateClientProtocol 按 v1 放行（additive）。
 */
function enforceProtocolGate(body: { protocolVersion?: unknown } | null): void {
  const result = gateClientProtocol(body?.protocolVersion);
  if (!result.ok) throw new HttpError(400, result.message, result.code);
}

/**
 * 对本次请求【新落】的终态回执发审计（§9.5）。只认 _freshTerminal（幂等重放回执不带，不刷审计）。
 * accepted/rejected/quarantined 三态落 sync_push_*；conflict 属 YN6（sync_conflict_resolved 在用户
 * 弹窗裁决时才产生，单纯版本冲突不在 push 打点）。detail 只带标识与原因码，【绝不落字段明文】。
 */
function auditFreshTerminal(
  c: Parameters<typeof audit>[0],
  r: PushResult,
  actorId: string,
  baseId: string | null,
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
    | { baseId?: unknown; clientId?: unknown; ops?: unknown; protocolVersion?: unknown }
    | null;

  // S0 协议门 fail-closed：在形状校验/遍历 ops/任何 DB 访问之前；旧客户端缺省字段放行。
  enforceProtocolGate(body);

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
    // §19.2 additive：仅 record op 可带 baseSchemaVersion（结构版本依赖门）。缺省=null → 旧客户端
    // 不启用门（默认零行为变化）；非数字串整单 400（客户端 bug，不进幂等表）。
    let baseSchemaVersion: bigint | null = null;
    if (o.baseSchemaVersion !== undefined && o.baseSchemaVersion !== null) {
      const raw = typeof o.baseSchemaVersion === "string" ? o.baseSchemaVersion.trim() : "";
      if (!/^\d+$/.test(raw)) {
        throw new HttpError(400, `op ${clientOpId} 的 baseSchemaVersion 必须是非负整数串`, "SYNC_BAD_CURSOR");
      }
      baseSchemaVersion = BigInt(raw);
    }
    ops.push({
      clientOpId, entityType, entityId, op, baseVersion: BigInt(baseVersionRaw),
      ...(baseSchemaVersion !== null ? { baseSchemaVersion } : {}), payload,
    });
  }

  const outcome = await pushBaseOps(auth.userId, clientId, baseId, ops);

  // 审计：对本批【新落】终态逐条发 sync_push_accepted/rejected/quarantined（幂等重放不刷，§9.5）。
  for (const r of outcome.results) auditFreshTerminal(c, r, auth.userId, baseId);

  // BigInt → 字符串（JSON 安全）；与 pull 输出一致，客户端统一按字符串解析版本/seq。
  const results = outcome.results.map(serializeResult);
  return c.json({ result: { baseId: outcome.baseId, results } });
});

// ───────────────────────── YN8：工作区导航树 push（navnode，不属任何 base） ─────────────────────────

/**
 * POST /push/tree {clientId, ops:[navnode…]} → {results:[…]}
 * 树 op 的 baseVersion 复用为工作区 treeVersion（客户端离线时所基于的树版本）；sync_incoming/oplog 的
 * baseId 恒 null。信封形状/单批上限/逐条校验与 /push 一致；不接收 baseId/baseSchemaVersion。
 */
syncRoutes.post("/push/tree", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as
    | { clientId?: unknown; ops?: unknown; protocolVersion?: unknown }
    | null;

  // S0 协议门 fail-closed：与 /push 同位（解析 body 后、遍历 ops/任何 DB 之前）。
  enforceProtocolGate(body);

  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) throw new HttpError(400, "缺少 clientId", "SYNC_BAD_REQUEST");
  if (!Array.isArray(body?.ops)) throw new HttpError(400, "ops 必须是数组", "SYNC_BAD_REQUEST");
  if (body.ops.length === 0) throw new HttpError(400, "ops 不能为空", "SYNC_BAD_REQUEST");
  if (body.ops.length > PUSH_MAX_OPS) {
    throw new HttpError(400, `单批最多 ${PUSH_MAX_OPS} 条操作，请拆批`, "SYNC_BAD_REQUEST");
  }

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
      throw new HttpError(400, `op ${clientOpId} 的 baseVersion(treeVersion) 必须是非负整数串`, "SYNC_BAD_CURSOR");
    }
    const payload = o.payload && typeof o.payload === "object" && !Array.isArray(o.payload)
      ? (o.payload as Record<string, unknown>)
      : {};
    ops.push({ clientOpId, entityType, entityId, op, baseVersion: BigInt(baseVersionRaw), payload });
  }

  const outcome = await pushTreeOps(auth.userId, clientId, ops);
  // 树 op 无 baseId 归属，审计 detail 的 baseId 字段落 null（审计 schema 允许可空）。
  for (const r of outcome.results) auditFreshTerminal(c, r, auth.userId, null as unknown as string);
  return c.json({ result: { scope: "workspace_tree", results: outcome.results.map(serializeResult) } });
});

/** push 回执 BigInt → 字符串（/push 与 /push/tree 共用）。 */
function serializeResult(r: PushResult): Record<string, unknown> {
  return {
    clientOpId: r.clientOpId,
    status: r.status,
    ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
    ...(r.reasonDetail ? { reasonDetail: r.reasonDetail } : {}),
    ...(r.seq !== undefined ? { seq: r.seq.toString() } : {}),
    ...(r.newVersion !== undefined ? { newVersion: r.newVersion.toString() } : {}),
    ...(r.entityId ? { entityId: r.entityId } : {}),
    ...(r.serverVersion !== undefined ? { serverVersion: r.serverVersion.toString() } : {}),
  };
}

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

// ───────────────── YN6：冲突人工解决（mine/theirs/custom，双版本弹窗） ─────────────────

/**
 * POST /resolve {resolveOf:<冲突 clientOpId>, decision:"mine"|"theirs"|"custom", clientOpId?, patch?}
 *   → {result:{resolveOf, decision, status, newClientOpId?, seq?, newVersion?, entityId, baseId}}
 * 冲突不静默：服务端只按用户显式选择重放（§7.2）。mine/custom 成功（accepted）或 theirs（dropped）
 * 都发 sync_conflict_resolved 审计；若重放因当前权限/版本再次未接受，原冲突行保留、不发 resolved
 * 审计，把新终态（rejected/conflict/quarantined）如实回给客户端改选。BigInt 序列化为字符串。
 */
syncRoutes.post("/resolve", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => null)) as {
    resolveOf?: unknown; decision?: unknown; clientOpId?: unknown; patch?: unknown;
    // #788-D 结构冲突 compound（steps 数组）；数据依赖冲突 replayData（布尔）。
    compound?: unknown; replayData?: unknown;
  } | null;
  const resolveOf = typeof body?.resolveOf === "string" ? body.resolveOf.trim() : "";
  if (!resolveOf) throw new HttpError(400, "缺少 resolveOf（要解决的冲突 clientOpId）", "SYNC_BAD_REQUEST");
  const decision = body?.decision;
  if (
    decision !== "mine" && decision !== "theirs" && decision !== "custom"
    && decision !== "compound" && decision !== "replayData"
  ) {
    throw new HttpError(400, "decision 必须是 mine/theirs/custom/compound/replayData", "SYNC_RESOLVE_BAD_DECISION");
  }
  const clientOpId = typeof body?.clientOpId === "string" ? body.clientOpId.trim() : undefined;
  // custom 必须带非空 patch 对象；mine/theirs 忽略 patch（theirs 本就不重放）。
  let patch: Record<string, unknown> | undefined;
  if (decision === "custom") {
    const rawPatch = body?.patch;
    if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
      throw new HttpError(400, "custom 解决需提供 patch 对象", "SYNC_RESOLVE_MALFORMED");
    }
    patch = rawPatch as Record<string, unknown>;
  }
  // #788-D compound：透传 {steps:[…]}，逐步形状由领域 parseCompoundStep 严格校验（路由不深校验）。
  let compound: { steps: Array<{ entityType: string; entityId: string; op: string; payload: Record<string, unknown> }> } | undefined;
  if (decision === "compound") {
    const cObj = body?.compound;
    if (!cObj || typeof cObj !== "object" || Array.isArray(cObj)) {
      throw new HttpError(400, "compound 解决需提供 {steps:[…]}", "SYNC_RESOLVE_STEPS_MALFORMED");
    }
    const steps = (cObj as { steps?: unknown }).steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new HttpError(400, "compound 解决的 steps 必须是非空数组", "SYNC_RESOLVE_STEPS_MALFORMED");
    }
    compound = cObj as { steps: Array<{ entityType: string; entityId: string; op: string; payload: Record<string, unknown> }> };
  }
  const replayData = decision === "replayData" ? body?.replayData !== false : undefined;

  const r = await resolveConflict(auth.userId, { resolveOf, decision, clientOpId, patch, compound, replayData });

  // 仅在冲突【本次被真正解决】（theirs→dropped，或 mine/custom 重放 accepted）时打点；
  // 幂等回读（_idempotent，重发同一 resolveOf）或重放再被拒/再冲突都不发 resolved 审计。
  const settled = !r._idempotent
    && (r.status === "accepted" || (r.decision === "theirs" && r.status === "dropped"));
  if (settled) {
    audit(c, {
      event: "sync_conflict_resolved",
      status: 200,
      actorId: auth.userId,
      detail: {
        baseId: r.baseId,
        resolveOf: r.resolveOf,
        decision: r.decision,
        entityId: r.entityId,
        ...(r.newClientOpId ? { clientOpId: r.newClientOpId } : {}),
      },
    });
  }

  return c.json({
    result: {
      resolveOf: r.resolveOf,
      decision: r.decision,
      status: r.status,
      baseId: r.baseId,
      entityId: r.entityId,
      ...(r.newClientOpId ? { newClientOpId: r.newClientOpId } : {}),
      ...(r.seq !== undefined ? { seq: r.seq.toString() } : {}),
      ...(r.newVersion !== undefined ? { newVersion: r.newVersion.toString() } : {}),
      // 重放未接受时把新终态原因带回（原冲突行保留，客户端可改选 theirs/稍后重试）。
      ...(r.replay && r.status !== "accepted"
        ? {
            reasonCode: r.replay.reasonCode,
            ...(r.replay.reasonDetail ? { reasonDetail: r.replay.reasonDetail } : {}),
            ...(r.replay.serverVersion !== undefined
              ? { serverVersion: r.replay.serverVersion.toString() }
              : {}),
          }
        : {}),
    },
  });
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
