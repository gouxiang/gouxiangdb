// M5/S2 SearchStore + search.db schema 真库单测（临时独立文件，不依赖外网/模型/Prisma）。
// 覆盖：独立文件自举与表清单、vec0 KNN 强制 LIMIT 往返、整数 BigInt/向量 Float32 BLOB、
// vec0 缺失/坏路径降级 fts-only 且不抛、FTS5 trigram 中文≥3 命中/2 字回 LIKE、
// schema 重建幂等、truncate 重建、next_rowid 单写者取号、整文件删重建。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openSearchStore,
  deleteSearchDbFiles,
  resolveSearchDbPath,
  searchDbSidecars,
  type SearchStore,
} from "../searchStore.js";
import {
  SEARCH_SCHEMA_VERSION,
  bootstrapBaseSchema,
  vecChunksDdl,
  vecChunksExists,
  getMeta,
  setMeta,
  listTables,
  assertValidEmbeddingDim,
  entityTypeCode,
  type SchemaDb,
} from "../schema.js";
import { vecInt, vecBlob } from "../vecLoader.js";

let tmpDir: string;
const stores: SearchStore[] = [];

function makeStore(file: string, opts: { tryLoadVec?: boolean; vecExtPath?: string } = {}): SearchStore {
  const s = openSearchStore({ filePath: file, appDir: process.cwd(), ...opts });
  stores.push(s);
  return s;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-search-db-"));
});

