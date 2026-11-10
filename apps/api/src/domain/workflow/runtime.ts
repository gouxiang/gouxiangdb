// 自研工作流引擎（#1296）刀 B1：轮询 runtime 进程内单例（装配 + 生命周期 + 单写者锁 + 门控）。
//
// 与 domain/sync/replicaSyncRuntime.ts 同构，本文件只做编排，不重写执行语义（执行在 executor.ts）：
//   一轮 = 捞最多 20 条 pending run -> 逐条【条件认领】（updateMany where status=pending 且 count===1）
//          -> 认领成功者交给 executeRun 推进；他人领走/已终态的跳过。
//
// 默认关闭 / fail-closed（start 第一道闸，顺序不可换）：
//   workflowEngineEnabled() 为 false（GX_WORKFLOW_ENGINE 未开/笔误）-> start 直接返回 false：
//   不建 timer、不查库、不认领、不改既有启动姿态。刀 B1 不挂 app.ts，故生产默认完全不启动。
//
// 健壮性（同 replica runtime）：
//   - 单例 timer；inFlight 布尔防回调重入（上一轮没跑完跳过本轮 tick，不叠加）。
//   - app_settings KV 单写者锁：workerId=`${hostname}-${pid}`，每轮获取/续期，stalled=3*intervalMs，
//     他人持新鲜锁本轮整体跳过；正常 stop 主动释放，崩退靠 stalled 接管。
//   - 单条 run 执行异常只落该 run 的 failed，绝不冒泡炸宿主进程，下一轮继续处理其它 run。
//   - 所有 DB 写经 withWriteTx；回调内只用传入 tx。

import * as nodeOs from "node:os";
import { withWriteTx, type DbTx } from "../../db.js";
import { workflowEngineEnabled } from "../../configWorkflow.js";
import {
  acquireWorkflowLockTx,
  releaseWorkflowLockTx,
  renewWorkflowLockTx,
  workflowWorkerId,
} from "./workflowLock.js";
import { executeRun } from "./executor.js";

/** 轮询间隔缺省值（毫秒）。 */
export const WORKFLOW_DEFAULT_POLL_MS = 2_000;
/** 轮询间隔下限（毫秒），防止配成极小值把库打爆。 */
export const WORKFLOW_MIN_POLL_MS = 500;
/** 单轮最多认领的 run 数（有界，避免一次 tick 长占写队列）。 */
export const WORKFLOW_CLAIM_BATCH = 20;

/**
 * 纯函数：轮询间隔（毫秒）。未设置/空串/非有限正整数/小数/杂字符 -> 缺省 2000；
 * 合法值夹到最小 500。与 configReplica.parseReplicaIntervalMs 同口径。
 */
export function parseWorkflowPollMs(raw: string | undefined): number {
  const t = raw?.trim();
  if (!t) return WORKFLOW_DEFAULT_POLL_MS;
  if (!/^[+-]?\d+$/.test(t)) return WORKFLOW_DEFAULT_POLL_MS;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return WORKFLOW_DEFAULT_POLL_MS;
  return Math.max(WORKFLOW_MIN_POLL_MS, n);
}

export interface WorkflowRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  now?: () => Date;
  /** 测试注入：单条 run 的执行体（缺省用 executor.executeRun）。 */
  execute?: (runId: string) => Promise<void>;
}

interface ActiveRuntime {
  deps: WorkflowRuntimeDeps;
  workerId: string;
  intervalMs: number;
  now: () => Date;
  execute: (runId: string) => Promise<void>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let active: ActiveRuntime | null = null;
let inFlight = false;
let lastError: string | null = null;
let lastRunAt: Date | null = null;

const MAX_ERR = 500;
function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > MAX_ERR ? m.slice(0, MAX_ERR) : m;
}

/**
 * 条件认领：仅当 run 仍为 pending 时原子置 running。返回是否抢到（count===1）。
 * 两个 worker 同时 updateMany 时，SQLite 写串行 + 状态条件保证只有一个 count=1，防双领。
 */
async function claimRunTx(tx: DbTx, runId: string, now: Date): Promise<boolean> {
  const res = await tx.workflowRun.updateMany({
    where: { id: runId, status: "pending" },
    data: { status: "running", startedAt: now },
  });
  return res.count === 1;
}

