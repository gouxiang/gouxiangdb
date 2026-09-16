// M5/S9 手动 reindex：单实体原地幂等 + 全量/改 dim 双库原子切换（M5-implementation-plan §5.4、§4.9）。
//
// 两条路径（派工要求讲清一致性）：
//   A. 单实体重建（带 entityId）：在【现役 search.db】上走 extractEntity -> applyUpsert（内部
//      "先删该实体全部旧派生行 -> 取新 rowid -> 写 chunks/fts/field_grant -> cloud 补 vec"），
//      原地幂等；不换文件、不影响其它实体、旧库全程在线。
//   B. 全量重建（不带 entityId，或 model/dim 变更后）：写到独立
//      <search.db>.rebuild-<ts>，扫主库活实体全量灌入；灌库期间现役库持续读服务；全部成功并
//      wal_checkpoint 后，在最后一刻关闭现役单例 -> POSIX rename 原子替换主文件 ->
//      closeSearchStore() 让下次请求惰性重开新文件。任一步失败只删临时库三件，绝不碰现役库。
// 两路径共用同一 extractEntity/applyUpsert（S5 灌库真源），派生内容口径完全一致，差别仅在
// "写现役文件"还是"写临时文件后整库替换"。
//
// 锁：进程内重建互斥（better-sqlite3 同进程、worker 默认不自启）。全量/单实体都进锁；
// 第二次 POST 在重建中 -> ReindexInProgress（路由映射 409 REINDEX_IN_PROGRESS）。锁只在内存
// （单进程 admin+worker），不引分布式锁；跨进程 CLI 停机维护直跑同函数，不与在线服务并发。

import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import {
  getSearchStore, closeSearchStore, openSearchStore, deleteSearchDbFiles,
  resolveSearchDbPath, type SearchStore,
} from "./searchStore.js";
import { META_KEYS, setMeta, getMeta } from "./schema.js";
import { extractEntity, type ExtractedEntity } from "./entityExtract.js";
import { applyUpsert, deleteDerived } from "./indexerDerive.js";
import { FIELD_CHUNK_CAP } from "./chunks.js";
import { EmbeddingConfigStore } from "./embeddingConfig.js";
import { createEmbeddingProvider } from "./embedding/cloud.js";
import type { EmbeddingProvider, EmbeddingMode } from "./embedding/types.js";
import { DEFAULT_WORKSPACE } from "../authz/adapter.js";

export type ReindexEntityType = "record" | "doc" | "canvas";

export interface ReindexDeps {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  appDir: string;
  jwtSecret: string;
  workspaceId?: string;
  /** 测试注入：覆写现役 store（生产走单例）。 */
  activeStore?: SearchStore;
  /** 测试注入：覆写 search.db 物理路径（生产按 env/dataDir 解析）。 */
  searchPath?: string;
  /** 测试注入 mock cloud（不触外网）；不给则按配置构造。 */
  provider?: EmbeddingProvider | null;
  /** 测试注入：env 覆盖路径（GX_VEC_EXT_PATH）。 */
  vecExtPath?: string;
  now?: () => Date;
  /** 全量重建进度回调（每灌完一个实体；观测/测试用，可 await 以在灌库中途断言旧库仍可读）。 */
  onProgress?: (done: number, total: number) => Promise<void> | void;
}

export interface ReindexScope {
  /** 全量=省略；单实体=record|doc|canvas。 */
  type?: ReindexEntityType;
  entityId?: string;
}

export interface ReindexResult {
  scope: ReindexScope;
  mode: "single" | "full";
  entities: number;
  chunksWritten: number;
  vecWritten: number;
  vecDebt: number;
  swapped: boolean;
  activePath: string;
}

// ---- 进程内重建互斥（第二次 POST 在重建中据此 409）----
let inflight: Promise<ReindexResult> | null = null;

/** 当前重建任务（status 端点/测试等待用）；空闲为 null。 */
export function currentReindex(): Promise<ReindexResult> | null {
  return inflight;
}

export function isReindexing(): boolean {
  return inflight !== null;
}

/** 409 信号错误（路由识别 name 映射 REINDEX_IN_PROGRESS）。 */
export class ReindexInProgressError extends Error {
  constructor() {
    super("reindex already in progress");
    this.name = "ReindexInProgress";
  }
}

interface LiveEntityRef {
  entityType: ReindexEntityType;
  entityId: string;
  version: bigint;
}

