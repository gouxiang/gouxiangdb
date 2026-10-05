// M5/S2 SearchStore：独立物理 search.db（裸 better-sqlite3；不 ATTACH、不经 Prisma）。
//
// 权威依据：M5-implementation-plan §4.1/§4.2、§0.2 H1/H4/H5/H8/H10、§4.9 降级矩阵。
//   - search.db 是可整文件删除重建的派生产物：与 Prisma 主库文件独立、连接独立、
//     vec0 只加载在本连接；不进 prisma/migrations、不进业务备份（H5、§5.1）。
//   - vec0 加载失败可捕获 -> vecAvailable=false，SearchStore 照常打开并以 fts-only 服役（H8）。
//   - 写事务 helper 内建 db.transaction(fn)() 立即调用并以 label 命名，防 H10「漏 () 静默不执行」。
//   - rowid 三处对齐（chunks/fts/vec）由单写者在写事务内用 index_meta.next_rowid 取号（§4.2-1）。
//
// 默认 off / 惰性：本模块 import 不产生任何连接或文件；只有显式 openSearchStore() 或
// getSearchStore() 首调（GX_M5_SEARCH on，S6 才接线）才建库。当前 S2 不被 index.ts 引用，
// 故 GX_M5_SEARCH 未设时对主应用启动与既有测试零影响。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  bootstrapBaseSchema,
  createVecChunks,
  setMeta,
  META_KEYS,
  vecChunksExists,
  type SchemaDb,
} from "./schema.js";
import {
  loadVec0,
  readVecVersion,
  describeVecPlatform,
  classifyVecExtKind,
  type VecPlatform,
  type VecExtKind,
} from "./vecLoader.js";
import { isCorruptionError, SearchStoreCorruptError } from "./searchCorruption.js";

/** search.db 文件名（可被 GX_SEARCH_DB_PATH 整路径覆盖）。 */
const SEARCH_DB_FILENAME = "search.db";
/** 写连接 busy_timeout 与主库口径一致 5000ms。 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenSearchOptions {
  /** search.db 绝对文件路径（独立文件；不与主库同路径、不 ATTACH）。 */
  filePath: string;
  /** GX_VEC_EXT_PATH 显式覆盖（可选）。 */
  vecExtPath?: string;
  /** 发布包应用目录（解析 native/<triplet>/vec0.<ext> 用）。 */
  appDir: string;
  /** 是否尝试加载 vec0，默认 true；false 强制 fts-only（测试/档位关闭）。 */
  tryLoadVec?: boolean;
  /** 注入平台描述（测试用）。 */
  platformInfo?: VecPlatform;
  busyTimeoutMs?: number;
}

export interface SearchStore {
  /** 底层裸连接（仅本域内使用；外部禁止跨库 ATTACH）。 */
  readonly db: Database.Database;
  readonly filePath: string;
  /** vec0 是否可用；false 时不建/不查 vec_chunks（fts-only 降级，H8）。 */
  readonly vecAvailable: boolean;
  readonly vecPath: string | null;
  /** vec0 扩展来源三分类（§9 status：env-override/builtin/platform）。 */
  readonly vecExtKind: VecExtKind;
  readonly vecVersion: string | null;
  readonly vecError: string | null;

  /** H10：命名写事务，helper 内部立即执行 db.transaction(fn)()，返回 fn 结果。 */
  writeTxn<T>(label: string, fn: (tx: Database.Database) => T): T;

  /**
   * vec0 可用且维度首定时建 vec_chunks（幂等）。返回是否已建；
   * vecAvailable=false 时直接 false（不抛），调用方走纯 FTS。
   */
  ensureVecChunks(dim: number): boolean;

  /** 在【写事务内】分配下一个全局 rowid（bigint，三处对齐），基于 index_meta.next_rowid。 */
  allocateRowId(tx: SchemaDb): bigint;

  /** 清空全部派生死数据并在同文件重建基础 schema（保留文件与 vec0 加载态）。 */
  truncate(): void;
  close(): void;
}

/** 派生内容表（truncate 时按序删除；fts/vec 影子表随虚表一并消失）。 */
const DERIVED_TABLES = ["field_grant", "vec_chunks", "fts_chunks", "chunks"] as const;

/**
 * 打开/创建独立 search.db 并自举基础 schema。任何 vec0 失败都降级而非抛出（H8）。
 * 目录不存在则创建（search.db 落可写数据目录）。
 */
