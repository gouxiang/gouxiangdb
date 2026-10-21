// beta.2 S3-runtime：把三套已就绪的 once 内核（pull / push / reconcile）装配成进程内【定时同步引擎】。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md（离线优先双向同步）。
//
// 本文件只做【编排 + 生命周期 + 单写者锁 + 门控】，不重写任何 once 内核语义：
//   一轮顺序：取本地 owner → 拉远端可见 base 列表 → pullReplicaOnce → pushOutboxOnce
//             （成功桶回写 lastPushedAt/subscribed）→ 对本地已订阅 base 逐 base reconcileVisibilityOnce。
//
// 默认关闭 / fail-closed（start 第一道闸，顺序不可换）：
//   replicaSyncConfig() 返回 null（GX_OFFLINE_REPLICA 未开，或 GX_REPLICA_REMOTE_URL 缺省/trim 空）
//   → start 直接返回 false：不建 timer、不建任何传输（不发网络）、不查库、不改既有启动姿态。
//
// 健壮性：
//   - 单例 timer；inFlight 布尔防回调重入（上一轮没跑完则跳过本轮 tick，不叠加）。
//   - app_settings KV 单写者锁：workerId=`${hostname}-${pid}`，每轮获取/续期心跳，stalled=3*intervalMs，
//     他人持新鲜锁则本轮整体跳过；正常 stop 主动释放，崩退靠 stalled 接管。
//   - 每个阶段独立 try/catch：传输错被 once 内核收进 summary.transportError（不抛），其它异常记入
//     lastError 不冒泡——绝不让同步故障炸掉宿主进程；下一轮自动重试。
//   - 所有 DB 写经 withWriteTx；回调内只用传入 tx。

import * as nodeOs from "node:os";
import { withWriteTx } from "../../db.js";
import { replicaSyncConfig, type ReplicaSyncConfig } from "../../configReplica.js";
import { offlineNodeId, offlineClientId } from "../../configOfflineReplica.js";
import { createFetchPullTransport, type ReplicaPullTransport } from "./replicaPullTransport.js";
import {
  createFetchPushTransport,
  ReplicaTransportError,
  type ReplicaPushTransport,
} from "./replicaPushTransport.js";
import {
  createFetchVisibilityTransport,
  type ReplicaVisibilityTransport,
} from "./replicaVisibilityTransport.js";
import { pullReplicaOnce } from "./replicaPull.js";
import { pushOutboxOnce } from "./replicaPush.js";
import { reconcileVisibilityOnce } from "./replicaReconcile.js";
import {
  listSubscribedBasesTx,
  findEarliestOwnerUserIdTx,
  markBasePushedTx,
} from "./replicaSyncState.js";
import {
  acquireReplicaLockTx,
  renewReplicaLockTx,
  releaseReplicaLockTx,
  replicaWorkerId,
} from "./replicaSyncLock.js";

export type ReplicaStage = "idle" | "list" | "pull" | "push" | "reconcile";

export interface ReplicaRuntimeDeps {
  /** 直接注入配置（测试）；缺省由 env 现场解析。 */
  config?: ReplicaSyncConfig | null;
  env?: NodeJS.ProcessEnv;
  /** 注入假传输（测试）；缺省用 createFetch* 工厂打 remoteUrl。 */
  pullTransport?: ReplicaPullTransport;
  pushTransport?: ReplicaPushTransport;
  visibilityTransport?: ReplicaVisibilityTransport;
  /** 拉远端可见 base id 列表（测试注入）；缺省 GET {remoteUrl}/api/bases/。 */
  listRemoteBaseIds?: () => Promise<string[]>;
  hostname?: string;
  now?: () => Date;
}

interface ActiveRuntime {
  cfg: ReplicaSyncConfig;
  deps: ReplicaRuntimeDeps;
  pull: ReplicaPullTransport;
  push: ReplicaPushTransport;
  visibility: ReplicaVisibilityTransport;
  workerId: string;
  listRemoteBaseIds: () => Promise<string[]>;
  now: () => Date;
}

let timer: ReturnType<typeof setInterval> | null = null;
let active: ActiveRuntime | null = null;
let inFlight = false;
let stage: ReplicaStage = "idle";
let lastError: string | null = null;
let lastRunAt: Date | null = null;

const MAX_ERR = 500;
function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > MAX_ERR ? m.slice(0, MAX_ERR) : m;
}

