// M5/S7 scope x chunk join 语义对拍 + 三分支授权 + 表级越权 + mask 值零泄漏（AC-M5-2 基本盘）。
// 真迁移主库 + 真 search.db + 真实 M4 scope/decide（不 mock 权限）；off 形态不走向量。
//
// 覆盖派工清单：
//  - scope x chunk join 逐实体 decide 零分叉（record nodeId=tableNodeId，kinds='table'）；
//  - 三分支：①identity 恒可见 ②无 mask 表全 field 可见（错误二分支下会失败的回归）③有 mask 仅白名单；
//  - 表级越权整实体 identity+field 全缺席；
//  - mask 字段独有值不入任何一路召回候选与 snippet/matchedField。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, querySeed, type QueryHarness } from "./queryHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { executeUnifiedSearch } from "../query.js";
import { resolveSubject } from "../../authz/subjects.js";
import { decideMany } from "../../authz/engine.js";
import { makeCreatedByResolver } from "../../authz/adapter.js";
import type { SearchStore } from "../searchStore.js";
import type { AuthzClient } from "../../authz/types.js";
import type { QueryRuntimeDeps, UnifiedSearchResponse } from "../queryTypes.js";
import type { EntityTypeFilter } from "../queryPlan.js";

let h: QueryHarness;
let store: SearchStore;
let buildDeps: (userId: string, type?: EntityTypeFilter) => Promise<QueryRuntimeDeps>;

const U = "u_query";
// 三张表：T0 无 mask（直授 r）、T1 有 mask（仅白名单字段）、T2 表级越权（不授 U）。
const T0 = "q_table_nomask";
const T1 = "q_table_mask";
const T2 = "q_table_deny";
const N0 = `nav_table_${T0}`;
const N1 = `nav_table_${T1}`;
const N2 = `nav_table_${T2}`;

