// apps/web/src/api/localSync.ts
// 离线同步前端切片的服务端访问薄封装（beta.2 S4/S5-WEB）。
//
// 全部走 apiFetch：URL / 鉴权头由 dataSourceResolver 内部解析（壳内本地侧车或远端节点），
// 本层【不】手拼 baseFor/headers，避免与既有数据源分流分叉。
//
// 端点形态（桌面副本：浏览器同源只打【本地侧车】）：
//   GET  /api/local-sync/status                      本地侧车运行时聚合（离线也准），
//                                                    404/SYNC_DISABLED 静默收敛为 disabled。
//   GET  /api/local-sync/conflicts?status=<csv>      冲突/隔离明细（侧车代理远端，需在线）。
//   POST /api/local-sync/conflicts/:id/retry         :id＝sync_incoming 行 id（列表项 id）。
//   POST /api/local-sync/conflicts/:id/discard       body {confirm:true}。
//   POST /api/local-sync/conflicts/resolve           body {resolveOf,decision,clientOpId?,patch?}。
// 冲突/隔离操作由本地侧车用引擎配置里的 remoteToken 转发到远端 /api/v1/sync（服务端唯一裁决者，
// 客户端不重建 mine/theirs/custom 重放引擎）；返回信封透传远端 {result:{...}}，normalizer 不变。
//
// fail-closed 静默：同步服务总门关闭 / 侧车无该端点时回 404（code=SYNC_DISABLED）。
//   - getLocalSyncStatus  → 收敛为 { enabled:false }（不报错、不刷红）；
//   - listIncoming        → 空列表；
//   - 写操作 retry/discard/resolve → 返回 null（语义：本节点无同步能力，UI 已在门控后不调用）。
// 上游不通：侧车代理在远端不可达时回 502（code=SYNC_UPSTREAM_UNREACHABLE）。这【不是】disabled——
//   不置 disabledLatch、不停 status 轮询；交 UI 就地提示「无法连接远端服务器」（见 isSyncUpstreamError）。
// 其它错误（401/403/409/500/网络）照常抛出，交调用方按业务提示，绝不吞掉真实故障。

import { apiFetch, ApiError } from "./client";

/** 同步服务总门关闭 / 端点不存在：HTTP 404，且 code 为 SYNC_DISABLED（或未给 code 的裸 404，同样视为未启用）。 */
export function isSyncDisabledError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

/**
 * 侧车代理到远端但远端不可达：HTTP 502（code=SYNC_UPSTREAM_UNREACHABLE）。
 * 与 404（功能未启用）严格区分：502 是可重试的临时业务错，绝不当 disabled、不停轮询。
 */
export function isSyncUpstreamError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 502;
}

/** 上游不通时的统一就地提示文案（弹窗 / 抽屉共用）。 */
export const SYNC_UPSTREAM_UNREACHABLE_TEXT = "无法连接远端服务器，联网后处理冲突";

/** 后端非 JSON 安全数字（BigInt 串）/缺字段容错读取：数字或数字串都收敛为 number，缺失归零。 */
function asCount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v >= 0 ? Math.floor(v) : 0;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

