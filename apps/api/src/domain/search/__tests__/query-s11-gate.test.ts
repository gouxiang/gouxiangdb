// M5/S11 门证据（测试）：三路召回 EXPLAIN 收敛先于产出 + SQL 计数常量化（真 search.db，可加载 vec0）。
//
// 依据 M5-implementation-plan §4.5 步骤 4/4a/4c + 步骤 5、:449 EXPLAIN 铁律、S11 行（测试+证据）。
// 本文件把"证据文档里贴的计划文本/计数"落成【可自动回归的断言】：文档只是快照，真源是这里的断言。
//
// 两件事：
//   A. EXPLAIN QUERY PLAN 三路证据：FTS / LIKE / vec KNN 的计划都出现 temp_scope 收敛，
//      vec 的 rowid IN (allowed) 下推为 LIST SUBQUERY —— 收敛发生在结果产出之前。
//   B. SQL 计数常量化：一次 runRecall 的语句数与 scope 节点数/主体数解耦（常量 + 仅按 499/批
//      的亚线性分批），无任何 per-node/per-subject 语句。
//
// 说明：M1 的 explainSql.ts/sidecarQuery.ts 面向 sidecar COUNT/keyset 的 SQL 事实源，其 countSql()
// 产的是 SQL 文本而非"执行了几条语句"的计数器，与本处口径不同，故本处按 M4 既有"计数包装"先例
// （query-count.test.ts 的 Proxy 计数）对 SearchDbLike 做最小计数包装，不另造 SQL 设施、不改生产。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { runRecall, toQueryBlob } from "../queryRecall.js";
import { buildSearchQueryPlan } from "../queryPlan.js";
import { vecBlob } from "../vecLoader.js";
import type { SearchDbLike } from "../queryTypes.js";
import type { SearchStore } from "../searchStore.js";

let h: QueryHarness;
let store: SearchStore;

const N_A = "nav_table_s11gate_a";
const QVEC = new Float32Array([1, 0, 0, 0]);
const FTS_Q = "季度报告"; // 4 码元 -> fts
const LIKE_Q = "报告"; // 2 码元 -> like

/** scope 节点名批次生成（仅用于计数，不落库）。 */
function nodes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `nav_table_s11gate_${i}`);
}
function grants(n: number): Array<{ tableNodeId: string; fieldId: string }> {
  return Array.from({ length: n }, (_, i) => ({ tableNodeId: `nav_table_s11gate_${i}`, fieldId: `f_${i}` }));
}