/** 枚举全量活实体（确定性顺序）；不依赖事件史（§5.4 直接扫主库）。 */
async function listLiveEntities(prisma: PrismaClient): Promise<LiveEntityRef[]> {
  const out: LiveEntityRef[] = [];
  const records = await prisma.record.findMany({
    where: { deletedAt: null },
    select: { id: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  for (const r of records) {
    out.push({ entityType: "record", entityId: r.id, version: BigInt(new Date(r.updatedAt).getTime()) });
  }
  const docs = await prisma.kbDoc.findMany({
    where: { deletedAt: null },
    select: { id: true, kind: true, contentVersion: true },
    orderBy: { createdAt: "asc" },
  });
  for (const d of docs) {
    if (d.kind !== "doc" && d.kind !== "canvas") continue;
    out.push({ entityType: d.kind, entityId: d.id, version: BigInt(d.contentVersion) });
  }
  return out;
}

interface ReindexContext {
  prisma: PrismaClient;
  store: SearchStore;
  mode: EmbeddingMode;
  provider: EmbeddingProvider | null;
  cap: number;
  workspaceId: string;
  now?: () => Date;
}

/** 装配 store + 配置视图 + cloud provider（复刻 queryRuntime 的配置口径，不改冻结文件）。 */
async function buildContext(
  d: ReindexDeps,
  prisma: PrismaClient,
  store: SearchStore,
): Promise<ReindexContext> {
  const cfgStore = new EmbeddingConfigStore(prisma, d.jwtSecret);
  const view = await cfgStore.resolveView(d.env);
  let mode: EmbeddingMode = "off";
  let provider: EmbeddingProvider | null = null;
  if (d.provider !== undefined) {
    if (d.provider && d.provider.mode === "cloud") { mode = "cloud"; provider = d.provider; }
  } else if (view.mode === "cloud") {
    const apiKey = await cfgStore.getApiKey().catch(() => null);
    const candidate = createEmbeddingProvider("cloud", {
      baseURL: view.baseURL,
      apiKey: apiKey ?? d.env.GX_EMBEDDING_API_KEY?.trim() ?? "",
      model: view.model,
      batchSize: view.batchSize,
      timeoutMs: view.timeoutMs,
    });
    // createEmbeddingProvider 在配置不齐时回落 off provider；只在确为 cloud 时采用。
    if (candidate.mode === "cloud") { mode = "cloud"; provider = candidate; }
  }
  return {
    prisma, store, mode, provider,
    cap: view.fieldChunkCap || FIELD_CHUNK_CAP,
    workspaceId: d.workspaceId ?? DEFAULT_WORKSPACE,
    now: d.now,
  };
}

/** 抽一个实体当前活内容并灌入 ctx.store（删除/upsert 两态共用 applyUpsert/deleteDerived）。 */
async function pumpOne(ctx: ReindexContext, ref: LiveEntityRef) {
  const entity: ExtractedEntity = await extractEntity(ctx.prisma, ref, ctx.cap);
  if (!entity.present) {
    const removed = deleteDerived(ctx.store, ref.entityType, ref.entityId);
    return { chunks: removed, vec: 0, debt: 0 };
  }
  const s = await applyUpsert(ctx.store, entity, {
    workspaceId: ctx.workspaceId, mode: ctx.mode, provider: ctx.provider, now: ctx.now,
  });
  return { chunks: s.chunksWritten, vec: s.vecWritten, debt: s.vecDebt };
}

function resolveActivePath(d: ReindexDeps): string {
  return d.searchPath ?? resolveSearchDbPath(d.env, d.dataDir);
}

function openActive(d: ReindexDeps): SearchStore {
  if (d.activeStore) return d.activeStore;
  return getSearchStore({ filePath: resolveActivePath(d), appDir: d.appDir, vecExtPath: d.vecExtPath });
}

/** 路径 A：单实体原地幂等重建（现役库，不换文件）。 */
async function runSingle(d: ReindexDeps, type: ReindexEntityType, entityId: string): Promise<ReindexResult> {
  const active = openActive(d);
  const ctx = await buildContext(d, d.prisma, active);
  // record 版本用当前毫秒；doc/canvas 用 contentVersion（与 outbox 接线口径一致）。
  const version = type === "record"
    ? BigInt(Date.now())
    : BigInt((await d.prisma.kbDoc.findUnique({ where: { id: entityId }, select: { contentVersion: true } }))?.contentVersion ?? 0);
  const r = await pumpOne(ctx, { entityType: type, entityId, version });
  active.writeTxn("reindex-single-meta", (tx) => {
    setMeta(tx, META_KEYS.indexedAt, new Date().toISOString());
  });
  return {
    scope: { type, entityId }, mode: "single", entities: 1,
    chunksWritten: r.chunks, vecWritten: r.vec, vecDebt: r.debt,
    swapped: false, activePath: active.filePath,
  };
}

/** 路径 B：全量双库原子切换。灌库全程不碰现役文件；仅在全部成功后最后一刻替换。 */
async function runFull(d: ReindexDeps): Promise<ReindexResult> {
  const activePath = resolveActivePath(d);
  const ts = Date.now();
  const rebuildPath = `${activePath}.rebuild-${ts}`;
  deleteSearchDbFiles(rebuildPath); // 清同名崩溃残留。

  const active = openActive(d);
  // 临时库沿用现役库的 vec 加载态/来源，保证新库 vec0 可用性与现役一致。
  const rebuild = openSearchStore({
    filePath: rebuildPath,
    appDir: d.appDir,
    vecExtPath: d.vecExtPath,
    tryLoadVec: active.vecAvailable,
  });
  rebuild.writeTxn("rebuild-start-meta", (tx) => {
    setMeta(tx, META_KEYS.rebuilding, "1");
    setMeta(tx, META_KEYS.activeDb, "rebuild");
  });

  let entities = 0;
  let chunksWritten = 0;
  let vecWritten = 0;
  let vecDebt = 0;
  let closedActive = false;
  try {
    const ctx = await buildContext(d, d.prisma, rebuild);
    const refs = await listLiveEntities(d.prisma);
    for (const ref of refs) {
      const r = await pumpOne(ctx, ref);
      entities += 1;
      chunksWritten += r.chunks;
      vecWritten += r.vec;
      vecDebt += r.debt;
      await d.onProgress?.(entities, refs.length);
    }
    // 灌完：合并 WAL 到主文件（持久化），再盖完成元数据并二次 checkpoint。
    rebuild.db.pragma("wal_checkpoint(TRUNCATE)");
    rebuild.writeTxn("rebuild-finish-meta", (tx) => {
      setMeta(tx, META_KEYS.rebuilding, "0");
      setMeta(tx, META_KEYS.activeDb, "active");
      setMeta(tx, META_KEYS.indexedAt, new Date().toISOString());
    });
    rebuild.db.pragma("wal_checkpoint(TRUNCATE)");
    rebuild.close();

    // 原子切换：最后一刻关闭现役单例（此刻只读连接瞬断），POSIX rename 替换主文件。
    if (d.activeStore) active.close();
    else closeSearchStore();
    closedActive = true;
    // 旧 wal/shm 在 close 前已随连接释放；显式清残留，避免与新主文件 salt 不匹配的脏帧。
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.rmSync(activePath + suffix, { force: true }); } catch { /* ignore */ }
    }
    fs.renameSync(rebuildPath, activePath);
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.rmSync(rebuildPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    // 失败：关临时连接并清临时库三件；若现役已关（极端：rename 失败），立即惰性重开旧路径，不致停服。
    try { rebuild.close(); } catch { /* already closed */ }
    deleteSearchDbFiles(rebuildPath);
    if (closedActive && !d.activeStore) {
      // activePath 仍是旧文件（rename 未发生/失败）；重开现役单例继续服务。
      openActive(d);
    }
    throw new Error(
      `full reindex failed, active index untouched: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return {
    scope: {}, mode: "full", entities, chunksWritten, vecWritten, vecDebt,
    swapped: true, activePath,
  };
}

/**
 * 启动一次 reindex（异步；路由立即 202）。进行中再调抛 ReindexInProgressError（路由 409）。
 * 单实体走原地；其余走双库切换。
 */
export function startReindex(d: ReindexDeps, scope: ReindexScope = {}): Promise<ReindexResult> {
  // 同步抛出（非 Promise.reject），确保调用方 try/catch 立即得到 409，而非 unhandled rejection。
  if (inflight) throw new ReindexInProgressError();
  const task = (scope.entityId
    ? runSingle(d, scope.type ?? "record", scope.entityId)
    : runFull(d)
  ).finally(() => { inflight = null; });
  inflight = task;
  return task;
}

/** status 端点读现役库 rebuilding 元数据（in-flight 之外的跨进程可见位）。 */
export function metaRebuilding(store: SearchStore): boolean {
  return getMeta(store.db, META_KEYS.rebuilding) === "1";
}
