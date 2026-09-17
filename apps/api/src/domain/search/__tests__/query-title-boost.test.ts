// M5/S11 标题 boost 接线集成测试（真 search.db + 真 executeUnifiedSearch 九步，零 IO mock 仅 scope/decide/hydrate）。
//
// 目的：证明 §4.5 步骤 5 的标题 boost 不只存在于 rrf 纯函数，而是经 query.ts 把 chunk title 与
// plan.query 接进融合打分，改变了新链 items 的 score 与排序（旧 /api/search 不受影响——那是另一条链）。
//
// 断言口径（对路序不敏感，抗 FTS/LIKE 名次抖动）：
//   - 单路（fts 或 like）无加成时的分数上界 = 1/(k+1) = 1/61 ≈ 0.016393；
//   - 标题精确命中的实体 score 必 > 1/61（证明 boost 确已计入）；
//   - 仅正文命中的实体 score 必 <= 1/61（未加成）；
//   - 且精确命中实体排在首位。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { executeUnifiedSearch } from "../query.js";
import type {
  QueryRuntimeDeps, ScopeLike, EntityRef, HydratedEntity,
} from "../queryTypes.js";
import type { SearchStore } from "../searchStore.js";

let h: QueryHarness;
let store: SearchStore;

const N_TITLE = "nav_doc_s11boost_title";
const N_BODY = "nav_doc_s11boost_body";
const N_TITLE_SHORT = "nav_doc_s11boost_title_short";
const N_BODY_SHORT = "nav_doc_s11boost_body_short";
const D_TITLE = "s11boost_title_exact";       // 标题「季度报告」（长词精确）
const D_BODY = "s11boost_body_only";          // 仅正文含「季度报告」
const D_TITLE_SHORT = "s11boost_title_short"; // 标题恰「报告」（短词精确）
const D_BODY_SHORT = "s11boost_body_short";   // 仅正文含「报告」

const CEIL_NO_BOOST = 1 / 61; // 单路 rank1 上界

function insertChunk(rowid: number, entityId: string, nodeId: string, title: string, body: string): void {
  store.db.prepare(
    `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,fieldId,title,seq,version,length,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(BigInt(rowid), `chk_${rowid}`, "doc", entityId, nodeId, "ws_default", "identity", null, title, 0, 0, 0, "2026-01-01T00:00:00.000Z");
  store.db.prepare("INSERT INTO fts_chunks(rowid, title, body, chunkId, nodeId, entityType) VALUES(?,?,?,?,?,?)")
    .run(BigInt(rowid), title, body, `chk_${rowid}`, nodeId, "doc");
}

/** 最小可用 deps：真 store；scope/decide/hydrate 为确定性 stub（不涉权限语义）。 */
function deps(): QueryRuntimeDeps {
  const scope: ScopeLike = {
    nodeIds: [N_TITLE, N_BODY, N_TITLE_SHORT, N_BODY_SHORT],
    truncated: false, policyVersion: 7, maskedTableFields: {},
  };
  return {
    store: store as unknown as QueryRuntimeDeps["store"],
    vector: null, // fts/like 两路；不走向量
    async decideNodeIds(nodeIds) { return new Set(nodeIds); },
    async hydrate(refs: EntityRef[]): Promise<HydratedEntity[]> {
      return refs.map((r) => ({
        type: r.type, entityId: r.entityId, title: r.best.title, snippet: r.best.body,
        context: {}, matchedField: null,
      }));
    },
    async resolveScope() { return scope; },
  };
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s11-boost-");
  store = h.openStore("s11boost", false);
  // 长词（≥3 码元）与短词（2 码元）各一对：并列起 fts 与 like 两形态。
  insertChunk(1, D_TITLE, N_TITLE, "季度报告", "占位正文");
  insertChunk(2, D_BODY, N_BODY, "其它文档", "这里多次出现季度报告 季度报告 季度报告");
  insertChunk(3, D_TITLE_SHORT, N_TITLE_SHORT, "报告", "占位正文");
  insertChunk(4, D_BODY_SHORT, N_BODY_SHORT, "无关标题", "正文里也有报告 报告 报告");
}, 120000);

afterAll(async () => {
  store?.close();
  await h?.cleanup();
});

describe("executeUnifiedSearch 标题 boost 接入（§4.5 步骤 5）", () => {
  it("fts 路：标题精确命中实体被 boost 计入（score>1/61）且排首位；仅正文命中未加成", async () => {
    const res = await executeUnifiedSearch(deps(), { q: "季度报告", mode: "fts" });
    expect(res.mode).toBe("fts");
    const titleHit = res.items.find((i) => i.entityId === D_TITLE)!;
    const bodyHit = res.items.find((i) => i.entityId === D_BODY)!;
    expect(titleHit).toBeTruthy();
    expect(bodyHit).toBeTruthy();
    expect(titleHit.score).toBeGreaterThan(CEIL_NO_BOOST); // 加成确已计入
    expect(bodyHit.score).toBeLessThanOrEqual(CEIL_NO_BOOST + 1e-12); // 无加成
    expect(res.items[0].entityId).toBe(D_TITLE); // 精确命中排首位
  });

  it("like 路（短词）：同样把标题精确命中 boost 到正文命中之上", async () => {
    const res = await executeUnifiedSearch(deps(), { q: "报告", mode: "fts" });
    expect(res.mode).toBe("like");
    // 标题恰为「报告」的实体获得精确加成；其余（含标题「季度报告」只含子串但非前缀）不加成。
    const exactShort = res.items.find((i) => i.entityId === D_TITLE_SHORT)!;
    const subString = res.items.find((i) => i.entityId === D_TITLE)!;
    const bodyOnly = res.items.find((i) => i.entityId === D_BODY_SHORT)!;
    expect(exactShort.score).toBeGreaterThan(CEIL_NO_BOOST);
    expect(subString.score).toBeLessThanOrEqual(CEIL_NO_BOOST + 1e-12);
    expect(bodyOnly.score).toBeLessThanOrEqual(CEIL_NO_BOOST + 1e-12);
    expect(res.items[0].entityId).toBe(D_TITLE_SHORT);
  });

  it("无标题命中的查询：boost 不触发，分数回到纯 RRF 上界内（默认零行为变化）", async () => {
    const res = await executeUnifiedSearch(deps(), { q: "占位正文", mode: "fts" });
    for (const it of res.items) {
      expect(it.score).toBeLessThanOrEqual(CEIL_NO_BOOST + 1e-12);
    }
  });
});
