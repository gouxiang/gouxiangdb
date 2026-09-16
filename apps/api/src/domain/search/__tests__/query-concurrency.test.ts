// M5/S7 硬红线 2：共享单例 search.db 连接 + TEMP TABLE 的并发隔离。
//
// 场景：auto+cloud 路的 await provider.embed() 会让出事件循环；若在共享连接上用【固定名】
// TEMP TABLE 且物化跨 await，两个不同 scope 的并发请求会互相串用 scope/grant 临时表，
// 造成越权召回。生产实现的防护是：① embed(q) 提前到任何 TEMP 物化之前；② 进入召回后纯同步
// 无 await；③ 临时表用唯一后缀名并 finally DROP。本测试用真 cloud 路（embed 中 await
// macrotask 制造交错窗口）+ 两个互斥 scope 的用户并发同查，断言结果互不串。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, querySeed, type QueryHarness } from "./queryHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { executeUnifiedSearch } from "../query.js";
import { buildQueryRuntime } from "../queryRuntime.js";
import type { SearchStore } from "../searchStore.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { QueryRuntimeDeps } from "../queryTypes.js";

let h: QueryHarness;
let store: SearchStore;
let provider: EmbeddingProvider;

const UA = "u_conc_a";
const UB = "u_conc_b";
const TA = "conc_table_a";
const TB = "conc_table_b";
const NA = `nav_table_${TA}`;
const NB = `nav_table_${TB}`;
// 两表各含一个独有词（>=3 码元走 FTS；另一个用户的 scope 必须把它整实体挡住）。
const WORD_A = "并发独有词ALPHA_A9";
const WORD_B = "并发独有词BRAVO_B9";
const COMMON = "并发共有词X7"; // 两表都含；scope 不同仍只能各见自家记录。

/** 可控延迟 cloud provider：embed await 一个 macrotask，制造跨请求交错窗口。 */
function delayedCloudProvider(dim: number, delayOf: (text: string) => number) {
  return {
    mode: "cloud" as const,
    model: "mock-delayed",
    dim: 0,
    batchSize: 64,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      const d = delayOf(texts[0] ?? "");
      await new Promise((r) => setTimeout(r, d));
      return texts.map((t) => {
        const v = new Float32Array(dim);
        v[0] = (t.charCodeAt(0) % 7) / 7;
        return v;
      });
    },
    async health() { return { ok: true }; },
    async dispose() { return undefined; },
  };
}

async function mkTable(tableId: string, fieldId: string, records: Array<[string, string]>) {
  await h.prisma.base.create({ data: { id: `${tableId}_b`, name: `${tableId} 库`, createdBy: "owner" } });
  await h.prisma.table.create({
    data: { id: tableId, baseId: `${tableId}_b`, name: `${tableId} 表`, primaryFieldId: fieldId, createdBy: "owner" },
  });
  await h.prisma.field.create({ data: { id: fieldId, tableId, name: "客户名", type: "singleLineText", order: 0 } });
  for (const [rid, val] of records) {
    await h.prisma.record.create({
      data: { id: rid, tableId, createdBy: "owner", updatedBy: "owner", fields: JSON.stringify({ [fieldId]: val }) },
    });
    const entity = await extractEntity(h.prisma, { entityType: "record", entityId: rid, version: 1n }, 50);
    await applyUpsert(store, entity, { workspaceId: "ws_default", mode: "cloud", provider });
  }
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s7-conc-");
  store = h.openStore("concurrency", true);
  provider = delayedCloudProvider(3, (t) => (t.includes("ALPHA") || t === COMMON ? 40 : 1)) as unknown as EmbeddingProvider;

  await querySeed.createUsers(h.prisma, [{ id: UA }, { id: UB }, { id: "owner", email: "conc_owner@x.com" }]);

  await mkTable(TA, "conc_fa", [["conc_r_a", `${WORD_A} ${COMMON}`]]);
  await mkTable(TB, "conc_fb", [["conc_r_b", `${WORD_B} ${COMMON}`]]);

  await querySeed.createNavNodes(h.prisma, [
    { id: `nav_base_${TA}_b`, kind: "base", resourceType: "base", resourceId: `${TA}_b`, parentId: null },
    { id: NA, kind: "table", resourceType: "table", resourceId: TA, parentId: `nav_base_${TA}_b` },
    { id: `nav_base_${TB}_b`, kind: "base", resourceType: "base", resourceId: `${TB}_b`, parentId: null },
    { id: NB, kind: "table", resourceType: "table", resourceId: TB, parentId: `nav_base_${TB}_b` },
  ]);
  // 互斥 scope：UA 只见 TA、UB 只见 TB。
  await querySeed.createPolicies(h.prisma, [
    { id: "conc_p_a", nodeId: NA, subjectType: "user", subjectId: UA, actions: "r" },
    { id: "conc_p_b", nodeId: NB, subjectType: "user", subjectId: UB, actions: "r" },
  ]);
}, 120000);

