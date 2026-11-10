// 自研工作流引擎（#1296）刀 B1：轮询引擎的【单写者锁】（app_settings KV，短事务原语）。
//
// 与 domain/sync/replicaSyncLock.ts 同构（照抄范式，仅改锁键与命名），不另造锁口径：
// 同一个本地库可能被多个 API/侧车进程同时打开，两个进程同时轮询 workflow_runs 会重复认领、
// 重复执行动作节点。用 app_settings 一行 KV 当互斥量：持有者周期写心跳（毫秒时间戳），
// 崩退不释放时，锁在 stalledMs（=3 个轮询间隔，由 runtime 计算传入）后被视为过期可接管；
// 正常 stop 主动删锁，下个进程立即可接管（不等 stalled）。
//
// 锁值复用 search/indexerSchedule 的通用约定 `${workerId}:${heartbeatMs}`
// （workerId=`${hostname}-${pid}`），用同一套 formatLockValue/lockOwnedBy/
// parseLockHeartbeat/isLockStale。
//
// 纪律：只做极短读-判-写（单个 withWriteTx 事务体内调用），不发网络、不跑执行器内核。

import type { DbTx } from "../../db.js";
import { formatLockValue, isLockStale, lockOwnedBy, parseLockHeartbeat } from "../search/indexerSchedule.js";

/** app_settings 中工作流运行时锁行的键。 */
export const WORKFLOW_RUNTIME_LOCK_KEY = "workflow.runtime.worker.lock";

/** 同机多实例可区分来源：主机名 + pid（与 replica/search worker 同款意图）。 */
export function workflowWorkerId(hostname: string, pid: number): string {
  return `${hostname}-${pid}`;
}

/**
 * 纯函数：当前锁状态下，workerId 是否可以（重入）获取/接管锁。可表驱动单测、零 IO。
 *   - 无锁 / 空串：可取；
 *   - 锁本就属于本 worker：可取（幂等重入、心跳续期）；
 *   - 他人持锁且心跳过期：可接管；
 *   - 他人持锁且心跳新鲜：不可抢；
 *   - 他人持锁但锁值无法解析：保守不抢（不是我们认识的格式，避免误杀外部约定）。
 */
export function canAcquireWorkflowLock(
  current: string | null | undefined,
  workerId: string,
  nowMs: number,
  stalledMs: number,
): boolean {
  if (!current) return true;
  if (lockOwnedBy(current, workerId)) return true;
  const hb = parseLockHeartbeat(current);
  if (hb === null) return false;
  return isLockStale(hb, nowMs, stalledMs);
}

async function readLockValueTx(tx: DbTx): Promise<string | null> {
  const row = await tx.appSetting.findUnique({ where: { k: WORKFLOW_RUNTIME_LOCK_KEY }, select: { v: true } });
  return row?.v ?? null;
}

/**
 * 尝试获取/接管锁（事务内读-判-写）。成功返回 true（并已写入本 worker 心跳）；
 * 他人锁新鲜返回 false，不做任何写。
 */
export async function acquireWorkflowLockTx(
  tx: DbTx,
  args: { workerId: string; nowMs: number; stalledMs: number },
): Promise<boolean> {
  const current = await readLockValueTx(tx);
  if (!canAcquireWorkflowLock(current, args.workerId, args.nowMs, args.stalledMs)) return false;
  await tx.appSetting.upsert({
    where: { k: WORKFLOW_RUNTIME_LOCK_KEY },
    create: { k: WORKFLOW_RUNTIME_LOCK_KEY, v: formatLockValue(args.workerId, args.nowMs) },
    update: { v: formatLockValue(args.workerId, args.nowMs) },
  });
  return true;
}

/** 心跳续期：仅当锁确实属于本 worker 时刷新时间戳；失去锁（被接管）返回 false。 */
export async function renewWorkflowLockTx(
  tx: DbTx,
  args: { workerId: string; nowMs: number },
): Promise<boolean> {
  const current = await readLockValueTx(tx);
  if (!lockOwnedBy(current ?? undefined, args.workerId)) return false;
  await tx.appSetting.update({
    where: { k: WORKFLOW_RUNTIME_LOCK_KEY },
    data: { v: formatLockValue(args.workerId, args.nowMs) },
  });
  return true;
}

/** 主动交还锁：仅删除属于本 worker 的锁行；不属于我（已被接管）绝不动它。 */
export async function releaseWorkflowLockTx(tx: DbTx, workerId: string): Promise<void> {
  const current = await readLockValueTx(tx);
  if (current !== null && lockOwnedBy(current, workerId)) {
    await tx.appSetting.deleteMany({ where: { k: WORKFLOW_RUNTIME_LOCK_KEY } });
  }
}
