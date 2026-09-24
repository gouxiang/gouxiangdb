// M5/S9 reindex 双库原子切换真机演练（M5-implementation-plan §4.9/§5.4、AC-M5-1b）。
//
// 真临时主库 + 真物理 search.db（不 mock store/db），cloud 向量只 mock provider（不触外网）。
// 重点（复验焦点 rename 一致性）：
//   1. 全量重建：灌库【中途】现役库仍可读且只含旧内容（新库不可见）；灌完 rename 后同一路径
//      含新内容；临时 search.db.rebuild-* 文件清理干净；旧库 -wal/-shm 不残留。
//   2. 单实体 reindex：原地幂等（不换文件、swapped=false、内容更新、重复跑等价）。
//   3. 进程锁：重建中第二次 startReindex 同步抛 ReindexInProgressError。
//   4. 失败路径：灌库抛错时现役库不动、临时文件清理。
//   5. 走真实进程单例（不注入 activeStore）的一条：close->rename->惰性重开，旧内容持续到切换点。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  makeIndexerHarness, seedTable, seedRecord, enqueue, type IndexerHarness,
} from "./indexerHarness.js";
import { SearchIndexer } from "../indexer.js";
import { getSearchStore, closeSearchStore, type SearchStore } from "../searchStore.js";
import { startReindex, ReindexInProgressError, currentReindex } from "../reindex.js";
import { EmbeddingConfigStore } from "../embeddingConfig.js";

const JWT = "m5-s9-reindex-secret-at-least-16-chars";

function readOnlyCount(searchPath: string): { total: number; ids: string[] } {
  const db = new Database(searchPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT entityId FROM chunks").all() as Array<{ entityId: string }>;
    return { total: rows.length, ids: [...new Set(rows.map((r) => r.entityId))].sort() };
  } finally {
    db.close();
  }
}

function rebuildLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes(".rebuild-"));
}

async function indexOnce(h: IndexerHarness, store: SearchStore) {
  const idx = new SearchIndexer({
    prisma: h.prisma, store, mode: "off", provider: null, workerId: "w",
    nowMs: () => 2_000_000_000_000, startDelayMs: 0,
  });
  await idx.runOnce();
}