async function mkTable(tableId: string, fields: Array<[string, string, string]>, records: Array<[string, Record<string, string>]>) {
  await h.prisma.base.create({ data: { id: `${tableId}_b`, name: `${tableId} 客户库`, createdBy: "owner" } });
  await h.prisma.table.create({
    data: { id: tableId, baseId: `${tableId}_b`, name: `${tableId} 客户表`, primaryFieldId: fields[0]![0], createdBy: "owner" },
  });
  for (const [fid, name, type] of fields) {
    await h.prisma.field.create({ data: { id: fid, tableId, name, type, order: Number(fid.slice(-1)) } });
  }
  for (const [rid, vals] of records) {
    await h.prisma.record.create({ data: { id: rid, tableId, createdBy: "owner", updatedBy: "owner", fields: JSON.stringify(vals) } });
    const entity = await extractEntity(h.prisma, { entityType: "record", entityId: rid, version: 1n }, 50);
    await applyUpsert(store, entity, { workspaceId: "ws_default", mode: "off", provider: null });
  }
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s7-scope-");
  store = h.openStore("scope", false);
  await h.prisma.user.createMany({
    data: [
      { id: U, email: "uq@x.com", displayName: "检索员", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
      { id: "owner", email: "own@x.com", displayName: "所有者", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
    ],
  });

  await mkTable(
    T0,
    [["f00", "客户名", "singleLineText"], ["f01", "备注", "longText"]],
    [["r0a", { f00: "无掩码阿尔法客户", f01: "无掩码独有内容NO_MASK_X1" }]],
  );
  await mkTable(
    T1,
    [["f10", "客户名", "singleLineText"], ["f11", "机密字段", "longText"]],
    [["r1a", { f10: "掩码公开客户", f11: "机密令牌SECRET_Q4X9 不应被搜到" }]],
  );
  await mkTable(
    T2,
    [["f20", "客户名", "singleLineText"], ["f21", "机密", "longText"]],
    [["r2a", { f20: "越权客户名", f21: "越权独有内容DENY_W7" }]],
  );

  // nav 节点 id 用 nav_<kind>_<resourceId>（与 chunk nodeId/backfill 同形态）。
  await querySeed.createNavNodes(h.prisma, [
    { id: `nav_base_${T0}_b`, kind: "base", resourceType: "base", resourceId: `${T0}_b`, parentId: null },
    { id: N0, kind: "table", resourceType: "table", resourceId: T0, parentId: `nav_base_${T0}_b` },
    { id: `nav_base_${T1}_b`, kind: "base", resourceType: "base", resourceId: `${T1}_b`, parentId: null },
    { id: N1, kind: "table", resourceType: "table", resourceId: T1, parentId: `nav_base_${T1}_b` },
    { id: `nav_base_${T2}_b`, kind: "base", resourceType: "base", resourceId: `${T2}_b`, parentId: null },
    { id: N2, kind: "table", resourceType: "table", resourceId: T2, parentId: `nav_base_${T2}_b` },
  ]);
  // U 对 T0 直授 r（无 mask）；对 T1 直授 r 但 fieldMask 仅白名单 f10；T2 不授（表级越权）。
  await querySeed.createPolicies(h.prisma, [
    { id: "p_t0", nodeId: N0, subjectType: "user", subjectId: U, actions: "r" },
    { id: "p_t1", nodeId: N1, subjectType: "user", subjectId: U, actions: "r", fieldMask: '{"allowFields":["f10"]}' },
  ]);

  // 真实 scope/decide/hydrate 装配（动态 import 经 buildQueryRuntime，复用全部 M4 真链）。
  const { buildQueryRuntime } = await import("../queryRuntime.js");
  buildDeps = async (userId: string, type: EntityTypeFilter = "all") => {
    const { deps } = await buildQueryRuntime(userId, type, {
      prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
      jwtSecret: "x", store, provider: null,
    });
    return deps;
  };
}, 120000);

afterAll(async () => {
  store?.close();
  await h.cleanup();
});

async function search(q: string, opts: { mode?: "auto" | "fts" | "vector"; type?: EntityTypeFilter } = {}): Promise<UnifiedSearchResponse> {
  const deps = await buildDeps(U, opts.type);
  return executeUnifiedSearch(deps, { q, mode: opts.mode ?? "auto", type: opts.type ?? "all", limit: 20 });
}

describe("scope x chunk join 逐实体 decide 零分叉", () => {
  it("identity 普遍含的「记录」一词召回的实体集 == 逐节点 decideMany 允许的表节点上的记录集", async () => {
    const res = await search("记录"); // 2 码元 -> LIKE 路；identity body 含「记录 <id>」
    const gotIds = res.items.filter((i) => i.type === "record").map((i) => i.entityId).sort();
    // 真值：对三张表节点逐节点 decide('r')
    const subject = await resolveSubject(U, h.prisma as unknown as AuthzClient);
    const decisions = await decideMany(
      { client: h.prisma as unknown as AuthzClient, resolveCreatedBy: makeCreatedByResolver(h.prisma as unknown as AuthzClient) },
      subject, [N0, N1, N2], "r",
    );
    const allowedTables = new Set(decisions.filter((d) => d.decision.allowed).map((d) => d.node.id));
    expect(allowedTables.has(N0)).toBe(true);
    expect(allowedTables.has(N1)).toBe(true);
    expect(allowedTables.has(N2)).toBe(false);
    // decide 允许的表（N0/N1）上的记录 r0a/r1a 都在召回；越权表 T2 的 r2a 不在。
    expect(gotIds).toEqual(["r0a", "r1a"]);
  });
});

describe("三分支授权（identity / 无 mask 全 field / 有 mask 仅白名单）", () => {
  it("① identity 恒可见：以表名/库名（只在 identity body）搜，mask 表记录仍命中", async () => {
    const res = await search("客户表");
    const ids = res.items.map((i) => i.entityId);
    expect(ids).toContain("r1a"); // T1 虽有 field mask，但 identity 始终可见
    expect(ids).toContain("r0a");
    expect(ids).not.toContain("r2a"); // 表级越权 identity 也缺席
  });

  it("② 无 mask 表的 field 不被误隐（错误二分支 identity OR EXISTS 下本条会失败）", async () => {
    // T0 在 temp_field_grant 没有任何行（无 mask）；三分支 NOT EXISTS 放行其全部 field chunk。
    const res = await search("NO_MASK_X1");
    expect(res.items.map((i) => i.entityId)).toEqual(["r0a"]);
  });

  it("③ 有 mask 表：白名单字段可命中", async () => {
    const res = await search("掩码公开客户"); // f10 在白名单
    const hit = res.items.find((i) => i.entityId === "r1a");
    expect(hit).toBeTruthy();
    expect(hit!.matchedField).toBe("客户名");
    expect(hit!.snippet).toContain("掩码公开客户");
    expect(hit!.snippet).not.toContain("SECRET");
  });

  it("③ 有 mask 表：非白名单字段独有值 FTS 与 LIKE 两路都零命中、零摘要泄漏", async () => {
    for (const mode of ["auto", "fts"] as const) {
      const res = await search("SECRET_Q4X9", { mode });
      expect(res.items, `mode=${mode}`).toHaveLength(0);
    }
    // 中文独有片段同样零命中
    const resCn = await search("机密令牌");
    expect(resCn.items).toHaveLength(0);
  });
});

describe("表级越权：整实体 identity+field 全缺席", () => {
  it("越权表 T2 的记录名/独有字段值/identity 词均搜不到", async () => {
    expect((await search("DENY_W7")).items).toHaveLength(0);
    expect((await search("越权客户名")).items).toHaveLength(0);
    expect((await search("q_table_deny 客户表")).items).toHaveLength(0);
  });
});

describe("纵深防御二次 decide", () => {
  it("正常路径 decideMismatch metric 为 0（scope 与决策一致）", async () => {
    let mismatch = -1;
    const deps = await buildDeps(U);
    const withMetric: QueryRuntimeDeps = { ...deps, onMetric: (m) => { mismatch = m.decideMismatch ?? 0; } };
    await executeUnifiedSearch(withMetric, { q: "客户", mode: "auto" });
    expect(mismatch).toBe(0);
  });
});