/** 计数包装：记录每条经 prepare/exec 的 SQL（规范化临时表名后缀 + 批量 VALUES 占位数），透传结果。 */
function countingDb(inner: SearchDbLike): { db: SearchDbLike; log: string[] } {
  const log: string[] = [];
  const norm = (sql: string): string =>
    sql
      .replace(/temp_scope_[0-9a-f]+/g, "temp_scope_X")
      .replace(/temp_field_grant_[0-9a-f]+/g, "temp_field_grant_X")
      .replace(/\s+/g, " ")
      .trim()
      // 批量 INSERT 的占位组数随批大小变化（非 per-node 语句），形态归一后比较"语句种类"。
      .replace(/VALUES .*$/, "VALUES (...)");
  const db: SearchDbLike = {
    prepare(sql: string) {
      log.push(norm(sql));
      return inner.prepare(sql);
    },
    exec(sql: string) {
      log.push(norm(sql));
      inner.exec(sql);
    },
  };
  return { db, log };
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s11-gate-");
  store = h.openStore("s11gate", true);
  expect(store.ensureVecChunks(4)).toBe(true);
  // 每表 1 行（EXPLAIN 只需 schema，但给点数据更贴近真实计划）。
  store.db.prepare(
    `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,fieldId,title,seq,version,length,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(BigInt(1), "s11g_c1", "doc", "s11g_d1", N_A, "ws_default", "identity", null, FTS_Q, 0, 0, 0, "2026-01-01T00:00:00.000Z");
  store.db.prepare("INSERT INTO fts_chunks(title, body, chunkId, nodeId, entityType) VALUES(?,?,?,?,?)")
    .run(FTS_Q, `正文 ${FTS_Q}`, "s11g_c1", N_A, "doc");
  store.db.prepare("INSERT INTO vec_chunks(rowid, embedding, entityType) VALUES(?,?,?)")
    .run(BigInt(1), vecBlob(QVEC), BigInt(2));
}, 120000);

afterAll(async () => {
  store?.close();
  await h?.cleanup();
});

describe("S11-A EXPLAIN：三路召回收敛先于产出（temp_scope/allowed 在结果产出前）", () => {
  it("FTS 路计划含 temp_scope 收敛与 fts_chunks 扫描", () => {
    const plan = buildSearchQueryPlan(FTS_Q, { mode: "fts", type: "all", limit: 20, perRoute: 50 });
    const recall = runRecall(store.db, plan, [N_A], [], { explain: true });
    const text = recall.plans.fts.join("\n");
    expect(text).toMatch(/temp_scope_/); // 表级收敛（allowed CTE）参与计划
    expect(text).toMatch(/fts_chunks/); // FTS 虚表参与
    expect(recall.ran.fts).toBe(true);
  });

  it("LIKE 路计划含 temp_scope 收敛（COVERING INDEX）与 field_grant 收敛子查询", () => {
    const plan = buildSearchQueryPlan(LIKE_Q, { mode: "fts", type: "all", limit: 20, perRoute: 50 });
    const recall = runRecall(store.db, plan, [N_A], [], { explain: true });
    const text = recall.plans.like.join("\n");
    expect(text).toMatch(/temp_scope_/); // 表级收敛临时表走覆盖索引
    expect(text).toMatch(/CORRELATED SCALAR SUBQUERY/); // field_grant 三分支收敛子查询参与
    expect(recall.ran.like).toBe(true);
  });

  it("vec 路计划：rowid IN (allowed) 下推为 LIST SUBQUERY，收敛进 KNN 扫描", () => {
    const plan = buildSearchQueryPlan(FTS_Q, { mode: "vector", type: "all", limit: 20, perRoute: 50 });
    const recall = runRecall(store.db, plan, [N_A], [], { queryVector: toQueryBlob(QVEC), explain: true });
    const text = recall.plans.vec.join("\n");
    expect(text).toMatch(/vec_chunks/);
    expect(text).toMatch(/LIST SUBQUERY/); // 白名单作为 KNN 扫描子查询约束（非应用层后置过滤）
    expect(text).toMatch(/temp_scope_/);
    expect(recall.ran.vec).toBe(true);
  });
});

describe("S11-B SQL 计数常量化：语句数与 scope 节点数/主体数解耦", () => {
  const plan = buildSearchQueryPlan(FTS_Q, { mode: "fts", type: "all", limit: 20, perRoute: 50 });

  function logFor(scope: string[], grantRows: Array<{ tableNodeId: string; fieldId: string }>): string[] {
    const { db, log } = countingDb(store.db as unknown as SearchDbLike);
    runRecall(db, plan, scope, grantRows, {});
    return log;
  }

  it("同一批内 scope 1 与 450 节点：语句数完全相同、SQL 形态集逐条一致（无 per-node 语句）", () => {
    const a = logFor(nodes(1), []);
    const b = logFor(nodes(450), []);
    expect(a.length).toBe(b.length);
    expect([...b].sort()).toEqual([...a].sort());
    // 常量构成：CREATE TEMP ×2 + INSERT scope ×1 + 召回 ×1 + DROP TEMP ×2 = 6。
    expect(a.length).toBe(6);
  });

  it("grant 行数 0 与 450（同批）：仅多一条批量 INSERT，语句种类与召回不变（与 mask 字段数解耦）", () => {
    const g0 = logFor(nodes(3), []);
    const g450 = logFor(nodes(3), grants(450));
    expect(g450.length).toBe(g0.length + 1); // 恰多一条 temp_field_grant 批量 INSERT
    expect(g0.filter((s) => /INSERT INTO temp_field_grant_/.test(s))).toHaveLength(0);
    expect(g450.filter((s) => /INSERT INTO temp_field_grant_/.test(s))).toHaveLength(1);
    // 450 行仍在同一批：与 3 行时语句数、语句种类完全一致（不随 mask 字段数增长）。
    expect(logFor(nodes(3), grants(450))).toEqual(g450);
    expect(logFor(nodes(3), grants(3)).length).toBe(g450.length);
  });

  it("超一批仅按 ⌈n/499⌉ 亚线性增一条 INSERT：500->2 批、1000->3 批，其余语句恒定", () => {
    const c500 = logFor(nodes(500), []);
    const c1000 = logFor(nodes(1000), []);
    expect(c500.length).toBe(7); // 2 批 INSERT scope
    expect(c1000.length).toBe(8); // 3 批 INSERT scope
    expect(c1000.length - c500.length).toBe(1);
    // 除 INSERT 外，其余语句（建表/召回/清理）在所有规模下同为 5 条常量。
    const nonInsert = (log: string[]) => log.filter((s) => !/^INSERT INTO temp_scope_/.test(s)).length;
    expect(nonInsert(c500)).toBe(5);
    expect(nonInsert(c1000)).toBe(5);
  });

  it("召回语句本身恒为 1 条（不与节点数/主体数成比例）", () => {
    const count = (scope: string[]) => logFor(scope, []).filter((s) => /fts_chunks MATCH/.test(s)).length;
    expect(count(nodes(1))).toBe(1);
    expect(count(nodes(1000))).toBe(1);
  });
});
