// M5/S5 check-coverage A-F 巡检测试：每个用例独立临时主库 + 独立 search.db，直读物理库，
// 因此 A-F 计数可精确断言（无跨用例实体污染）。

import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeIndexerHarness, seedTable, seedRecord, enqueue, type IndexerHarness,
} from "./indexerHarness.js";
import { SearchIndexer } from "../indexer.js";

// 巡检脚本是 .mjs（不在 tsc include scripts/**/*.ts 内），用动态 import + 本地接口断言。
interface CoverageReport {
  mode: string; vecTableExists: boolean;
  counts: Record<"A" | "B" | "C" | "D" | "E" | "F", number>;
  cappedRecords: number; exitCode: number; blockingCodes: string[];
  samples: Record<string, Array<Record<string, unknown>>>;
}
const covScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/search/check-coverage.mjs",
);
async function computeCoverage(args: {
  mainDbPath: string; searchDbPath: string; mode?: "off" | "cloud";
}): Promise<CoverageReport> {
  const mod = (await import(covScript)) as {
    computeCoverage: (a: typeof args) => CoverageReport;
  };
  return mod.computeCoverage(args);
}

interface Ctx {
  h: IndexerHarness;
  storeKey: string;
  cov: (mode?: "off" | "cloud") => Promise<CoverageReport>;
}