/** 跑一轮（不加锁、不判 inFlight；tick 已保证单写者与防重入）。任何单 run 异常都被吞为该 run failed。 */
async function runRound(rt: ActiveRuntime): Promise<void> {
  lastError = null;
  const now = rt.now();
  // 有界捞取候选（take 20），不在此处锁行；认领靠下面的条件 updateMany 收口。
  const pending = await withWriteTx("workflow.runtime.list", (tx) =>
    tx.workflowRun.findMany({
      where: { status: "pending" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: WORKFLOW_CLAIM_BATCH,
    }));

  for (const row of pending) {
    const claimed = await withWriteTx("workflow.runtime.claim", (tx) => claimRunTx(tx, row.id, now));
    if (!claimed) continue; // 被别的 worker 领走或已非 pending：不重复执行。
    try {
      await rt.execute(row.id);
    } catch (e) {
      // executeRun 内部已对业务失败落 run.failed；这里兜底漏网异常，保证不炸进程、不卡轮次。
      lastError = errMsg(e);
    }
  }
}

/** 一次 tick：先抢/续单写者锁，再防重入跑一轮，最后续期心跳。锁不属我则整体跳过。 */
async function tick(rt: ActiveRuntime): Promise<void> {
  if (inFlight) return;
  const stalledMs = rt.intervalMs * 3;
  let locked = false;
  try {
    locked = await withWriteTx("workflow.runtime.lock", (tx) =>
      acquireWorkflowLockTx(tx, { workerId: rt.workerId, nowMs: rt.now().getTime(), stalledMs }));
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
    lastError = errMsg(e);
  } finally {
    inFlight = false;
    try {
      await withWriteTx("workflow.runtime.heartbeat", (tx) =>
        renewWorkflowLockTx(tx, { workerId: rt.workerId, nowMs: rt.now().getTime() }));
    } catch {
      // 心跳失败不致命：下轮重新 acquire；真崩退靠 stalled 被接管。
    }
  }
}

/**
 * 启动轮询引擎（进程内单例）。默认关闭：总门未开返回 false，不建 timer、不查库。
 * 已启动时幂等返回 true。
 */
export async function startWorkflowRuntime(deps: WorkflowRuntimeDeps = {}): Promise<boolean> {
  if (active) return true;
  // 首闸（顺序不可换）：总门关 -> 在任何 DB 访问之前短路。
  if (!workflowEngineEnabled(deps.env ?? process.env)) return false;

  const env = deps.env ?? process.env;
  const hostname = deps.hostname ?? (nodeOs.hostname() || "local");
  const rt: ActiveRuntime = {
    deps,
    workerId: workflowWorkerId(hostname, process.pid),
    intervalMs: parseWorkflowPollMs(env.GX_WORKFLOW_POLL_MS),
    now: deps.now ?? (() => new Date()),
    execute: deps.execute ?? ((runId) => executeRun(runId)),
  };
  active = rt;
  // 启动即跑一轮，其后按 interval 定时；首轮异常由 tick 吞掉，不影响建 timer。
  void tick(rt);
  timer = setInterval(() => {
    void tick(rt);
  }, rt.intervalMs);
  timer.unref?.(); // 不阻止进程因无其它存活句柄而退出。
  return true;
}

/** 优雅停机：清 timer、主动释放本 worker 持有的锁（best-effort），并重置跨代际遥测。 */
export async function stopWorkflowRuntime(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const rt = active;
  if (rt) {
    try {
      await withWriteTx("workflow.runtime.unlock", (tx) => releaseWorkflowLockTx(tx, rt.workerId));
    } catch {
      // best-effort：进程退出路径上库可能已关；锁会按 stalled 自行过期。
    }
  }
  active = null;
  inFlight = false;
  lastRunAt = null;
  lastError = null;
}

/** 引擎是否已启动（timer 存活）。 */
export function isWorkflowRuntimeRunning(): boolean {
  return active !== null && timer !== null;
}

/**
 * 手动触发一轮（测试 / 未来「立即运行」按钮）。仅在已启动且当前无在飞轮时执行；
 * 与定时 tick 共享同一把锁。未启动返回 false。
 */
export async function runWorkflowOnce(): Promise<boolean> {
  if (!active) return false;
  await tick(active);
  return true;
}

/** 只读运行态（供未来 status 端点/测试聚合）。 */
export function workflowRuntimeStatus(): {
  running: boolean;
  inFlight: boolean;
  lastError: string | null;
  lastRunAt: Date | null;
  workerId: string | null;
  intervalMs: number | null;
} {
  return {
    running: isWorkflowRuntimeRunning(),
    inFlight,
    lastError,
    lastRunAt,
    workerId: active?.workerId ?? null,
    intervalMs: active?.intervalMs ?? null,
  };
}
