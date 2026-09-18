// M5 内嵌索引 worker 的生产接线点（M7 门③ R6 坐实的缺陷修复：此前全仓生产代码零处
// `new SearchIndexer`，change_events 只进不出、search.db 仅在管理员手动全量 reindex 才更新）。
//
// 职责边界：本模块只做【装配 + 生命周期 + 门控】，业务语义全在 indexer.ts（认领状态机/退避/
// stall 回收/单写者锁）与 reindexPump.ts（配置视图装配）；此处不复制任何一份口径。
//
// 门控（出厂默认必须零副作用，顺序不可换）：
//   1. GX_M5_SEARCH !== "on"（默认 off）-> 直接返回 false：不建 search.db、不开连接、不查主库。
//   2. GX_SEARCH_WORKER === "off"（排障/回滚面 R6）-> 同样 false。
//   仅当两者都放行才继续（门控读不到配置就不可能碰到 store/prisma）。
//
// 与 reindex 的互斥（为什么必须 suspend/resume）：全量重建写独立 <search.db>.rebuild-<ts>，
// 灌完 rename 原子替换主文件并 closeSearchStore()。工人若仍持旧文件的裸连接，会写到已被
// unlink 的旧库 -> 索引分叉（现役库缺增量、旧文件无人读）。故重建期间挂起工人；恢复时
// 【重新取一次单例】（而不是复用旧句柄），使换过文件后工人自动指向新现役库。

import { SearchIndexer } from "./indexer.js";
import { META_KEYS, getMeta, setMeta } from "./schema.js";
import { lockOwnedBy } from "./indexerSchedule.js";
import { getSearchStore, resolveSearchDbPath, type SearchStore } from "./searchStore.js";
import { buildContext } from "./reindexPump.js";
import type { EmbeddingMode, EmbeddingProvider } from "./embedding/types.js";
import type { ReindexDeps } from "./reindexTypes.js";
import { parseM5SearchFlag, parseSearchWorkerFlag, type M5SearchFlag } from "../../configM5Search.js";

export interface SearchWorkerDeps extends ReindexDeps {
  /**
   * M5 总门（GX_M5_SEARCH 启动期解析态）。生产由 index.ts 传 config.m5Search（与其它 flag
   * 一致的"启动期冻结"纪律）；省略则按 deps.env 现场解析（测试/CLI 直接驱动 env）。
   */
  m5Search?: M5SearchFlag;
  /** 同上的 worker 排障开关（GX_SEARCH_WORKER）。 */
  searchWorker?: boolean;
}

/** 门控真源：总门 on 且排障开关未显式 off。配 configM5Search 的两个 parser，无第三套读法。 */
export function searchWorkerAllowed(d: SearchWorkerDeps): boolean {
  const m5Search = d.m5Search ?? parseM5SearchFlag(d.env.GX_M5_SEARCH);
  const worker = d.searchWorker ?? parseSearchWorkerFlag(d.env.GX_SEARCH_WORKER);
  return m5Search === "on" && worker;
}

/** worker 持有的、与 search.db 相关的全部运行态（恢复时据此重建 indexer）。 */
interface WorkerState {
  deps: SearchWorkerDeps;
  store: SearchStore;
  mode: EmbeddingMode;
  provider: EmbeddingProvider | null;
  cap: number;
  workspaceId: string;
  workerId: string;
}

let state: WorkerState | null = null;
let indexer: SearchIndexer | null = null;
let suspended = false;

/** 派生库路径/ext 覆盖口径与 queryRuntime.resolveStore 一致（GX_SEARCH_DB_PATH > dataDir）。 */
function resolveStore(d: SearchWorkerDeps): SearchStore {
  const filePath = d.searchPath ?? resolveSearchDbPath(d.env, d.dataDir);
  const vecExtPath = d.vecExtPath ?? (d.env.GX_VEC_EXT_PATH?.trim() || undefined);
  return getSearchStore({ filePath, appDir: d.appDir, ...(vecExtPath ? { vecExtPath } : {}) });
}

/** workerId 带 pid：同机多实例/滚动重启时 stalled 回收与单写者锁可区分来源。 */
function workerIdOf(): string {
  return `api-${process.pid}`;
}

function spawn(s: WorkerState): SearchIndexer {
  return new SearchIndexer({
    prisma: s.deps.prisma,
    store: s.store,
    mode: s.mode,
    provider: s.provider,
    workerId: s.workerId,
    fieldChunkCap: s.cap,
    workspaceId: s.workspaceId,
  });
}

