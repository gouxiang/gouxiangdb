// apps/api/src/configReplica.ts
// 「定时离线副本同步引擎」（侧车进程内 pull/push/reconcile 编排器）的配置解析纯函数。
// 与 configSync.ts / configOfflineReplica.ts 同范式：纯函数、无 db/Hono/定时器副作用，
// 调用时读 env（非启动期冻结快照），可表驱动单测、可进程内切换。
//
// 与既有两个开关的分工：
//   - GX_OFFLINE_REPLICA（configOfflineReplica）：本地直写是否登记 local_outbox 的【捕获】总门。
//   - GX_REPLICA_REMOTE_URL（本文件）：是否启动【定时同步引擎】与远端通信。引擎还要求
//     GX_OFFLINE_REPLICA=on（三套 once 内核首行都以 offlineReplicaEnabled() 守门），二者缺一不跑。
//
// 语义（**默认关闭，fail-closed**）：
//   未设置 GX_REPLICA_REMOTE_URL / trim 后为空串 = 引擎不启动（不建 timer、不发任何网络/DB）。
//   只有显式给出非空远端 base URL 时才允许启动；启动判定集中在 replicaSyncConfig()，
//   其余 parser 只负责把单个 env 值解析成规整类型，便于表驱动单测。

import { offlineReplicaEnabled } from "./configOfflineReplica.js";

/** 定时间隔缺省值（毫秒）：30s。 */
export const REPLICA_DEFAULT_INTERVAL_MS = 30_000;
/** 定时间隔下限（毫秒）：5s，防止配置成极小值把远端打爆。上限不夹。 */
export const REPLICA_MIN_INTERVAL_MS = 5_000;

/**
 * 纯函数：远端 base URL。trim 后返回；空串归一为 null（表示未配置 → 引擎不启动）。
 * 不在此校验 http(s) 前缀——交给 fetch 在真正发请求时报错并落 lastError，避免 parser 过度臆测。
 */
export function parseReplicaRemoteUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

/** 纯函数：远端访问令牌（X-GX-Token）。trim 后返回；允许为空（本机/无鉴权远端时）。 */
export function parseReplicaRemoteToken(raw: string | undefined): string {
  return raw?.trim() ?? "";
}

/**
 * 纯函数：定时间隔（毫秒）。
 *   未设置 / 空串 / 非有限正整数（NaN、Infinity、<=0、小数、带杂字符）→ 缺省 30000；
 *   解析出的合法值夹到最小 5000（更小按 5000 计）；最大不夹。
 */
export function parseReplicaIntervalMs(raw: string | undefined): number {
  const t = raw?.trim();
  if (!t) return REPLICA_DEFAULT_INTERVAL_MS;
  // 仅接受「完整的十进制整数」：可选正负号 + 一至多位数字，不许小数/科学计数/杂字符。
  if (!/^[+-]?\d+$/.test(t)) return REPLICA_DEFAULT_INTERVAL_MS;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return REPLICA_DEFAULT_INTERVAL_MS;
  return Math.max(REPLICA_MIN_INTERVAL_MS, n);
}

/** 引擎启动所需的规整配置。 */
export interface ReplicaSyncConfig {
  /** 远端 base URL（非空才可能启动）。 */
  remoteUrl: string;
  /** 远端访问令牌（可为空串）。 */
  remoteToken: string;
  /** 定时间隔毫秒（已夹下限）。 */
  intervalMs: number;
}

/**
 * 运行时读 env，解析定时同步引擎配置。
 * @param requireReplicaFlag 是否要求 GX_OFFLINE_REPLICA=on（默认 true，与 once 内核守门一致）。
 * @returns 配置齐全返回 ReplicaSyncConfig；URL 缺失（或捕获总门未开）返回 null → 调用方不启动。
 */
export function replicaSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
  requireReplicaFlag = true,
): ReplicaSyncConfig | null {
  if (requireReplicaFlag && !offlineReplicaEnabled(env)) return null;
  const remoteUrl = parseReplicaRemoteUrl(env.GX_REPLICA_REMOTE_URL);
  if (!remoteUrl) return null;
  return {
    remoteUrl,
    remoteToken: parseReplicaRemoteToken(env.GX_REPLICA_REMOTE_TOKEN),
    intervalMs: parseReplicaIntervalMs(env.GX_OFFLINE_SYNC_INTERVAL_MS),
  };
}
