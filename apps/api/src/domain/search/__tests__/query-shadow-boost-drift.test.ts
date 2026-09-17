// M5/S11 advisory 收口：标题 boost 对 shadow drift 的确定性结论（纯测试，不改闸门口径）。
//
// 背景：`queryShadow.ts` 定义 `driftCount = overDeny + overAllow + (orderDiffer ? 1 : 0)`，
// 即 ORDER 差异计入 drift；`GX_M5_SHADOW_STRICT=on` 时可比集 drift>0 -> 500。S11 的标题 boost
// 会重排新链得分，必须给出"是否会把 boost 前 orderDiffer=false 的可比场景翻成 true"的**实测**结论。
//
// 本文件三段证据（由纯到真）：
//   A. 合成输入（手写 hits + 合成 legacy），real rrf + real compareSearchShadow：demo 翻转成立。
//   B. 真 recall 数据（真 search.db 的 LIKE 结果序）+ real rrf + real compareSearchShadow：
//      在真实召回数据上同样翻转成立（reachability）。
//   C. 前置条件为何现实可达：旧链 record 序 = createdAt asc、LIKE 路无 ORDER BY 返回按 rowid
//      （=插入序=createdAt asc）——二者在"单表/单批"下天然一致，boost 一旦重排即翻转。
//
// 结论见 docs/baseline/2026-09-17-m5-gate.md §3.5：**会翻转**（orderDiffer=false -> true）。
// 2026-09-17 总监裁决：strict 判据 = `setDriftCount`（集合漂移 overDeny+overAllow）；ORDER 降为观测。
// 故本文件在断言"ORDER 翻转"的同时，锁死 `setDriftCount===0`（strict 不再失败）——集合保护未被弱化
// 的反证见 __tests__/queryShadow.test.ts 的 overDeny/overAllow 例与 query-v1-route.test.ts 的 HTTP 500。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { compareSearchShadow } from "../queryShadow.js";
import { reciprocalRankFusion, type FusionInput, type RouteHit } from "../rrf.js";
import { runRecall } from "../queryRecall.js";
import { buildSearchQueryPlan } from "../queryPlan.js";
import type { UnifiedSearchItem } from "../queryTypes.js";
import type { LegacySearchResult } from "../legacySearch.js";
import type { SearchStore } from "../searchStore.js";

const Q = "季度报告"; // 4 码元（fts 形态示例用）
const Q_SHORT = "报告"; // 2 码元（真 recall 段用 like 形态）

/** 最小 UnifiedSearchItem（compareSearchShadow 只读 type/entityId）。 */
function item(type: "record" | "doc" | "canvas", entityId: string): UnifiedSearchItem {
  return {
    type, entityId, nodeId: `nav_${type}_${entityId}`, title: entityId, snippet: "",
    score: 0, matchedVia: [], chunkSeq: null, matchedField: null,
  };
}

/** 合成 legacy：records 段（旧链 record 序 = createdAt asc）——仅合成输入段使用，非 E2E 真跑。 */
function legacyRecords(ids: readonly string[]): LegacySearchResult {
  return {
    records: ids.map((id) => ({
      type: "record", baseId: "b", baseName: "库", tableId: "t", tableName: "表",
      recordId: id, title: id, snippet: "", matchedField: "f",
    })),
    docs: [],
    boundedPreview: true,
    previewLimit: 2000,
  };
}

/** 合成 legacy：docs 段（旧链 doc 序 = updatedAt desc；此处按给定序合成）。 */
function legacyDocs(ids: readonly string[]): LegacySearchResult {
  return {
    records: [],
    docs: ids.map((id) => ({
      type: "doc" as const, kbId: "kb", kbName: "知识库", docId: id, title: id, snippet: "",
    })),
    boundedPreview: true,
    previewLimit: 2000,
  };
}

function order(cands: ReturnType<typeof reciprocalRankFusion>): string[] {
  return cands.map((c) => c.entityId);
}