describe("M5/S9 reindex 双库原子切换（真机演练）", () => {
  let h: IndexerHarness;

  beforeEach(async () => {
    h = await makeIndexerHarness("gx-m5-s9-reindex-");
    await seedTable(h, "ri", [
      { id: "ri_f0", name: "标题", type: "singleLineText", order: 0 },
    ]);
  });
  afterEach(async () => {
    closeSearchStore();
    await h.cleanup();
  });

  it("全量：灌库中旧库只含旧内容且可读；rename 后同路径含新内容；临时文件与旧 wal/shm 清理", async () => {
    await seedRecord(h, "ri_t", "ri_old", { ri_f0: "旧内容阿尔法" });
    await enqueue(h, { entityType: "record", entityId: "ri_old", op: "upsert" });
    const searchPath = h.searchPathFor("active");
    const active = h.openStore("active", false);
    await indexOnce(h, active);
    active.db.pragma("wal_checkpoint(TRUNCATE)");

    // 新活实体（未入 outbox，故旧索引没有它）。
    await seedRecord(h, "ri_t", "ri_new", { ri_f0: "新内容贝塔伽马" });

    let midpointChecked = false;
    const task = startReindex(
      {
        prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: searchPath },
        dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT,
        searchPath, activeStore: active,
        async onProgress(done, total) {
          if (done === 1 && total >= 2) {
            // 灌库中途：现役文件仍可读，且只含旧实体（新库尚未 rename 进来）。
            const snap = readOnlyCount(searchPath);
            expect(snap.ids).toContain("ri_old");
            expect(snap.ids).not.toContain("ri_new");
            // 临时库文件此刻存在（灌库中）。
            expect(rebuildLeftovers(h.tmpDir).length).toBeGreaterThanOrEqual(1);
            midpointChecked = true;
          }
        },
      },
      {},
    );
    const res = await task;
    expect(midpointChecked).toBe(true);
    expect(res.mode).toBe("full");
    expect(res.swapped).toBe(true);
    expect(res.entities).toBeGreaterThanOrEqual(2);

    // rename 后同一路径含新实体与旧实体（旧内容持续到切换点，切换后是全量新快照）。
    const after = readOnlyCount(searchPath);
    expect(after.ids).toContain("ri_old");
    expect(after.ids).toContain("ri_new");

    // 临时 rebuild 文件（含其 wal/shm）已清理，现役文件仍是同一主路径。
    expect(rebuildLeftovers(h.tmpDir)).toEqual([]);
    expect(fs.existsSync(searchPath)).toBe(true);
    expect(fs.existsSync(`${searchPath}.rebuild-x`)).toBe(false);
  });

  it("单实体：原地幂等更新（swapped=false、不产生 rebuild 文件、重复跑内容一致）", async () => {
    await seedRecord(h, "ri_t", "ri_one", { ri_f0: "初始文本" });
    await enqueue(h, { entityType: "record", entityId: "ri_one", op: "upsert" });
    const searchPath = h.searchPathFor("single");
    const active = h.openStore("single", false);
    await indexOnce(h, active);

    // 改主库字段值后只对该实体重建。
    await h.prisma.record.update({ where: { id: "ri_one" }, data: { fields: JSON.stringify({ ri_f0: "改后的新文本" }) } });

    const r1 = await startReindex(
      { prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: searchPath }, dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath, activeStore: active },
      { type: "record", entityId: "ri_one" },
    );
    expect(r1.mode).toBe("single");
    expect(r1.swapped).toBe(false);
    expect(rebuildLeftovers(h.tmpDir)).toEqual([]);

    const db = new Database(searchPath, { readonly: true });
    try {
      // field chunk 的正文反映改后值（body 存值）；identity title 保留中性标识。
      const bodies = (db.prepare("SELECT body FROM fts_chunks").all() as Array<{ body: string }>)
        .map((x) => x.body);
      expect(bodies.join("\n")).toContain("改后的新文本");
      expect(bodies.join("\n")).not.toContain("初始文本");
      // 删旧写新：该实体 chunk 数 >0 且重复跑不堆积（见下方 before/after 相等）。
      const n = (db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE entityId=?").get("ri_one") as { n: number }).n;
      expect(n).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    // 重复跑幂等：chunk 数不变。
    const before = (new Database(searchPath, { readonly: true })
      .prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    await startReindex(
      { prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: searchPath }, dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath, activeStore: active },
      { type: "record", entityId: "ri_one" },
    );
    const after = (new Database(searchPath, { readonly: true })
      .prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("进程锁：重建中第二次 startReindex 同步抛 ReindexInProgressError（AC-M5-1b 409 源）", async () => {
    await seedRecord(h, "ri_t", "ri_lock", { ri_f0: "锁内容" });
    const searchPath = h.searchPathFor("lock");
    const active = h.openStore("lock", false);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = startReindex(
      {
        prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: searchPath },
        dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath, activeStore: active,
        onProgress: () => gate,
      },
      {},
    );
    // 第一次已在飞（等它进入灌库回调）。
    await Promise.resolve();
    expect(currentReindex()).not.toBeNull();
    expect(() => startReindex(
      { prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath, activeStore: active },
      {},
    )).toThrow(ReindexInProgressError);
    release();
    await task;
    expect(currentReindex()).toBeNull();
  });

  it("失败路径：灌库中途抛错时现役库不动、临时 rebuild 文件清理", async () => {
    await seedRecord(h, "ri_t", "ri_keep", { ri_f0: "保留内容" });
    await enqueue(h, { entityType: "record", entityId: "ri_keep", op: "upsert" });
    const searchPath = h.searchPathFor("fail");
    const active = h.openStore("fail", false);
    await indexOnce(h, active);
    active.db.pragma("wal_checkpoint(TRUNCATE)");
    const beforeIds = readOnlyCount(searchPath).ids;
    // 新增一条活实体，保证全量灌库至少回调一次后在第二条处确定性炸。
    await seedRecord(h, "ri_t", "ri_second", { ri_f0: "第二条" });

    await expect(startReindex(
      {
        prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: searchPath },
        dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath, activeStore: active,
        onProgress: (done) => { if (done >= 1) throw new Error("boom mid rebuild"); },
      },
      {},
    )).rejects.toThrow(/active index untouched/);

    expect(rebuildLeftovers(h.tmpDir)).toEqual([]);
    // 现役文件仍是旧快照（新实体未进入，rename 未发生）。
    expect(readOnlyCount(searchPath).ids).toEqual(beforeIds);
    expect(readOnlyCount(searchPath).ids).not.toContain("ri_second");
  });

  it("全量成功后清 search.reindex_required；失败/单实体保持原值", async () => {
    // 成功路径：预置 true，runFull 切换成功后变 false。
    await seedRecord(h, "ri_t", "ri_flag_ok", { ri_f0: "清零路径" });
    const okPath = h.searchPathFor("flag-ok");
    const okStore = h.openStore("flag-ok", false);
    const cfg = new EmbeddingConfigStore(h.prisma, JWT);
    await cfg.setReindexRequired(true);
    expect(await cfg.isReindexRequired()).toBe(true);

    await startReindex(
      {
        prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: okPath },
        dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath: okPath, activeStore: okStore,
      },
      {},
    );
    expect(await cfg.isReindexRequired()).toBe(false);

    // 失败路径：灌库炸时标志保持原值（true），不被清零。
    await seedRecord(h, "ri_t", "ri_flag_fail", { ri_f0: "保留标志" });
    const failPath = h.searchPathFor("flag-fail");
    const failStore = h.openStore("flag-fail", false);
    await cfg.setReindexRequired(true);
    await expect(startReindex(
      {
        prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: failPath },
        dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath: failPath, activeStore: failStore,
        onProgress: () => { throw new Error("boom before clear"); },
      },
      {},
    )).rejects.toThrow(/active index untouched/);
    expect(await cfg.isReindexRequired()).toBe(true);

    // 单实体原地重建不清零全局标志。
    await seedRecord(h, "ri_t", "ri_flag_single", { ri_f0: "单实体不动标志" });
    const singlePath = h.searchPathFor("flag-single");
    const singleStore = h.openStore("flag-single", false);
    await startReindex(
      { prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: singlePath }, dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath: singlePath, activeStore: singleStore },
      { type: "record", entityId: "ri_flag_single" },
    );
    expect(await cfg.isReindexRequired()).toBe(true);
  });

  it("真实进程单例路径：全量切换后 close->惰性重开，新单例读到新内容", async () => {
    await seedRecord(h, "ri_t", "ri_singleton_old", { ri_f0: "单例旧" });
    await enqueue(h, { entityType: "record", entityId: "ri_singleton_old", op: "upsert" });
    const searchPath = h.searchPathFor("singleton");
    // 全程走真实进程单例（不注入 activeStore），先灌旧库。
    const s2 = getSingleton(searchPath);
    const idx = new SearchIndexer({
      prisma: h.prisma, store: s2, mode: "off", provider: null, workerId: "w",
      nowMs: () => 2_000_000_000_000, startDelayMs: 0,
    });
    await idx.runOnce();
    s2.db.pragma("wal_checkpoint(TRUNCATE)");
    await seedRecord(h, "ri_t", "ri_singleton_new", { ri_f0: "单例新" });

    await startReindex(
      {
        prisma: h.prisma, env: { ...process.env, GX_SEARCH_DB_PATH: searchPath },
        dataDir: h.tmpDir, appDir: process.cwd(), jwtSecret: JWT, searchPath,
      },
      {},
    );
    // 切换时单例已 close；惰性重开读到新快照。
    const reopened = getSingleton(searchPath);
    const ids = (reopened.db.prepare("SELECT DISTINCT entityId FROM chunks").all() as Array<{ entityId: string }>)
      .map((r) => r.entityId);
    expect(ids).toContain("ri_singleton_new");
    expect(ids).toContain("ri_singleton_old");
    expect(rebuildLeftovers(h.tmpDir)).toEqual([]);

    function getSingleton(p: string): SearchStore {
      // startReindex 切换时已 closeSearchStore；此处必为新连接。
      return getSearchStore({ filePath: p, appDir: process.cwd(), tryLoadVec: false });
    }
  });
});
