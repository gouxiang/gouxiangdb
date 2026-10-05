// M5/S2 search.db 自举 schema（独立物理库；不进 Prisma 迁移、不进业务备份）。
//
// 权威依据：M5-implementation-plan §4.2（schema 与 BigInt 铁律）、§0.2 H2/H3/H4/H10。
//   - 本表结构由 SearchStore 初始化时以 IF NOT EXISTS 自举，版本由 index_meta.schema_version 管；
//     search.db 是可整文件删除重建的派生产物，绝不写进 prisma/migrations（否则 readiness
//     迁移探针与 _prisma_migrations 对账 MISMATCH，§5.1）。
//   - vec_chunks 不在基础自举里建：其维度 D = 首次 embedding 响应长度（落 index_meta.embedding_dim），
//     由 createVecChunks(db, dim) 在 vec0 加载成功且首个维度确定后创建，D 只取正整数、绝不拼用户文本。
//   - 整数铁律：chunks.rowid 与 vec0 所有 INTEGER 元数据列绑定一律 bigint（H2）；
//     向量绑定 Buffer.from(Float32Array.buffer)（H3）；KNN 必须带 k/LIMIT（H4，见 query 层，S7）。

/** search.db 内部 schema 版本；不兼容 DDL 变更 bump 并在 SearchStore 触发 rebuild（§4.2）。 */
export const SEARCH_SCHEMA_VERSION = 1;

/** entityType 文本 -> vec_chunks.entityType 整数码（§4.2：1=record 2=doc 3=canvas）。 */
const ENTITY_TYPE_CODES = {
  record: 1,
  doc: 2,
  canvas: 3,
} as const;

/** entityType 文本 -> vec_chunks.entityType 整数码（bigint；绑定时不发 REAL，H2）。 */
export function entityTypeCode(type: string): bigint {
  const code = (ENTITY_TYPE_CODES as Record<string, number | undefined>)[type];
  if (code === undefined) throw new TypeError(`unknown search entityType: ${type}`);
  return BigInt(code);
}

/** 基础表（不含 vec0 虚表）自举语句；全部 IF NOT EXISTS，可重入/可对已存在库执行。 */
const BASE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS chunks(
    rowid       INTEGER PRIMARY KEY,
    chunkId     TEXT NOT NULL UNIQUE,
    entityType  TEXT NOT NULL,
    entityId    TEXT NOT NULL,
    nodeId      TEXT NOT NULL,
    workspaceId TEXT NOT NULL,
    chunkKind   TEXT NOT NULL,
    fieldId     TEXT,
    title       TEXT NOT NULL DEFAULT '',
    seq         INTEGER NOT NULL DEFAULT 0,
    version     INTEGER NOT NULL DEFAULT 0,
    length      INTEGER NOT NULL DEFAULT 0,
    updatedAt   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_node   ON chunks(nodeId)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_entity ON chunks(entityType, entityId)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_field  ON chunks(fieldId) WHERE fieldId IS NOT NULL`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
    title, body, chunkId UNINDEXED, nodeId UNINDEXED, entityType UNINDEXED,
    tokenize='trigram remove_diacritics 1'
  )`,
  `CREATE TABLE IF NOT EXISTS field_grant(
    chunkRowid  INTEGER NOT NULL,
    tableNodeId TEXT NOT NULL,
    fieldId     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fg_lookup ON field_grant(tableNodeId, fieldId)`,
  `CREATE TABLE IF NOT EXISTS index_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

/** index_meta 已知键（白名单注释；实际读写按字符串，未知键保留不删）。 */
export const META_KEYS = {
  schemaVersion: "schema_version",
  vecLoaded: "vec_loaded",
  vecVersion: "vec_version",
  embeddingMode: "embedding_mode",
  embeddingModel: "embedding_model",
  embeddingDim: "embedding_dim",
  indexedAt: "indexed_at",
  rebuilding: "rebuilding",
  activeDb: "active_db",
  workerLock: "worker_lock",
  nextRowid: "next_rowid",
  fieldChunkCap: "field_chunk_cap",
  cappedRecords: "capped_records",
} as const;

/** 自举所需的最小 better-sqlite3 连接形状（exec/prepare）。 */
export interface SchemaDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * 建基础表/索引（幂等）并盖 schema_version。不建 vec_chunks（维度未定）。
 * 多条 DDL 不经显式事务：SQLite 对 CREATE 各自提交，IF NOT EXISTS 保证重入安全。
 */
export function bootstrapBaseSchema(db: SchemaDb): void {
  for (const stmt of BASE_DDL) db.exec(stmt);
  setMeta(db, META_KEYS.schemaVersion, String(SEARCH_SCHEMA_VERSION));
}

/**
 * 校验向量维度：必须是 1..65535 的安全正整数。维度只来自首个 embedding 响应，
 * 这里再做一道数值门，杜绝把任意文本拼进 DDL。
 */
export function assertValidEmbeddingDim(dim: number): number {
  if (!Number.isInteger(dim) || dim < 1 || dim > 65535) {
    throw new Error(`invalid embedding dimension for vec_chunks: ${dim}`);
  }
  return dim;
}

/**
 * 生成 vec_chunks 虚表 DDL。D 为已校验正整数（float[D] 字面量只插整数，无注入面）。
 * entityType 为 INTEGER 元数据列（绑 bigint，H2）。
 */
export function vecChunksDdl(dim: number): string {
  const d = assertValidEmbeddingDim(dim);
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[${d}],
    entityType INTEGER
  )`;
}

/** 在 vec0 已加载连接上按维度建 vec_chunks（幂等）。 */
export function createVecChunks(db: SchemaDb, dim: number): void {
  db.exec(vecChunksDdl(dim));
  setMeta(db, META_KEYS.embeddingDim, String(assertValidEmbeddingDim(dim)));
}

/** 读 index_meta；不存在返回 undefined。 */
export function getMeta(db: SchemaDb, key: string): string | undefined {
  const row = db.prepare("SELECT v FROM index_meta WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v;
}

/** 写 index_meta（UPSERT）。 */
export function setMeta(db: SchemaDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO index_meta(k, v) VALUES(?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(key, value);
}

/** 判断 vec_chunks 是否已在该库创建（sqlite_master 中存在）。 */
export function vecChunksExists(db: SchemaDb): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'")
    .get() as { x: number } | undefined;
  return row !== undefined;
}

/** search.db 逻辑表名（白名单）；FTS5 与 vec0 的内部影子表不计入。 */
const LOGICAL_TABLES = [
  "chunks",
  "fts_chunks",
  "vec_chunks",
  "field_grant",
  "index_meta",
] as const;

/** 列出已创建的 search.db 逻辑表（含 fts5/vec0 虚表——sqlite_master 中虚表也记 type='table'）。 */
export function listTables(db: SchemaDb): string[] {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  return LOGICAL_TABLES.filter((n) => present.has(n));
}
