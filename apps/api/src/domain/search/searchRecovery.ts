// M5/S12 search.db 损坏自愈编排（ADR-0049 / §4.9「rename .corrupt-<ts> 隔离 -> 重建空库 ->
// 自动播种；当次检索回主库 LIKE 应急」）。
//
// 时序（在一次检索请求内，检测到现役库物理损坏后）：
//   1) 关闭进程内现役单例连接（释放文件锁/WAL 帧）；
//   2) quarantineCorruptFiles 把主库/-wal/-shm 三件 rename 成 .corrupt-<ts>（不删，留证）；
//   3) 立即重开一个【空、已自举 schema】的新库并成为进程单例——当次请求由 emergencyLike 顶；
//   4) 后台 fire-and-forget 复用 reindex.repopulateActiveStore 把全部活实体重播进新库
//      （不另写抽取；cloud embed 失败按既有 vecDebt 欠账，FTS 先恢复）。
// 主应用 records/kb 写全程不依赖 search.db（outbox 只写主库），故损坏/重播不阻塞业务写。
//
// 幂等/并发：进程内一把恢复锁。两个并发请求同时撞到损坏，只有第一个执行隔离+重开，
// 第二个 await 同一 promise 后直接复用新单例，绝不会把刚重建的好库再隔离一次。

import {
  getSearchStore,
  closeSearchStore,
  type OpenSearchOptions,
  type SearchStore,
} from "./searchStore.js";
import { quarantineCorruptFiles, isCorruptionError } from "./searchCorruption.js";
import type { ReindexDeps } from "./reindex.js";

export interface RecoveryResult {
  /** 重开后的新鲜空库（已是进程单例）。 */
  store: SearchStore;
  /** 隔离物路径（.corrupt-<ts> 主库），供测试/日志断言三件留存。 */
  quarantinedPath: string;
  /** 实际搬走的文件（主库 + 存在的 wal/shm）。 */
  moved: string[];
}

let recoveryInFlight: Promise<RecoveryResult> | null = null;

/** 仅供测试复位恢复锁。 */
export function resetRecoveryLock(): void {
  recoveryInFlight = null;
}

export function isRecovering(): boolean {
  return recoveryInFlight !== null;
}

/**
 * 隔离损坏现役库并重开空库（串行化；并发调用复用同一次恢复）。
 * 调用方应先确认错误确属损坏（isCorruptionError）；缺文件不属于本路径。
 */
export function recoverCorruptSearchStore(
  filePath: string,
  openOpts: Omit<OpenSearchOptions, "filePath">,
): Promise<RecoveryResult> {
  if (recoveryInFlight) return recoveryInFlight;
  // 注意赋值时序：IIFE 主体是同步工作（无 await），其内部 finally 会在【赋值之前】同步执行，
  // 故绝不能在 IIFE 内清锁（否则锁永久卡在已 resolve 的 promise 上，第二次损坏复用陈旧结果、
  // 不再隔离/重开）。先拿到 promise 赋值，再用 .finally 在落定后按引用清锁。
  const task = (async (): Promise<RecoveryResult> => {
    // 1) 释放现役连接（与 reindex 双库切换同一纪律），让 rename 可靠。
    closeSearchStore();
    // 2) 三件隔离（不删；存在的 sidecar 一起搬）。
    const q = quarantineCorruptFiles(filePath);
    // 3) 重开空库并成为单例；openSearchStore 对新文件走正常懒初始化（非损坏）。
    const store = getSearchStore({ ...openOpts, filePath });
    return { store, quarantinedPath: q.quarantinedPath, moved: q.moved };
  })();
  recoveryInFlight = task;
  // 恢复锁在"隔离+重开"落定后即释放；后台重播不占该锁（新库已可正常服役）。
  task.finally(() => {
    if (recoveryInFlight === task) recoveryInFlight = null;
  });
  return task;
}

/** 判定一次检索链异常是否是 search.db 物理损坏（供路由决定是否走自愈）。 */
export function looksLikeCorruption(err: unknown): boolean {
  return isCorruptionError(err);
}

/** 后台重播任务（可观测/测试确定性收口）；空闲为 null。与 reindex inflight 锁互不相关。 */
let repopulationInFlight: Promise<RepopulateSummary> | null = null;

/** 当前后台重播任务（status/测试等待用）；空闲为 null。 */
export function currentRepopulation(): Promise<RepopulateSummary> | null {
  return repopulationInFlight;
}

/**
 * 现役库是否处于「已重建空库、后台重播未完成」窗口。该窗口内派生召回为空（或不全），
 * 路由必须继续走主库应急 LIKE 并标 search_store_recovering，避免对用户静默返回半空结果。
 * 纯内存布尔读，健康路径零 IO 零开销。
 */
export function isRepopulating(): boolean {
  return repopulationInFlight !== null;
}

export interface RepopulateSummary {
  entities: number; chunksWritten: number; vecWritten: number; vecDebt: number;
}

/**
 * 后台把全部活实体重播进刚重建的空库（fire-and-forget）。失败只告警不抛出，
 * 下一次人工/定时 reindex 仍可补齐。并发去重：重播在飞时复用同一 promise，
 * 不会对同一新库并发双写。
 */
export function repopulateRecoveredStore(d: ReindexDeps): Promise<RepopulateSummary> {
  if (repopulationInFlight) return repopulationInFlight;
  // 动态 import 规避潜在循环（reindex 也 import searchStore）。
  const task = import("./reindex.js")
    .then((m) => m.repopulateActiveStore(d))
    .catch((err: unknown): RepopulateSummary => {
      console.error("[search-recovery] 后台重播失败，可手动 reindex 补齐：",
        err instanceof Error ? err.message : String(err));
      return { entities: 0, chunksWritten: 0, vecWritten: 0, vecDebt: 0 };
    })
    .finally(() => { repopulationInFlight = null; });
  repopulationInFlight = task;
  return task;
}
