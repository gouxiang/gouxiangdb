// M5/S13 生成器 + 召回小规模集成测试（真 search.db + 真 vec0，快速；规模门真机由 m5-gate.ts 跑）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSearchStore } from "../../../src/domain/search/searchStore.js";
import { runRecall, toQueryBlob } from "../../../src/domain/search/queryRecall.js";
import { buildSearchQueryPlan } from "../../../src/domain/search/queryPlan.js";
import { generateSearchDb, deterministicVector, queryVector } from "../m5-gen.js";
import { assertNoFullRecall } from "../m5-bench-lib.js";

const CHUNKS = 400;
const DIM = 16;
let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m5-s13-gen-"));
  dbPath = path.join(dir, "search.db");
  await generateSearchDb({ filePath: dbPath, appDir: process.cwd(), totalChunks: CHUNKS, dim: DIM, seed: 20260917 });
}, 120000);

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("deterministicVector / queryVector", () => {
  it("单位向量：模长 1、同 rowid 可复现、不同 rowid 不同", () => {
    const a = deterministicVector(42, DIM);
    const b = deterministicVector(42, DIM);
    const norm = Math.sqrt(Array.from(a).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(deterministicVector(43, DIM))).not.toEqual(Array.from(a));
  });

  it("查询向量确定（跨次可复现）", () => {
    expect(Array.from(queryVector(1, DIM))).toEqual(Array.from(queryVector(1, DIM)));
  });
});

describe("generateSearchDb：三族写入与统计", () => {
  it("总 chunk 数 = 请求量；三族之和一致；nodeIds 非空；库文件存在", () => {
    const store = openSearchStore({ filePath: dbPath, appDir: process.cwd(), tryLoadVec: true });
    try {
      expect(store.vecAvailable).toBe(true); // vec_chunks 是 vec0 虚表，读计数须加载扩展
      const one = (sql: string): number => (store.db.prepare(sql).get() as { c: number }).c;
      expect(one("SELECT COUNT(*) AS c FROM chunks")).toBe(CHUNKS);
      expect(one("SELECT COUNT(*) AS c FROM fts_chunks")).toBe(CHUNKS);
      expect(one("SELECT COUNT(*) AS c FROM vec_chunks")).toBe(CHUNKS);
      // 三族各自 >0（按 60/30/10 分配，record/doc/canvas 均非空）
      for (const t of ["record", "doc", "canvas"]) {
        expect(one(`SELECT COUNT(*) AS c FROM chunks WHERE entityType='${t}'`)).toBeGreaterThan(0);
      }
    } finally {
      store.close();
    }
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
  });
});

describe("混合检索（真 vec0）+ EXPLAIN 断言", () => {
  it("FTS+vec 双路命中、融合有结果，且 EXPLAIN 无先全量召回", () => {
    const store = openSearchStore({ filePath: dbPath, appDir: process.cwd(), tryLoadVec: true });
    try {
      expect(store.vecAvailable).toBe(true);
      const scope = store.db.prepare("SELECT DISTINCT nodeId FROM chunks").all() as Array<{ nodeId: string }>;
      const nodeIds = scope.map((r) => r.nodeId);
      const plan = buildSearchQueryPlan("季度报告", { mode: "auto", type: "all", limit: 20, perRoute: 100 });
      const recall = runRecall(store.db, plan, nodeIds, [], { queryVector: toQueryBlob(queryVector(20260917, DIM)) });
      expect(recall.ran.fts).toBe(true);
      expect(recall.ran.vec).toBe(true);
      expect(recall.fts.length).toBeGreaterThan(0);
      expect(recall.vec.length).toBeGreaterThan(0);

      const ex = runRecall(store.db, plan, nodeIds, [], { queryVector: toQueryBlob(queryVector(20260917, DIM)), explain: true });
      const verdict = assertNoFullRecall({ fts: ex.plans.fts, vec: ex.plans.vec });
      expect(verdict.missing).toEqual([]);
      expect(verdict.ok).toBe(true);
    } finally {
      store.close();
    }
  });
});