afterEach(() => {
  for (const s of stores.splice(0)) {
    try { s.close(); } catch { /* already closed */ }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("search.db 自举与独立物理文件", () => {
  it("打开即建库 + 基础表/索引/index_meta，schema_version 盖印，且独立于 Prisma（无 _prisma_migrations）", () => {
    const file = path.join(tmpDir, "search.db");
    const s = makeStore(file, { tryLoadVec: false });
    expect(fs.existsSync(file)).toBe(true);
    const tables = listTables(s.db);
    for (const t of ["chunks", "fts_chunks", "field_grant", "index_meta"]) {
      expect(tables).toContain(t);
    }
    expect(getMeta(s.db, "schema_version")).toBe(String(SEARCH_SCHEMA_VERSION));
    // vec_chunks 默认未建（维度未定）。
    expect(vecChunksExists(s.db)).toBe(false);
    // 派生库绝不带 Prisma 迁移账本表。
    const prismaTable = s.db
      .prepare("SELECT name FROM sqlite_master WHERE name = '_prisma_migrations'")
      .all() as Array<{ name: string }>;
    expect(prismaTable).toHaveLength(0);
  });

  it("bootstrapBaseSchema 幂等：对已存在库再执行不报错、不重建丢数据", () => {
    const file = path.join(tmpDir, "search.db");
    const s = makeStore(file, { tryLoadVec: false });
    s.db.prepare("INSERT INTO chunks(rowid, chunkId, entityType, entityId, nodeId, workspaceId, chunkKind, updatedAt) VALUES (?,?,?,?,?,?,?,?)")
      .run(1, "record:r1", "record", "r1", "node-t", "ws_default", "identity", "2026-09-16T00:00:00Z");
    expect(() => bootstrapBaseSchema(s.db)).not.toThrow();
    expect(s.db.prepare("SELECT count(*) c FROM chunks").get()).toEqual({ c: 1 });
  });

  it("resolveSearchDbPath：GX_SEARCH_DB_PATH 优先（绝对/相对），否则 dataDir/search.db", () => {
    expect(resolveSearchDbPath({ GX_SEARCH_DB_PATH: "/x/y/s.db" }, "/data")).toBe("/x/y/s.db");
    expect(resolveSearchDbPath({ GX_SEARCH_DB_PATH: "sub/s.db" }, "/data")).toBe("/data/sub/s.db");
    expect(resolveSearchDbPath({}, "/data")).toBe(path.join("/data", "search.db"));
  });
});

describe("vec_chunks 维度门与 DDL", () => {
  it("assertValidEmbeddingDim 只接受 1..65535 正整数；DDL 内插整数无注入面", () => {
    expect(assertValidEmbeddingDim(1536)).toBe(1536);
    for (const bad of [0, -1, 1.5, Number.NaN, 100000]) {
      expect(() => assertValidEmbeddingDim(bad)).toThrow(/invalid embedding dimension/);
    }
    expect(vecChunksDdl(4)).toContain("float[4]");
  });

  it("entityTypeCode：record/doc/canvas -> 1/2/3（bigint），未知抛错", () => {
    expect(entityTypeCode("record")).toBe(1n);
    expect(entityTypeCode("doc")).toBe(2n);
    expect(entityTypeCode("canvas")).toBe(3n);
    expect(() => entityTypeCode("nope")).toThrow(TypeError);
  });

  it("vec0 可用时 ensureVecChunks 按维度建表并写 embedding_dim，重复调用幂等", () => {
    const s = makeStore(path.join(tmpDir, "v.db"));
    if (!s.vecAvailable) return; // 平台不支持时跳过（CI 矩阵中不支持平台纯 FTS）。
    expect(s.ensureVecChunks(4)).toBe(true);
    expect(vecChunksExists(s.db)).toBe(true);
    expect(getMeta(s.db, "embedding_dim")).toBe("4");
    expect(s.ensureVecChunks(4)).toBe(true); // 已存在直接 true
  });
});

describe("vec0 KNN 强制 LIMIT 往返 + BigInt/Float32 BLOB（本机 vec0）", () => {
  it("k 限制下按 L2 距离升序返回，rowid/元数据整数绑定 bigint，向量走 BLOB（H2/H3/H4）", () => {
    const s = makeStore(path.join(tmpDir, "knn.db"));
    if (!s.vecAvailable) return;
    s.ensureVecChunks(3);
    const ins = s.db.prepare("INSERT INTO vec_chunks(rowid, embedding, entityType) VALUES (?,?,?)");
    // vecInt/vecBlob 是所有 insert 的唯一绑定入口。
    ins.run(vecInt(1), vecBlob([1, 0, 0]), entityTypeCode("record"));
    ins.run(vecInt(2), vecBlob([0.9, 0.1, 0]), entityTypeCode("doc"));
    ins.run(vecInt(3), vecBlob([0, 0, 1]), entityTypeCode("canvas"));
    // KNN 必带 k=?（H4）；entityType 整数元数据过滤暴力扫描期完成。
    const rows = s.db
      .prepare("SELECT rowid FROM vec_chunks WHERE embedding MATCH ? AND k = ? AND entityType = ? ORDER BY distance")
      .all(vecBlob([1, 0, 0]), vecInt(10), entityTypeCode("record")) as Array<{ rowid: number | bigint }>;
    expect(rows.map((r) => Number(r.rowid))).toEqual([1]);
    // 不带 k 的 KNN 必须报错（封装层强制 LIMIT 的反向钉死）。
    expect(() => s.db.prepare("SELECT rowid FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance")
      .all(vecBlob([1, 0, 0]))).toThrow();
    // 全量 top2 距离序：1（0）-> 2（≈0.1414），3 更远被 k=2 截断。
    const top2 = s.db
      .prepare("SELECT rowid FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance")
      .all(vecBlob([1, 0, 0]), vecInt(2)) as Array<{ rowid: number | bigint }>;
    expect(top2.map((r) => Number(r.rowid))).toEqual([1, 2]);
  });
});

describe("降级：vec0 不可用时 fts-only 正常服役（H8）", () => {
  it("tryLoadVec=false：vecAvailable=false、不建 vec_chunks，但 chunks/fts 读写正常，store 不抛", () => {
    const s = makeStore(path.join(tmpDir, "fts.db"), { tryLoadVec: false });
    expect(s.vecAvailable).toBe(false);
    expect(s.ensureVecChunks(4)).toBe(false);
    expect(vecChunksExists(s.db)).toBe(false);
    expect(getMeta(s.db, "vec_loaded")).toBe("0");
    seedFts(s.db);
    // trigram ≥3 码点命中（H9）。
    const m3 = ftsCount(s.db, '"项目管"');
    expect(m3).toBe(1);
    // 2 码点 MATCH 不命中，调用层需回参数化 LIKE（此处钉死 trigram 行为）。
    expect(ftsCount(s.db, '"项目"')).toBe(0);
  });

  it("坏扩展路径：加载失败被吞、store 仍打开且 FTS 可用，vecAvailable=false", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); // 预期降级 warn，静默
    const bad = path.join(tmpDir, "vec0.dylib");
    fs.writeFileSync(bad, Buffer.from("not-a-real-shared-library", "utf8"));
    const s = makeStore(path.join(tmpDir, "badvec.db"), { vecExtPath: bad });
    // env 坏文件优先于 node_modules，故加载必失败。
    expect(s.vecAvailable).toBe(false);
    expect(s.vecError).toBeTruthy();
    seedFts(s.db);
    expect(ftsCount(s.db, '"设计规"')).toBe(1);
  });
});

describe("FTS5 trigram 中文≥3 命中 / 2 码点 MATCH 为 0（回 LIKE 由 S3 queryPlan 负责）", () => {
  it("与 spike H9 一致：3/4 码点命中，2 码点 MATCH=0；拉丁前缀 term* 可用", () => {
    const s = makeStore(path.join(tmpDir, "trigram.db"), { tryLoadVec: false });
    seedFts(s.db);
    expect(ftsCount(s.db, '"项目管"')).toBe(1);
    expect(ftsCount(s.db, '"项目管理"')).toBe(1);
    expect(ftsCount(s.db, '"项目"')).toBe(0);
    expect(ftsCount(s.db, '"规范"')).toBe(0);
    // 参数化 LIKE 是 2 码点的兜底（演示语义，实接 S3 queryPlan）。
    const like = s.db.prepare("SELECT count(*) c FROM fts_chunks WHERE title LIKE ? OR body LIKE ?")
      .get("%项目%", "%项目%") as { c: number };
    expect(like.c).toBe(1);
  });
});

describe("writeTxn（H10）/ rowid 取号 / truncate / 整文件删重建", () => {
  it("writeTxn 立即执行并返回结果；内部抛错整体回滚（不留半截）", () => {
    const s = makeStore(path.join(tmpDir, "txn.db"), { tryLoadVec: false });
    const n = s.writeTxn("insert", (tx) => {
      tx.prepare("INSERT INTO index_meta(k, v) VALUES('a','1')").run();
      tx.prepare("INSERT INTO index_meta(k, v) VALUES('b','2')").run();
      return 2;
    });
    expect(n).toBe(2);
    expect(s.db.prepare("SELECT count(*) c FROM index_meta WHERE k IN ('a','b')").get()).toEqual({ c: 2 });
    expect(() => s.writeTxn("rollback", (tx) => {
      tx.prepare("INSERT INTO index_meta(k, v) VALUES('c','3')").run();
      throw new Error("boom");
    })).toThrow(/rollback/);
    expect(s.db.prepare("SELECT count(*) c FROM index_meta WHERE k='c'").get()).toEqual({ c: 0 });
  });

  it("allocateRowId：写事务内基于 next_rowid 单调取 bigint 号", () => {
    const s = makeStore(path.join(tmpDir, "rowid.db"), { tryLoadVec: false });
    const ids = s.writeTxn("alloc", (tx) => [s.allocateRowId(tx), s.allocateRowId(tx), s.allocateRowId(tx)]);
    expect(ids.map(String)).toEqual(["1", "2", "3"]);
    expect(getMeta(s.db, "next_rowid")).toBe("3");
  });

  it("truncate：清空派生表并重建基础 schema，文件/vec 加载态保留", () => {
    const s = makeStore(path.join(tmpDir, "trunc.db"), { tryLoadVec: false });
    s.db.prepare("INSERT INTO chunks(rowid, chunkId, entityType, entityId, nodeId, workspaceId, chunkKind, updatedAt) VALUES (1,'record:x','record','x','n','ws_default','identity','t')").run();
    setMeta(s.db, "indexed_at", "123");
    s.truncate();
    expect(s.db.prepare("SELECT count(*) c FROM chunks").get()).toEqual({ c: 0 });
    expect(getMeta(s.db, "schema_version")).toBe(String(SEARCH_SCHEMA_VERSION));
    expect(getMeta(s.db, "vec_loaded")).toBe("0");
    expect(getMeta(s.db, "indexed_at")).toBeUndefined();
    // 仍可继续写。
    expect(() => bootstrapBaseSchema(s.db)).not.toThrow();
  });

  it("整文件删重建：deleteSearchDbFiles 清三件，重开得到空库", () => {
    const file = path.join(tmpDir, "rebuild.db");
    const s1 = makeStore(file, { tryLoadVec: false });
    s1.db.prepare("INSERT INTO chunks(rowid, chunkId, entityType, entityId, nodeId, workspaceId, chunkKind, updatedAt) VALUES (1,'record:y','record','y','n','ws_default','identity','t')").run();
    s1.close();
    expect(searchDbSidecars(file)[0]).toBe(file);
    deleteSearchDbFiles(file);
    for (const f of searchDbSidecars(file)) expect(fs.existsSync(f)).toBe(false);
    const s2 = makeStore(file, { tryLoadVec: false });
    expect(s2.db.prepare("SELECT count(*) c FROM chunks").get()).toEqual({ c: 0 });
  });
});

function seedFts(db: SchemaDb): void {
  const ins = db.prepare("INSERT INTO fts_chunks(title, body) VALUES (?, ?)");
  ins.run("项目管理看板", "这是关于项目管理的内容");
  ins.run("设计规范", "统一的视觉规范文档");
  ins.run("Invoice", "latin token demo invoice");
}

function ftsCount(db: SchemaDb, phrase: string): number {
  const row = db.prepare("SELECT count(*) c FROM fts_chunks WHERE fts_chunks MATCH ?").get(phrase) as { c: number };
  return row.c;
}