/** ISO 时间串 / null 容错：只接受非空字符串，其余（含缺失）归 null。 */
function asTimestamp(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function asOptString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

// ──────────────────────────────── 状态聚合报告 ────────────────────────────────

/** 单个已订阅 base（库）的同步水位。 */
export interface SyncBaseStatus {
  id: string;
  name: string | null;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
}

/**
 * 本地副本同步状态报告（六态由前端 derivePhase 派生，不直接信后端 phase 文案）。
 * 字段对齐设计给定 DTO；对侧车运行时 status 的额外字段（running/inFlight/stage/nodeId…）容错吸收。
 */
export interface LocalSyncStatus {
  /** 本地副本离线功能是否启用（总闸；false 时前端不渲染任何同步 UI、不轮询）。 */
  enabled: boolean;
  pendingOutbox: number;
  conflictCount: number;
  quarantinedCount: number;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  lastError: string | null;
  bases: SyncBaseStatus[];
  /** 本地副本占用字节（同步中心只显示，不提供清理动作）。 */
  localBytesUsed: number;
  /** 引擎是否在跑 / 是否有一轮在飞（仅诊断展示，不参与六态硬派生）。 */
  running: boolean;
  inFlight: boolean;
  stage: string | null;
  nodeId: string | null;
}

/** 功能不可用时的规范空报告（404/SYNC_DISABLED 或解析失败的收敛值）。 */
export function disabledSyncStatus(): LocalSyncStatus {
  return {
    enabled: false,
    pendingOutbox: 0,
    conflictCount: 0,
    quarantinedCount: 0,
    lastPulledAt: null,
    lastPushedAt: null,
    lastError: null,
    bases: [],
    localBytesUsed: 0,
    running: false,
    inFlight: false,
    stage: null,
    nodeId: null,
  };
}

/** 宽松解析状态报告：后端多给/少给字段都不崩，缺省一律按「空/关」收敛（fail-closed）。 */
export function normalizeSyncStatus(raw: unknown): LocalSyncStatus {
  if (!raw || typeof raw !== "object") return disabledSyncStatus();
  const r = raw as Record<string, unknown>;
  // enabled 必须显式为真才视为启用；缺失/非布尔都按关闭。
  const enabled = r.enabled === true;
  if (!enabled) return disabledSyncStatus();

  const basesRaw = Array.isArray(r.bases) ? r.bases : [];
  const bases: SyncBaseStatus[] = [];
  for (const b of basesRaw) {
    if (!b || typeof b !== "object") continue;
    const bo = b as Record<string, unknown>;
    const id = asOptString(bo.id);
    if (!id) continue;
    bases.push({
      id,
      name: asOptString(bo.name),
      lastPulledAt: asTimestamp(bo.lastPulledAt),
      lastPushedAt: asTimestamp(bo.lastPushedAt),
    });
  }

  return {
    enabled: true,
    pendingOutbox: asCount(r.pendingOutbox),
    conflictCount: asCount(r.conflictCount),
    quarantinedCount: asCount(r.quarantinedCount),
    lastPulledAt: asTimestamp(r.lastPulledAt),
    lastPushedAt: asTimestamp(r.lastPushedAt),
    lastError: asOptString(r.lastError),
    bases,
    localBytesUsed: asCount(r.localBytesUsed),
    running: r.running === true,
    inFlight: r.inFlight === true,
    stage: asOptString(r.stage),
    nodeId: asOptString(r.nodeId),
  };
}

/**
 * 拉本地副本状态聚合（本地侧车运行时提供，离线也准）。侧车未启用同步 / 端点缺失（404）时静默返 disabled。
 * 透传 {signal} 供轮询在卸载/切源时中止在飞请求。
 */
export async function getLocalSyncStatus(init?: { signal?: AbortSignal }): Promise<LocalSyncStatus> {
  try {
    const raw = await apiFetch<unknown>("/api/local-sync/status", {
      method: "GET",
      cache: "no-store",
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    return normalizeSyncStatus(raw);
  } catch (e) {
    if (isSyncDisabledError(e)) return disabledSyncStatus();
    throw e;
  }
}

// ──────────────────────────────── 同步中心：隔离 / 冲突项 ────────────────────────────────

/** 一条进入同步中心的本人操作（形状对齐 apps/api IncomingItem，缺字段容错）。 */
export interface IncomingItem {
  id: string;
  clientOpId: string;
  baseId: string | null;
  entityType: string;
  entityId: string;
  op: string;
  /** 我当时提交的值（双栏左）。 */
  payload: Record<string, unknown>;
  baseVersion: string;
  status: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  serverVersion: string;
  /** conflict 项的服务端当前版本快照（双栏右）；非 conflict 为 null。 */
  conflictServerPayload: Record<string, unknown> | null;
  attempts: number;
  createdAt: string | null;
  decidedAt: string | null;
}

export interface IncomingList {
  items: IncomingItem[];
  count: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function normalizeIncomingItem(raw: unknown): IncomingItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asOptString(r.id);
  const clientOpId = asOptString(r.clientOpId);
  if (!id || !clientOpId) return null; // 两个主键都缺则无法操作，丢弃。
  return {
    id,
    clientOpId,
    baseId: asOptString(r.baseId),
    entityType: asOptString(r.entityType) ?? "",
    entityId: asOptString(r.entityId) ?? "",
    op: asOptString(r.op) ?? "",
    payload: asRecord(r.payload),
    baseVersion: asOptString(r.baseVersion) ?? "0",
    status: asOptString(r.status) ?? "received",
    reasonCode: asOptString(r.reasonCode),
    reasonDetail: asOptString(r.reasonDetail),
    serverVersion: asOptString(r.serverVersion) ?? "0",
    conflictServerPayload:
      r.conflictServerPayload && typeof r.conflictServerPayload === "object"
        ? asRecord(r.conflictServerPayload)
        : null,
    attempts: asCount(r.attempts),
    createdAt: asTimestamp(r.createdAt),
    decidedAt: asTimestamp(r.decidedAt),
  };
}

/**
 * 列出同步中心待处理项（侧车代理远端，明细需在线）。同步服务关闭（404）时静默返空列表；
 * 上游不通（502 SYNC_UPSTREAM_UNREACHABLE）照常抛出，由调用方保留旧列表只读展示、不清空。
 */
export async function listIncoming(status?: string): Promise<IncomingList> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const env = await apiFetch<unknown>(`/api/local-sync/conflicts${qs}`, {
      method: "GET",
      cache: "no-store",
    });
    // 后端统一包封 {result:{items,count}}；容错兼容裸 {items,count}。
    const page =
      env && typeof env === "object" && "result" in (env as Record<string, unknown>)
        ? (env as { result: unknown }).result
        : env;
    const po = (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
    const rawItems = Array.isArray(po.items) ? po.items : [];
    const items = rawItems
      .map(normalizeIncomingItem)
      .filter((x): x is IncomingItem => x !== null);
    return { items, count: asCount(po.count) || items.length };
  } catch (e) {
    if (isSyncDisabledError(e)) return { items: [], count: 0 };
    throw e;
  }
}

/** retry 回执（字段对齐 POST /incoming/:id/retry）。 */
export interface IncomingActionResult {
  id: string | null;
  clientOpId: string | null;
  status: string | null;
  attempts: number;
  reasonCode: string | null;
  reasonDetail: string | null;
  seq: string | null;
  newVersion: string | null;
  entityId: string | null;
  serverVersion: string | null;
}

function normalizeActionResult(raw: unknown): IncomingActionResult {
  const r =
    raw && typeof raw === "object" && "result" in (raw as Record<string, unknown>)
      ? ((raw as { result: unknown }).result ?? {})
      : raw ?? {};
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  return {
    id: asOptString(o.id),
    clientOpId: asOptString(o.clientOpId),
    status: asOptString(o.status),
    attempts: asCount(o.attempts),
    reasonCode: asOptString(o.reasonCode),
    reasonDetail: asOptString(o.reasonDetail),
    seq: asOptString(o.seq),
    newVersion: asOptString(o.newVersion),
    entityId: asOptString(o.entityId),
    serverVersion: asOptString(o.serverVersion),
  };
}

/**
 * 重试一条隔离/未生效项（按当前权限重裁）。路径参数 :id 为列表项 id（sync_incoming 行 id）。
 * 侧车代理远端，需在线；同步服务关闭（404）返 null；上游不通（502）照常抛出由 UI 就地提示。
 */
export async function retryIncoming(id: string): Promise<IncomingActionResult | null> {
  try {
    const raw = await apiFetch<unknown>(`/api/local-sync/conflicts/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return normalizeActionResult(raw);
  } catch (e) {
    if (isSyncDisabledError(e)) return null;
    throw e;
  }
}

/**
 * 显式放弃一条（留痕 dropped，绝不静默丢）。路径参数 :id 为列表项 id（sync_incoming 行 id）。
 * 同步服务关闭（404）返 null；上游不通（502）照常抛出由 UI 就地提示。
 */
export async function discardIncoming(id: string): Promise<IncomingActionResult | null> {
  try {
    const raw = await apiFetch<unknown>(`/api/local-sync/conflicts/${encodeURIComponent(id)}/discard`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    return normalizeActionResult(raw);
  } catch (e) {
    if (isSyncDisabledError(e)) return null;
    throw e;
  }
}

// ──────────────────────────────── 冲突人工解决 ────────────────────────────────

export type ResolveDecision = "mine" | "theirs" | "custom";

export interface ResolveSyncConflictInput {
  /** 要解决的冲突 clientOpId（路由字段名 resolveOf）。 */
  resolveOf: string;
  decision: ResolveDecision;
  /** 幂等用新 clientOpId（可选）。 */
  clientOpId?: string;
  /** decision="custom" 时必填的非空合并值对象。 */
  patch?: Record<string, unknown>;
}

/** resolve 回执；重放再被拒时 reasonCode 非空（原冲突行保留，可改选）。 */
export interface ResolveSyncConflictResult {
  resolveOf: string | null;
  decision: string | null;
  status: string | null;
  baseId: string | null;
  entityId: string | null;
  newClientOpId: string | null;
  seq: string | null;
  newVersion: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  serverVersion: string | null;
}

function normalizeResolveResult(raw: unknown): ResolveSyncConflictResult {
  const r =
    raw && typeof raw === "object" && "result" in (raw as Record<string, unknown>)
      ? ((raw as { result: unknown }).result ?? {})
      : raw ?? {};
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  return {
    resolveOf: asOptString(o.resolveOf),
    decision: asOptString(o.decision),
    status: asOptString(o.status),
    baseId: asOptString(o.baseId),
    entityId: asOptString(o.entityId),
    newClientOpId: asOptString(o.newClientOpId),
    seq: asOptString(o.seq),
    newVersion: asOptString(o.newVersion),
    reasonCode: asOptString(o.reasonCode),
    reasonDetail: asOptString(o.reasonDetail),
    serverVersion: asOptString(o.serverVersion),
  };
}

/**
 * 人工解决一条冲突：theirs=采用服务器值（dropped），mine=保留我的值重放，custom=给合并值重放。
 * 走侧车代理 /api/local-sync/conflicts/resolve（远端在线裁决，服务端唯一裁决者）。
 * custom 缺非空 patch 在客户端先挡（也由服务端 SYNC_RESOLVE_MALFORMED 兜底）。
 * 同步服务关闭（404）返 null；上游不通（502）/409（状态已变）照常抛出，由弹窗就地提示。
 */
export async function resolveSyncConflict(
  input: ResolveSyncConflictInput,
): Promise<ResolveSyncConflictResult | null> {
  if (input.decision === "custom") {
    if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch) || Object.keys(input.patch).length === 0) {
      // 与服务端同口径的前置校验，避免一次无意义往返。
      throw new ApiError(400, { error: "自定义解决需提供非空合并值", code: "SYNC_RESOLVE_MALFORMED" });
    }
  }
  const body: Record<string, unknown> = { resolveOf: input.resolveOf, decision: input.decision };
  if (input.clientOpId) body.clientOpId = input.clientOpId;
  if (input.decision === "custom" && input.patch) body.patch = input.patch;
  try {
    const raw = await apiFetch<unknown>("/api/local-sync/conflicts/resolve", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return normalizeResolveResult(raw);
  } catch (e) {
    if (isSyncDisabledError(e)) return null;
    throw e;
  }
}