// ---------------------------------------------------------------------------
// A. 合成输入：real rrf + real compareSearchShadow（hand-built hits / legacy）
// ---------------------------------------------------------------------------
describe("A. 合成输入：标题 boost 会把 orderDiffer 由 false 翻 true（real rrf + real shadow）", () => {
  // 三实体可比集（都走 fts 一路，comparable=true）。命中序 a,b,c；b 标题精确命中查询。
  const hits: RouteHit[] = [
    { entityType: "record", entityId: "a", rank: 1, title: "无关标题" },
    { entityType: "record", entityId: "b", rank: 2, title: Q }, // 标题精确命中
    { entityType: "record", entityId: "c", rank: 3, title: "无关标题" },
  ];
  const input: FusionInput = { route: "fts", hits };
  const legacy = legacyRecords(["a", "b", "c"]); // 旧链序 = a,b,c（合成；对齐 RRF 无加成序）

  const noBoost = reciprocalRankFusion([input]);
  const boosted = reciprocalRankFusion([input], { titleQuery: Q });

  it("前置条件成立：boost 前新链序 == 旧链序（orderDiffer=false, setDriftCount=0, driftCount=0）", () => {
    expect(order(noBoost)).toEqual(["a", "b", "c"]);
    const rep = compareSearchShadow("fts", noBoost.map((c) => item("record", c.entityId)), legacy, true);
    expect(rep.comparable).toBe(true);
    expect(rep.orderDiffer).toBe(false);
    expect(rep.setDriftCount).toBe(0);
    expect(rep.driftCount).toBe(0);
  });

  it("施加标题精确加成后：新链被重排为 b,a,c；orderDiffer=true 但 setDriftCount=0 -> strict 判据下不失败", () => {
    expect(order(boosted)).toEqual(["b", "a", "c"]); // b 由 rank2 被加成顶到首位
    const rep = compareSearchShadow("fts", boosted.map((c) => item("record", c.entityId)), legacy, true);
    expect(rep.comparable).toBe(true);
    expect(rep.orderDiffer).toBe(true);
    expect(rep.overDeny).toHaveLength(0); // 集合未变（boost 不加/删候选）
    expect(rep.overAllow).toHaveLength(0);
    expect(rep.setDriftCount).toBe(0); // 集合零漂移 -> strict 唯一判据为 0（不失败）
    expect(rep.driftCount).toBe(1); // 观测总量仍含 ORDER
    // 复刻闸门判据（queryShadow strict 分支）：setDriftCount>0 才失败。
    expect(rep.setDriftCount > 0).toBe(false);
  });

  it("仅加成不同：ORDER 翻转不改变集合判据（setDriftCount 恒 0，driftCount 随 ORDER 变）", () => {
    const before = compareSearchShadow("fts", noBoost.map((c) => item("record", c.entityId)), legacy, true);
    const after = compareSearchShadow("fts", boosted.map((c) => item("record", c.entityId)), legacy, true);
    expect(before.driftCount).toBe(0);
    expect(after.driftCount).toBe(1);
    expect(before.setDriftCount).toBe(0); // strict 判据前后恒 0
    expect(after.setDriftCount).toBe(0);
    // 与加成大小无关：只把 titleQuery 换成不命中的词，顺序即复原 -> 证明是加成（非其它因素）导致。
    const untouched = reciprocalRankFusion([input], { titleQuery: "毫不相关词" });
    expect(order(untouched)).toEqual(["a", "b", "c"]);
    expect(compareSearchShadow("fts", untouched.map((c) => item("record", c.entityId)), legacy, true).driftCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B. 真 recall 数据（真 search.db LIKE 序）+ real rrf + real compareSearchShadow
// ---------------------------------------------------------------------------
let h: QueryHarness;
let store: SearchStore;

const N_A = "nav_doc_shadowboost_a";
const N_B = "nav_doc_shadowboost_b";
const N_C = "nav_doc_shadowboost_c";
const D_A = "shadowboost_a";
const D_B = "shadowboost_b"; // 标题恰为 Q_SHORT
const D_C = "shadowboost_c";

function insertDoc(rowid: number, entityId: string, nodeId: string, title: string): void {
  store.db.prepare(
    `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,fieldId,title,seq,version,length,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(BigInt(rowid), `chk_${rowid}`, "doc", entityId, nodeId, "ws_default", "identity", null, title, 0, 0, 0, "2026-01-01T00:00:00.000Z");
  store.db.prepare("INSERT INTO fts_chunks(rowid, title, body, chunkId, nodeId, entityType) VALUES(?,?,?,?,?,?)")
    .run(BigInt(rowid), title, Q_SHORT, `chk_${rowid}`, nodeId, "doc");
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s11-shadowboost-");
  store = h.openStore("s11shadowboost", false);
  // rowid 1/2/3 = A/B/C；LIKE 路无 ORDER BY -> 按 rowid（插入序）返回 [A,B,C]。
  insertDoc(1, D_A, N_A, "甲文档"); // 命中：body 含 Q_SHORT；标题不命中
  insertDoc(2, D_B, N_B, Q_SHORT); // 命中：标题精确 == Q_SHORT
  insertDoc(3, D_C, N_C, "乙文档");
}, 120000);

afterAll(async () => {
  store?.close();
  await h?.cleanup();
});

describe("B. 真 recall 数据：同一翻转在真实 LIKE 召回上成立（reachability）", () => {
  function recallHits(): { hits: RouteHit[]; baseOrder: string[]; boostedOrder: string[] } {
    const plan = buildSearchQueryPlan(Q_SHORT, { mode: "fts", type: "all", limit: 20, perRoute: 50 });
    const recall = runRecall(store.db, plan, [N_A, N_B, N_C], [], {});
    const hits: RouteHit[] = recall.like.map((r) => ({
      entityType: r.entityType, entityId: r.entityId, rank: r.rank, title: r.title,
    }));
    const base = reciprocalRankFusion([{ route: "like", hits }]);
    const boosted = reciprocalRankFusion([{ route: "like", hits }], { titleQuery: Q_SHORT });
    return { hits, baseOrder: order(base), boostedOrder: order(boosted) };
  }

  it("真 LIKE 召回序 [A,B,C]；无加成时与旧链序一致（drift 0），加成后重排为 [B,A,C]（ORDER 漂移但集合判据 0）", () => {
    const { hits, baseOrder, boostedOrder } = recallHits();
    expect(hits.map((x) => x.entityId)).toEqual([D_A, D_B, D_C]); // LIKE 无 ORDER BY -> rowid/插入序
    expect(baseOrder).toEqual([D_A, D_B, D_C]);
    expect(boostedOrder).toEqual([D_B, D_A, D_C]); // 标题精确的 B 被加成顶到首位

    // 旧链序 = 插入序（合成 legacy docs，等于真链无加成序）——证明前置条件在真实召回上可达。
    const legacy = legacyDocs([D_A, D_B, D_C]);
    const before = compareSearchShadow("like", baseOrder.map((id) => item("doc", id)), legacy, true);
    const after = compareSearchShadow("like", boostedOrder.map((id) => item("doc", id)), legacy, true);
    expect(before.comparable).toBe(true);
    expect(before.orderDiffer).toBe(false);
    expect(before.setDriftCount).toBe(0);
    expect(before.driftCount).toBe(0);
    expect(after.orderDiffer).toBe(true);
    expect(after.setDriftCount).toBe(0); // 集合零漂移 -> strict 不失败（ORDER 降观测）
    expect(after.driftCount).toBe(1);
  });
});