/**
 * 交还单写者锁（仅当锁确实属于本实例）。
 * 为什么必须做：锁里存的是上次心跳毫秒，进程【正常退出】不会让心跳变旧——下次启动看到的
 * 是"新鲜但持有者已死"的锁，按 indexer.ts 既有语义只能等到 DEFAULT_STALLED_MS（15min）
 * 过期才敢接管，等于每次重启后最长 15min 无人消化 outbox。停机时主动交还即可立刻接管。
 * 崩溃退出仍走 stalled 回收（那条路径不动）。
 */
function releaseLock(s: WorkerState): void {
  try {
    if (lockOwnedBy(getMeta(s.store.db, META_KEYS.workerLock), s.workerId)) {
      setMeta(s.store.db, META_KEYS.workerLock, "");
    }
  } catch {
    // 库可能已被 reindex 换文件并关闭；best-effort，锁会按 stalled 自行过期。
  }
}

/**
 * 启动进程内单例 worker。已被门控挡下 / 已有活 worker 持锁 / 装配失败：返回 false 且不留状态
 * （装配失败只记日志，绝不让检索读路径随启动崩掉）。已启动时幂等返回 true。
 */
export async function startSearchWorker(d: SearchWorkerDeps): Promise<boolean> {
  if (!searchWorkerAllowed(d)) return false;
  if (state) return true;
  try {
    const store = resolveStore(d);
    const ctx = await buildContext(d, d.prisma, store);
    state = {
      deps: d,
      store,
      mode: ctx.mode,
      provider: ctx.provider,
      cap: ctx.cap,
      workspaceId: ctx.workspaceId,
      workerId: workerIdOf(),
    };
    const started = spawn(state);
    if (!started.start()) {
      // 单写者锁新鲜且属他人：本实例退出，不抢（indexer.ts 既有语义，不在此改）。
      console.warn("[search-worker] 另一活 worker 持锁，本实例不起 worker");
      state = null;
      return false;
    }
    indexer = started;
    console.log(
      `[search-worker] started pid=${process.pid} mode=${ctx.mode} vec=${store.vecAvailable} db=${store.filePath}`,
    );
    return true;
  } catch (err) {
    // 建库/装配失败（含损坏库 SearchStoreCorruptError）：不阻断服务，留待人工 reindex/自愈。
    state = null;
    indexer = null;
    console.error(
      "[search-worker] 启动失败（检索读路径不受影响）：",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** 优雅停机：停止认领循环并交还单写者锁（见 releaseLock）。不动 singleton 连接。 */
export function stopSearchWorker(): void {
  if (indexer) indexer.stop();
  if (state) releaseLock(state);
  indexer = null;
  state = null;
  suspended = false;
}

/** worker 是否正在跑（未启动 / 已停 / 被 reindex 挂起 均为 false）。 */
export function isSearchWorkerRunning(): boolean {
  return indexer !== null && indexer.isRunning;
}

/**
 * reindex 开始前挂起工人。**幂等**：重复调用只保证"停着"。
 * 工人从未启动（出厂默认 / GX_SEARCH_WORKER=off / 独立 CLI 进程）时是纯 no-op，返回 false
 * ——reindex 测试与 CLI 都走这条路径，不能因缺 deps 抛错。
 */
export function suspendSearchWorker(): boolean {
  if (!indexer || !state) return false;
  suspended = true;
  indexer.stop();
  return true;
}

/**
 * reindex 结束（finally）恢复工人。**幂等**且未挂起时 no-op。
 * 关键：重新取单例 store——全量重建 rename 替换过文件的话，这里拿到的是新现役库，
 * 绝不让工人续写已被 unlink 的旧句柄（索引分叉）。恢复失败只记日志，不向 reindex 抛。
 */
export function resumeSearchWorker(): boolean {
  if (!state) return false;
  if (!suspended) return false;
  suspended = false;
  try {
    // 先落 state.store 再 spawn：全量重建换过文件时这里拿到的是新现役库，
    // 绝不能让工人（以及任何读 state.store 的观测点）继续指向被 unlink 的旧句柄。
    state = { ...state, store: resolveStore(state.deps) };
    const next = spawn(state);
    if (!next.start()) {
      console.warn("[search-worker] resume 时另一活 worker 持锁，保持挂起");
      return false;
    }
    indexer = next;
    return true;
  } catch (err) {
    console.error(
      "[search-worker] resume 失败（工人保持停止，可人工 reindex 后重启服务）：",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** 只读：当前 worker 实例（测试 runOnce / 运维观测用）；未启动为 null。 */
export function currentSearchWorker(): SearchIndexer | null {
  return indexer;
}

/** 只读：worker 当前持有的派生库（reindex 换文件后应与 getSearchStore() 同一实例）。 */
export function currentWorkerStore(): SearchStore | null {
  return state?.store ?? null;
}