export function openSearchStore(opts: OpenSearchOptions): SearchStore {
  const platformInfo = opts.platformInfo ?? describeVecPlatform();
  const tryLoadVec = opts.tryLoadVec !== false;
  fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });

  const db = new Database(opts.filePath, { timeout: opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
  try {
    db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    // 派生库单写者 + 后续只读 KNN 连接；WAL 降低读写互斥（独立文件，不影响主库）。
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF"); // 派生库无外键，显式关闭避免误触发。
  } catch (err) {
    // 损坏文件在首个 PRAGMA（读写 page/header）即可能抛 NOTADB/CORRUPT：先关连接再翻译。
    if (isCorruptionError(err)) {
      try { db.close(); } catch { /* 已不可用 */ }
      throw new SearchStoreCorruptError(opts.filePath, err);
    }
    throw err;
  }

  // 来源类别独立于是否尝试加载（off/tryLoadVec=false 也报候选来源面）。
  const vecExtKind = classifyVecExtKind(opts.vecExtPath, opts.appDir, platformInfo);

  let vecAvailable = false;
  let vecPath: string | null = null;
  let vecVersion: string | null = null;
  let vecError: string | null = null;
  if (tryLoadVec) {
    const r = loadVec0(db, { envPath: opts.vecExtPath, appDir: opts.appDir, platformInfo });
    vecAvailable = r.vecAvailable;
    vecPath = r.path;
    vecError = r.error;
    if (vecAvailable) vecVersion = readVecVersion(db);
    if (!vecAvailable) console.warn(`[search] vec0 不可用，降级 fts-only：${vecError ?? "unknown"}`);
  } else {
    vecError = "vec load disabled by option";
  }

  try {
    bootstrapBaseSchema(db);
    setMeta(db, META_KEYS.vecLoaded, vecAvailable ? "1" : "0");
    if (vecVersion) setMeta(db, META_KEYS.vecVersion, vecVersion);
  } catch (err) {
    // 损坏文件常在读 sqlite_master（CREATE IF NOT EXISTS/setMeta）时抛 NOTADB/CORRUPT。
    if (isCorruptionError(err)) {
      try { db.close(); } catch { /* 已不可用 */ }
      throw new SearchStoreCorruptError(opts.filePath, err);
    }
    throw err;
  }

  const store: SearchStore = {
    db,
    filePath: opts.filePath,
    vecAvailable,
    vecPath,
    vecExtKind,
    vecVersion,
    vecError,

    writeTxn<T>(label: string, fn: (tx: Database.Database) => T): T {
      // H10：db.transaction(fn) 返回的是事务函数，必须在此立即调用——封装内固定执行，
      // label 仅用于错误定位，杜绝调用方拿到函数却忘记调用导致「静默不执行」。
      // better-sqlite3 不会自动把 db 作为入参注入，需显式传入（事务内即为该事务连接）。
      const runner = db.transaction((tx: Database.Database) => fn(tx));
      try {
        return runner(db);
      } catch (err) {
        throw new Error(`search write txn '${label}' failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err });
      }
    },

    ensureVecChunks(dim: number): boolean {
      if (!vecAvailable) return false;
      if (vecChunksExists(db)) return true;
      createVecChunks(db, dim);
      return true;
    },

    allocateRowId(tx: SchemaDb): bigint {
      // UPSERT 自增后 RETURNING 取号；单写者 + 写事务内调用，无竞争（§4.2-1）。
      const row = tx
        .prepare(
          `INSERT INTO index_meta(k, v) VALUES(?, '1')
           ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
           RETURNING v`,
        )
        .get(META_KEYS.nextRowid) as { v: string };
      return BigInt(row.v);
    },

    truncate(): void {
      const reapply = () => {
        for (const t of DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
        db.exec("DELETE FROM index_meta");
        bootstrapBaseSchema(db);
        setMeta(db, META_KEYS.vecLoaded, vecAvailable ? "1" : "0");
        if (vecVersion) setMeta(db, META_KEYS.vecVersion, vecVersion);
      };
      // 与普通写一致走命名事务，保证「删派生表 + 重建自举」原子。
      const runner = db.transaction(reapply);
      runner();
    },

    close(): void {
      db.close();
    },
  };

  return store;
}

/** 同库相关的所有物理文件（WAL 模式下整文件删重建需一并删三件）。 */
export function searchDbSidecars(filePath: string): string[] {
  return [filePath, `${filePath}-wal`, `${filePath}-shm`];
}

/** 关闭并物理删除 search.db（含 wal/shm）；用于 rebuild / reindex 双库切换（§4.9）。 */
export function deleteSearchDbFiles(filePath: string): void {
  for (const f of searchDbSidecars(filePath)) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 文件不存在即视为已删 */
    }
  }
}

/**
 * 解析 search.db 路径：GX_SEARCH_DB_PATH 显式优先；否则 <dataDir>/search.db。
 * dataDir 来自主 config 的可写数据目录（生产 /var/lib/gouxiangdb；开发 apiRoot）。
 */
export function resolveSearchDbPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  const override = env.GX_SEARCH_DB_PATH?.trim();
  if (override) return path.isAbsolute(override) ? override : path.resolve(dataDir, override);
  return path.join(dataDir, SEARCH_DB_FILENAME);
}

// ---- 进程级惰性单例（GX_M5_SEARCH on 时由 S6+ 首调；import 本模块不打开任何连接）----
let singleton: SearchStore | undefined;

/** 进程内单例：首调才 openSearchStore；重复调用复用。默认 off 时根本无人调用 -> 零建库。 */
export function getSearchStore(openOpts: OpenSearchOptions): SearchStore {
  if (!singleton) singleton = openSearchStore(openOpts);
  return singleton;
}

/** 测试/优雅停机：关闭并清空单例。 */
export function closeSearchStore(): void {
  singleton?.close();
  singleton = undefined;
}
