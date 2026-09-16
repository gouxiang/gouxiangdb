// M5/S7 S11 前移子验证：vec0 KNN × 白名单收敛的可接受性（真机 sqlite-vec，非推断）。
//
// 派工红线：禁止"先全量 KNN top-k 再在应用层过滤"——那会让更近的越权行占满 k，导致白名单
// 内行被漏召回。本测试在真 vec0 虚表上构造极端反例：
//   - 100 个 embedding 距查询向量极近（L2 ≈ 0.001..0.1）但 nodeId=T_deny（不在 scope 白名单）；
//   - 3 个 embedding 距查询向量很远（L2 ≈ 5/6/7）但 nodeId=T_allow（scope 唯一白名单）。
// 若 rowid IN (allowed) 不是 KNN 扫描约束而是"top-k 后过滤"，k=10 时 100 个近距 deny 会占满 k，
// 白名单 3 个 allow 全漏。实测（sqlite-vec v0.1.9）三档 k=10/100/1000 都稳定只返回白名单 3 行，
// 证明收敛发生在 KNN 虚拟表扫描约束内，故无需实现 §4.5 的 metadata hash(rootNode) 分桶退路。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { runRecall, toQueryBlob } from "../queryRecall.js";
import { buildFieldGrantRows } from "../fieldGrant.js";
import { buildSearchQueryPlan } from "../queryPlan.js";
import { vecBlob } from "../vecLoader.js";
import type { SearchStore } from "../searchStore.js";

let h: QueryHarness;
let store: SearchStore;

const T_ALLOW = "s11_table_allow";
const T_DENY = "s11_table_deny";
const N_ALLOW = `nav_table_${T_ALLOW}`;
const DIM = 4;
const N_DENY = 100;
const N_ALLOW_ROWS = 3;

/** 查询向量：沿 x 轴单位向量。 */
const QVEC = new Float32Array([1, 0, 0, 0]);

function nearDeny(i: number): Float32Array {
  // 距 QVEC ≈ 0.001*i（i=1..100 -> 0.001..0.1），全部极近；第一分量补偿保模长近似 1。
  const d = 0.001 * i;
  return new Float32Array([Math.sqrt(Math.max(0, 1 - d * d)), d, 0, 0]);
}
function farAllow(j: number): Float32Array {
  // 距 QVEC ≈ 5+j（j=0,1,2 -> 5,6,7），很远。
  const d = 5 + j;
  return new Float32Array([Math.sqrt(Math.max(0, 1 - d * d)), d, 0, 0]);
}

function insertChunk(rowid: number, nodeId: string, entityId: string): void {
  store.db.prepare(
    `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,fieldId,title,seq,version,length,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    BigInt(rowid), `chk_${rowid}`, "record", entityId, nodeId, "ws_default",
    "identity", null, entityId, 0, 0, 0, "2026-01-01T00:00:00.000Z",
  );
  // fts_chunks 回查 body 用（identity title 入 title 列；body 可空）。
  store.db.prepare("INSERT INTO fts_chunks(title, body, chunkId, nodeId, entityType) VALUES(?,?,?,?,?)")
    .run(entityId, "", `chk_${rowid}`, nodeId, "record");
}

describe("S11 vec0 KNN × 白名单 rowid IN 收敛（真机 sqlite-vec）", () => {
  beforeAll(async () => {
    h = await makeQueryHarness("gx-m5-s7-s11-");
    store = h.openStore("s11", true);
    store.ensureVecChunks(DIM);
    const insVec = store.db.prepare("INSERT INTO vec_chunks(rowid, embedding, entityType) VALUES(?,?,?)");
    const tx = store.db.transaction((rows: Array<[number, Float32Array]>) => {
      for (const [rowid, v] of rows) insVec.run(BigInt(rowid), vecBlob(v), BigInt(1)); // 1=record
    });
    const vectors: Array<[number, Float32Array]> = [];
    // 100 个近距越权行 rowid 1..100，nodeId=T_deny（不在 scope）。
    for (let i = 1; i <= N_DENY; i += 1) {
      insertChunk(i, T_DENY, `deny_${i}`);
      vectors.push([i, nearDeny(i)]);
    }
    // 3 个远距白名单行 rowid 101..103，nodeId=T_allow（scope 唯一白名单）。
    for (let j = 0; j < N_ALLOW_ROWS; j += 1) {
      const rowid = N_DENY + 1 + j;
      insertChunk(rowid, N_ALLOW, `allow_${j}`);
      vectors.push([rowid, farAllow(j)]);
    }
    tx(vectors);
  }, 120000);

  afterAll(async () => {
    store?.close();
    await h?.cleanup();
  });

  for (const k of [10, 100, 1000]) {
    it(`k=${k}：即使近距越权行远超 k，召回仍只含白名单 3 行（收敛独立于 k 截断）`, () => {
      const plan = buildSearchQueryPlan("任意非空查询词", { mode: "vector", type: "all", limit: 20, perRoute: k });
      const effective = { ...plan, fts: null, like: null }; // 对齐 query 编排强制 vector 成功形态
      // scope 只含 T_allow；无 mask（grantRows 空 -> NOT EXISTS 分支放行 scope 内全部 identity）。
      const grantRows = buildFieldGrantRows(new Set([N_ALLOW]), {});
      const recall = runRecall(store.db, effective, [N_ALLOW], grantRows, { queryVector: toQueryBlob(QVEC) });
      const ids = recall.vec.map((r) => r.entityId).sort();
      expect(recall.ran.vec).toBe(true);
      expect(ids).toEqual(["allow_0", "allow_1", "allow_2"]);
      expect(recall.vec.some((r) => r.nodeId === T_DENY)).toBe(false);
    });
  }

  it("EXPLAIN：白名单作为 LIST SUBQUERY 收敛进 KNN 扫描，temp_scope 走覆盖索引（非应用层后置过滤）", () => {
    const plan = buildSearchQueryPlan("任意非空查询词", { mode: "vector", type: "all", limit: 20, perRoute: 10 });
    const effective = { ...plan, fts: null, like: null };
    const recall = runRecall(store.db, effective, [N_ALLOW], [], { queryVector: toQueryBlob(QVEC), explain: true });
    const text = recall.plans.vec.join("\n");
    expect(text).toMatch(/vec_chunks/);
    expect(text).toMatch(/LIST SUBQUERY/); // rowid IN (SELECT rid FROM allowed) 下推为 KNN 扫描子查询
    expect(text).toMatch(/temp_scope_/); // scope 收敛临时表
  });

  it("反面对照：scope 放开到 T_deny 时近距 deny 行可被召回（证明上述收敛确由 scope 而非距离阈值导致）", () => {
    const plan = buildSearchQueryPlan("任意非空查询词", { mode: "vector", type: "all", limit: 20, perRoute: 10 });
    const effective = { ...plan, fts: null, like: null };
    const recall = runRecall(store.db, effective, [N_ALLOW, T_DENY], [], { queryVector: toQueryBlob(QVEC) });
    expect(recall.vec.some((r) => r.nodeId === T_DENY)).toBe(true);
    expect(recall.vec.length).toBe(10); // k=10 生效，但两表都在 scope 内时近距 deny 占据
  });
});