/** 每用例一套独立主库 + 一个 table（已同步 nav），跑完即清。 */
async function freshCtx(prefix: string, storeKey = "s"): Promise<Ctx> {
  const h = await makeIndexerHarness(`gx-m5-s5-cov-${prefix}-`);
  await seedTable(h, "cov", [
    { id: "cov_f0", name: "标题", type: "singleLineText", order: 0 },
    { id: "cov_f1", name: "正文", type: "longText", order: 1 },
  ]);
  const { syncNavFromEntitiesTx } = await import("../../nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  const mainDbPath = process.env.DATABASE_URL!.slice("file:".length).split("?")[0]!;
  return {
    h, storeKey,
    async cov(mode = "off") {
      return computeCoverage({ mainDbPath, searchDbPath: h.searchPathFor(storeKey), mode });
    },
  };
}

async function runIndexer(h: IndexerHarness, storeKey: string) {
  const store = h.openStore(storeKey, false);
  const idx = new SearchIndexer({
    prisma: h.prisma, store, mode: "off", provider: null, workerId: "w", nowMs: () => 2_000_000_000_000, startDelayMs: 0,
  });
  await idx.runOnce();
  return store;
}

describe("check-coverage A-F（每用例独立库）", () => {
  it("干净完整索引：A-F 全 0、exit 0；off 不输出 D 样本", async () => {
    const c = await freshCtx("clean");
    await seedRecord(c.h, "cov_t", "r_ok", { cov_f0: "好记录", cov_f1: "正文齐" });
    await enqueue(c.h, { entityType: "record", entityId: "r_ok", op: "upsert" });
    const store = await runIndexer(c.h, c.storeKey);
    const rep = await c.cov("off");
    expect(rep.counts).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 });
    expect(rep.exitCode).toBe(0);
    expect(rep.samples).not.toHaveProperty("D");
    store.close();
    await c.h.cleanup();
  });

  it("A 漏索引：活实体无 chunk -> A=1、exit 1、blockingCodes 含 A", async () => {
    const c = await freshCtx("a");
    await seedRecord(c.h, "cov_t", "r_a", { cov_f0: "漏了我" }); // 无事件 -> 不索引
    const empty = c.h.openStore(c.storeKey, false); // 建一个自举后的空 search.db
    empty.db.pragma("wal_checkpoint(TRUNCATE)");
    empty.close();
    const rep = await c.cov("off");
    expect(rep.counts.A).toBe(1);
    expect(rep.samples.A[0]).toMatchObject({ entityType: "record", entityId: "r_a" });
    expect(rep.exitCode).toBe(1);
    expect(rep.blockingCodes).toEqual(["A"]);
    await c.h.cleanup();
  });

  it("B 脏行：实体软删但 chunk 仍在 -> B>=2（identity+field）、A=0、exit 1", async () => {
    const c = await freshCtx("b");
    await seedRecord(c.h, "cov_t", "r_b", { cov_f0: "将删除" });
    await enqueue(c.h, { entityType: "record", entityId: "r_b", op: "upsert" });
    const store = await runIndexer(c.h, c.storeKey);
    await c.h.prisma.record.update({ where: { id: "r_b" }, data: { deletedAt: new Date() } });
    const rep = await c.cov("off");
    expect(rep.counts.B).toBeGreaterThanOrEqual(2);
    expect(rep.counts.A).toBe(0);
    expect(rep.exitCode).toBe(1);
    store.close();
    await c.h.cleanup();
  });

  it("E fts 缺失 + F 授权漏登 -> 各 1，exit 1", async () => {
    const c = await freshCtx("ef");
    await seedRecord(c.h, "cov_t", "r_ef", { cov_f0: "标题EF", cov_f1: "正文EF" });
    await enqueue(c.h, { entityType: "record", entityId: "r_ef", op: "upsert" });
    const store = await runIndexer(c.h, c.storeKey);
    store.writeTxn("corrupt-ef", (tx) => {
      const one = tx.prepare("SELECT rowid FROM chunks WHERE entityId=? LIMIT 1").get("r_ef") as { rowid: bigint };
      tx.prepare("DELETE FROM fts_chunks WHERE rowid=?").run(one.rowid);
      const fc = tx.prepare("SELECT chunkRowid FROM field_grant LIMIT 1").get() as { chunkRowid: bigint };
      tx.prepare("DELETE FROM field_grant WHERE chunkRowid=?").run(fc.chunkRowid);
    });
    store.db.pragma("wal_checkpoint(TRUNCATE)"); // 确保独立只读连接看到最新帧
    const rep = await c.cov("off");
    expect(rep.counts.E).toBe(1);
    expect(rep.counts.F).toBe(1);
    expect(rep.counts.A).toBe(0);
    expect(rep.counts.B).toBe(0);
    expect(rep.exitCode).toBe(1);
    store.close();
    await c.h.cleanup();
  });

  it("C 悬空 nodeId 仅警告 exit 0（补 fts 不触发 E；实体仍活不算 A/B）", async () => {
    const c = await freshCtx("c");
    await seedRecord(c.h, "cov_t", "r_c", { cov_f0: "正常C" });
    await enqueue(c.h, { entityType: "record", entityId: "r_c", op: "upsert" });
    const store = await runIndexer(c.h, c.storeKey);
    // 注入一条 nodeId 指向不存在 table 节点的 chunk + fts（实体 r_c 仍活，故不算 A/B/E）。
    store.writeTxn("inject-dangling", (tx) => {
      const rowid = store.allocateRowId(tx);
      const now = new Date().toISOString();
      tx.prepare(
        `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,title,seq,version,length,updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(rowid, "record:r_c:d", "record", "r_c", "nav_table_不存在", "ws_default", "identity", "挂空", 9, 0, 2, now);
      tx.prepare("INSERT INTO fts_chunks(rowid,title,body,chunkId,nodeId,entityType) VALUES(?,?,?,?,?,?)")
        .run(rowid, "挂空", "悬空节点文本", "record:r_c:d", "nav_table_不存在", "record");
    });
    const rep = await c.cov("off");
    expect(rep.counts.C).toBe(1);
    expect(rep.counts.E).toBe(0);
    expect(rep.counts.A).toBe(0);
    expect(rep.counts.B).toBe(0);
    expect(rep.exitCode).toBe(0);
    store.close();
    await c.h.cleanup();
  });

  it("D 向量欠账仅 cloud 计、exit 0；off 跳过 D", async () => {
    const c = await freshCtx("d");
    await seedRecord(c.h, "cov_t", "r_d", { cov_f0: "欠向量", cov_f1: "也欠" });
    await enqueue(c.h, { entityType: "record", entityId: "r_d", op: "upsert" });
    const store = await runIndexer(c.h, c.storeKey); // fts-only：无 vec 行
    const off = await c.cov("off");
    expect(off.samples).not.toHaveProperty("D");
    expect(off.exitCode).toBe(0);
    const cloud = await c.cov("cloud");
    expect(cloud.counts.D).toBeGreaterThanOrEqual(3); // identity+2 field 全欠
    expect(cloud.exitCode).toBe(0);
    store.close();
    await c.h.cleanup();
  });
});