afterAll(async () => {
  store?.close();
  await h.cleanup();
});

async function depsFor(userId: string): Promise<QueryRuntimeDeps> {
  const { deps } = await buildQueryRuntime(userId, "all", {
    prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
    jwtSecret: "x", store, provider,
  });
  return deps;
}

async function idsFor(userId: string, q: string): Promise<string[]> {
  const res = await executeUnifiedSearch(await depsFor(userId), { q, mode: "auto", type: "all", limit: 20 });
  return res.items.filter((i) => i.type === "record").map((i) => i.entityId).sort();
}

describe("共享单例连接 TEMP TABLE 并发隔离（硬红线 2）", () => {
  it("两用户互斥 scope 并发同查：各自只见自家表记录，不串对方 scope", async () => {
    // 重复多轮放大交错：A 的 embed 延迟更长，B 必在 A 等待期间完成物化/召回。
    for (let round = 0; round < 5; round += 1) {
      const [aOwn, bOwn, aCommon, bCommon] = await Promise.all([
        idsFor(UA, WORD_A), // A 只见 r_a
        idsFor(UB, WORD_B), // B 只见 r_b
        idsFor(UA, COMMON), // 共有词：A 仍只见 r_a（r_b 被 scope 挡）
        idsFor(UB, COMMON), // 共有词：B 仍只见 r_b
      ]);
      expect(aOwn, `round ${round} A own`).toEqual(["conc_r_a"]);
      expect(bOwn, `round ${round} B own`).toEqual(["conc_r_b"]);
      expect(aCommon, `round ${round} A common`).toEqual(["conc_r_a"]);
      expect(bCommon, `round ${round} B common`).toEqual(["conc_r_b"]);
    }
  });

  it("越权词对侧实体零泄漏（auto hybrid：vec KNN 无距离阈值或返回本侧无关近邻，但对侧实体必被 scope 挡住）", async () => {
    // 注意：vec KNN 总会返回 scope 内 top-k 最近邻（无相似度阈值），故 A 查 WORD_B 可能召回
    // 自家 r_a（无关近邻），但安全隔离断言的是：对侧表的 r_b/r_a 永不进本侧结果。
    const [aHits, bHits] = await Promise.all([
      idsFor(UA, WORD_B),
      idsFor(UB, WORD_A),
    ]);
    expect(aHits).not.toContain("conc_r_b");
    expect(bHits).not.toContain("conc_r_a");

    // 纯关键词路（mode=fts，无 vec 近邻噪音）：对侧独有词在本侧零命中。
    const aKw = await executeUnifiedSearch(await depsFor(UA), { q: WORD_B, mode: "fts", type: "all", limit: 20 });
    const bKw = await executeUnifiedSearch(await depsFor(UB), { q: WORD_A, mode: "fts", type: "all", limit: 20 });
    expect(aKw.items.map((i) => i.entityId)).toEqual([]);
    expect(bKw.items.map((i) => i.entityId)).toEqual([]);
  });
});
