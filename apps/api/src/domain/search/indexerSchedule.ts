// M5/S5 indexer 纯函数层：退避序列、终态判定、worker 锁与 stalled 回收决策（零 IO）。
//
// 权威依据：M5-implementation-plan §5.3（worker 状态机与退避）。
// 本文件不 import db/prisma/net，只放可表驱动单测的纯逻辑；认领 SQL、锁写入在 indexer.ts。
//
// 状态机：
//   pending/failed --claim--> processing
//   processing --处理成功--> done(processedAt)
//   processing --处理失败--> failed(nextRunAt=now+backoff)；attempts 达上限 --> dead
//   processing 且锁过期（进程崩溃）--> reclaimStalled 重置回 pending 等待重新认领。

/** 退避台阶（毫秒）：10s / 1m / 10m / 1h；超出台阶后停在 1h，直到 MAX_ATTEMPTS 转 dead。 */
export const BACKOFF_STEPS_MS = [10_000, 60_000, 600_000, 3_600_000] as const;

/** 最大尝试次数（含首次）：达到后失败转 dead，不再重试（§5.3 attempts>=8）。 */
export const MAX_ATTEMPTS = 8;

/** processing 锁默认过期时间（毫秒）：超过视为持有者崩溃，可被回收。 */
export const DEFAULT_STALLED_MS = 15 * 60_000;

/**
 * 第 attempts 次失败后的退避延迟（attempts 从 1 起，=认领时已自增后的 attempts 值）：
 * 1->10s, 2->1m, 3->10m, >=4->1h。非正整数防御性返回首档。
 */
export function backoffDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) return BACKOFF_STEPS_MS[0];
  const idx = Math.min(attempts - 1, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[idx];
}

/** 计算下次可运行时间戳（毫秒）；now 可注入测试。 */
export function nextRunAtMs(nowMs: number, attempts: number): number {
  return nowMs + backoffDelayMs(attempts);
}

/** 该 attempts 值失败后是否应进入终态 dead（不再有 worker 认领）。 */
export function shouldMarkDead(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

export interface FailureDecision {
  status: "failed" | "dead";
  /** 下次可运行的毫秒时间戳；dead 时仍给出（列里非空），但 worker 不认领 dead。 */
  nextRunAtMs: number;
}

/** 一次处理失败后的状态决策（纯函数，便于钉死退避表）。 */
export function decideFailure(nowMs: number, attempts: number): FailureDecision {
  return {
    status: shouldMarkDead(attempts) ? "dead" : "failed",
    nextRunAtMs: nextRunAtMs(nowMs, attempts),
  };
}

/**
 * worker 锁是否已过期（可回收）。
 * @param lockMs   index_meta.worker_lock 存的上次心跳/认领毫秒时间戳；0/缺省视为无主
 * @param nowMs    当前毫秒
 * @param stalledMs 过期阈值
 */
export function isLockStale(lockMs: number, nowMs: number, stalledMs: number = DEFAULT_STALLED_MS): boolean {
  if (!Number.isFinite(lockMs) || lockMs <= 0) return true;
  return nowMs - lockMs >= stalledMs;
}

/**
 * 我（workerId）是否持有当前锁：锁值等于本 worker id 即视为持有者（单写者）。
 * 锁的具体取值约定为 `${workerId}:${heartbeatMs}`，解析前缀比较；纯字符串不兼容格式不属我。
 */
export function lockOwnedBy(lockValue: string | undefined, workerId: string): boolean {
  if (!lockValue) return false;
  return lockValue === workerId || lockValue.startsWith(`${workerId}:`);
}

/** 组装锁值：workerId + 心跳毫秒（供 isLockStale 判过期、lockOwnedBy 判归属）。 */
export function formatLockValue(workerId: string, heartbeatMs: number): string {
  return `${workerId}:${heartbeatMs}`;
}

/** 从锁值解析心跳毫秒；无法解析返回 null。 */
export function parseLockHeartbeat(lockValue: string | undefined): number | null {
  if (!lockValue) return null;
  const parts = lockValue.split(":");
  const ts = Number(parts[parts.length - 1]);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}