/** 默认远端 base 列表：GET /api/bases/ → {bases:[{id}]}（X-GX-Token 鉴权，错误归一为 ReplicaTransportError）。 */
function makeRemoteBaseLister(cfg: ReplicaSyncConfig): () => Promise<string[]> {
  const base = cfg.remoteUrl.replace(/\/+$/, "");
  return async () => {
    let res: Response;
    try {
      res = await fetch(`${base}/api/bases/`, {
        method: "GET",
        headers: { "X-GX-Token": cfg.remoteToken, "content-type": "application/json" },
      });
    } catch (e) {
      throw new ReplicaTransportError(`base 列表网络错误: ${errMsg(e)}`);
    }
    if (!res.ok) throw new ReplicaTransportError(`base 列表被拒绝: HTTP ${res.status}`, res.status);
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ReplicaTransportError(`base 列表回执不是合法 JSON: ${errMsg(e)}`, res.status);
    }
    const arr = (json as { bases?: unknown } | null)?.bases;
    if (!Array.isArray(arr)) throw new ReplicaTransportError("base 列表回执缺少 bases 数组", res.status);
    return arr
      .map((b) => (b && typeof b === "object" ? (b as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  };
}

/** 跑一轮（不加锁、不判 inFlight；调用方/tick 已保证单写者与防重入）。任何异常都被吞为 lastError。 */
async function runRound(rt: ActiveRuntime): Promise<void> {
  const nodeId = offlineNodeId(rt.deps.env);
  const clientId = offlineClientId(rt.deps.env);
  const now = rt.now();
  lastError = null;

  // ① 本地最早 ACTIVE role_owner 作为下行回放属主；缺失则本轮不拉不推（绝不匿名落数据）。
  stage = "list";
  const ownerUserId = await withWriteTx("replica.runtime.owner", (tx) =>
    findEarliestOwnerUserIdTx(tx));
  if (!ownerUserId) {
    lastError = "本地无 ACTIVE role_owner 用户，无法确定副本属主";
    return;
  }

  // ② 远端可见 base 列表（网络）。失败则本轮无法 pull/reconcile，但 push 仍可尝试（独立 try）。
  let remoteBaseIds: string[] = [];
  try {
    remoteBaseIds = await rt.listRemoteBaseIds();
  } catch (e) {
    lastError = errMsg(e);
  }

  // ③ 下行（列表为空时内核逐 base 循环零次；owner 仍有效）。
  if (remoteBaseIds.length > 0) {
    stage = "pull";
    try {
      const s = await pullReplicaOnce({
        transport: rt.pull, ownerUserId, baseIds: remoteBaseIds, nodeId, clientId,
      });
      if (s.transportError) lastError = "pull 传输错误（已保留已提交游标，下轮续拉）";
    } catch (e) {
      lastError = errMsg(e);
    }
  }

  // ④ 上行：本地 outbox 与远端列表无关，即便列表拉取失败也照推；成功桶回写 lastPushedAt/subscribed。
  stage = "push";
  try {
    const s = await pushOutboxOnce({ transport: rt.push, nodeId, clientId });
    if (s.transportError) lastError = "push 传输错误（本批已回 pending，下轮重发）";
    // 仅对【成功 settle 的 base 桶】回写；失败桶 sent=0 不入此列，避免谎报推送时间。
    const pushedBaseIds = s.buckets
      .filter((b) => b.kind === "base" && b.sent > 0)
      .map((b) => b.baseId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const remoteBaseId of pushedBaseIds) {
      await withWriteTx("replica.runtime.markPushed", (tx) =>
        markBasePushedTx(tx, { nodeId, remoteBaseId, now }));
    }
  } catch (e) {
    lastError = errMsg(e);
  }

  // ⑤ 失权对账：只对账本地确实下行过的副本（replica_state 有行），不对纯本地 base 发无意义请求。
  stage = "reconcile";
  const localBases = await withWriteTx("replica.runtime.listBases", (tx) =>
    listSubscribedBasesTx(tx, nodeId));
  if (localBases.length > 0) {
    try {
      const s = await reconcileVisibilityOnce({
        transport: rt.visibility,
        baseIds: localBases.map((b) => b.localBaseId),
        nodeId,
        actorUserId: ownerUserId,
        now,
      });
      if (s.transportError) lastError = "reconcile visibility 传输错误（下轮重试）";
    } catch (e) {
      lastError = errMsg(e);
    }
  }

  stage = "idle";
}

/** 一次 tick：抢/续单写者锁 → 防重入跑一轮 → 续期心跳。锁不属我则整体跳过。 */
async function tick(rt: ActiveRuntime): Promise<void> {
  if (inFlight) return; // 上一轮仍在跑：不叠加并发轮。
  const stalledMs = rt.cfg.intervalMs * 3;
  let locked = false;
  try {
    locked = await withWriteTx("replica.runtime.lock", (tx) =>
      acquireReplicaLockTx(tx, { workerId: rt.workerId, nowMs: rt.now().getTime(), stalledMs }));
  } catch (e) {
    lastError = errMsg(e);
    return;
  }
  if (!locked) return;

  inFlight = true;
  try {
    await runRound(rt);
    lastRunAt = rt.now();
  } catch (e) {
    // 双保险：runRound 内部已分阶段吞错，此处确保任何漏网异常也不炸进程/不卡 inFlight。
    lastError = errMsg(e);
  } finally {
    inFlight = false;
    try {
      await withWriteTx("replica.runtime.heartbeat", (tx) =>
        renewReplicaLockTx(tx, { workerId: rt.workerId, nowMs: rt.now().getTime() }));
    } catch {
      // 心跳失败不致命：下轮重新 acquire；真崩退靠 stalled 被接管。
    }
  }
}

/**
 * 启动定时同步引擎（进程内单例）。默认关闭：配置不齐全返回 false，不建 timer、不发网络/DB。
 * 已启动时幂等返回 true。
 */
export async function startReplicaSync(deps: ReplicaRuntimeDeps = {}): Promise<boolean> {
  if (active) return true;
  const cfg = deps.config !== undefined ? deps.config : replicaSyncConfig(deps.env ?? process.env);
  if (!cfg) return false; // fail-closed：GX_OFFLINE_REPLICA 未开 或 未配远端 URL。

  const hostname = deps.hostname ?? (nodeOs.hostname() || "local");
  const rt: ActiveRuntime = {
    cfg,
    deps,
    workerId: replicaWorkerId(hostname, process.pid),
    pull: deps.pullTransport ?? createFetchPullTransport({ baseUrl: cfg.remoteUrl, token: cfg.remoteToken }),
    push: deps.pushTransport ?? createFetchPushTransport({ baseUrl: cfg.remoteUrl, token: cfg.remoteToken }),
    visibility: deps.visibilityTransport
      ?? createFetchVisibilityTransport({ baseUrl: cfg.remoteUrl, token: cfg.remoteToken }),
    listRemoteBaseIds: deps.listRemoteBaseIds ?? makeRemoteBaseLister(cfg),
    now: deps.now ?? (() => new Date()),
  };
  active = rt;
  // 启动即跑一轮（尽快首次同步），其后按 interval 定时；首轮异常由 tick 吞掉，不影响建 timer。
  void tick(rt);
  timer = setInterval(() => {
    void tick(rt);
  }, cfg.intervalMs);
  // 不阻止进程因无其它存活句柄而退出（与 sidecar/CLI 共存）。
  timer.unref?.();
  return true;
}

/** 优雅停机：清 timer、主动释放本 worker 持有的锁（best-effort）。 */
export async function stopReplicaSync(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const rt = active;
  if (rt) {
    try {
      await withWriteTx("replica.runtime.unlock", (tx) => releaseReplicaLockTx(tx, rt.workerId));
    } catch {
      // best-effort：进程退出路径上库可能已关；锁会按 stalled 自行过期。
    }
  }
  active = null;
  inFlight = false;
  stage = "idle";
  // 同步清空跨代际遥测：否则 stop 后 lastRunAt 仍保留上一代时间戳，下一代 start 的首轮尚未
  // 结束时，调用方仅凭「lastRunAt 非空 && !inFlight」会把陈旧时间误判为本轮已完成（竞态）。
  lastRunAt = null;
  lastError = null;
}

/** 引擎是否已启动（timer 存活）。 */
export function isReplicaSyncRunning(): boolean {
  return active !== null && timer !== null;
}

/**
 * 手动触发一轮（测试 / 未来「立即同步」按钮）。仅在已启动且当前无在飞轮时执行；
 * 与定时 tick 共享同一把锁（此处复用 tick 的抢锁/防重入逻辑）。未启动返回 false。
 */
export async function runReplicaSyncOnce(): Promise<boolean> {
  if (!active) return false;
  await tick(active);
  return true;
}

/** 只读运行态（供 /api/local-sync status 端点聚合）。 */
export function replicaSyncRuntimeStatus(): {
  running: boolean;
  inFlight: boolean;
  stage: ReplicaStage;
  nodeId: string;
  clientId: string;
  lastError: string | null;
  lastRunAt: Date | null;
  workerId: string | null;
  intervalMs: number | null;
} {
  return {
    running: isReplicaSyncRunning(),
    inFlight,
    stage,
    nodeId: active ? offlineNodeId(active.deps.env) : offlineNodeId(),
    clientId: active ? offlineClientId(active.deps.env) : offlineClientId(),
    lastError,
    lastRunAt,
    workerId: active?.workerId ?? null,
    intervalMs: active?.cfg.intervalMs ?? null,
  };
}
