// M5/S7 FTS/LIKE/vector 三路 + auto/fts/vector 强制档回退 + 空 q + truncated 诚实标记 +
// EXPLAIN 含 temp_scope 收敛（真迁移主库 + 真 vec0 search.db + 真实 scope，cloud 仅 mock provider）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, deterministicCloudProvider, querySeed, type QueryHarness } from "./queryHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { executeUnifiedSearch } from "../query.js";
import { buildQueryRuntime } from "../queryRuntime.js";
import { runRecall } from "../queryRecall.js";
import { buildSearchQueryPlan } from "../queryPlan.js";
import { buildFieldGrantRows } from "../fieldGrant.js";
import type { SearchStore } from "../searchStore.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { QueryRuntimeDeps, UnifiedSearchResponse } from "../queryTypes.js";
import { resolveVisibleNodeIds } from "../../authz/scope.js";
import type { AuthzClient } from "../../authz/types.js";

let h: QueryHarness;
let store: SearchStore;
let provider: EmbeddingProvider;
const U = "u_route";
const B = "rt_base";
const T = "rt_table";
const N = `nav_table_${T}`;
const NB = `nav_base_${B}`;

async function upsertRecord(id: string, vals: Record<string, string>) {
  await h.prisma.record.create({ data: { id, tableId: T, createdBy: "owner", updatedBy: "owner", fields: JSON.stringify(vals) } });
  const entity = await extractEntity(h.prisma, { entityType: "record", entityId: id, version: 1n }, 50);
  await applyUpsert(store, entity, { workspaceId: "ws_default", mode: "cloud", provider });
}

async function depsFor(userId = U): Promise<QueryRuntimeDeps> {
  const { deps } = await buildQueryRuntime(userId, "all", {
    prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
    jwtSecret: "x", store, provider,
  });
  return deps;
}

async function search(q: string, mode: "auto" | "fts" | "vector" = "auto", explain = false): Promise<UnifiedSearchResponse> {
  return executeUnifiedSearch(await depsFor(), { q, mode, type: "all", limit: 20 }, explain);
}

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s7-routes-");
  store = h.openStore("routes", true);
  provider = deterministicCloudProvider({ dim: 3 }) as unknown as EmbeddingProvider;
  await h.prisma.user.createMany({
    data: [{ id: U, email: "rt@x.com", displayName: "r", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" }],
  });
  await h.prisma.base.create({ data: { id: B, name: "路由客户库", createdBy: "owner" } });
  await h.prisma.table.create({ data: { id: T, baseId: B, name: "路由客户表", primaryFieldId: "rt_f0", createdBy: "owner" } });
  await h.prisma.field.create({ data: { id: "rt_f0", tableId: T, name: "客户名", type: "singleLineText", order: 0 } });
  await h.prisma.field.create({ data: { id: "rt_f1", tableId: T, name: "备注", type: "longText", order: 1 } });
  await querySeed.createNavNodes(h.prisma, [
    { id: NB, kind: "base", resourceType: "base", resourceId: B, parentId: null },
    { id: N, kind: "table", resourceType: "table", resourceId: T, parentId: NB },
  ]);
  await querySeed.createPolicies(h.prisma, [
    { id: "rt_p", nodeId: N, subjectType: "user", subjectId: U, actions: "r" },
  ]);
  // FTS 词 >=3 码元；LIKE 词 2 码元；二者都在同表（无 mask）。
  await upsertRecord("rt_r1", { rt_f0: "阿尔法长词客户", rt_f1: "项目管理长文体" });
  await upsertRecord("rt_r2", { rt_f0: "贝塔", rt_f1: "另一处长文体内容" });
}, 120000);

afterAll(async () => {
  store?.close();
  await h.cleanup();
});

describe("三路分流 + 强制档回退", () => {
  it("空 q：mode=like、items=[]、零召回", async () => {
    const res = await search("   ");
    expect(res.items).toEqual([]);
    expect(res.mode).toBe("like");
  });

  it("码元>=3 走 FTS（auto）：长词命中、matchedVia 含 fts", async () => {
    const res = await search("项目管理");
    expect(res.mode === "fts" || res.mode === "hybrid").toBe(true);
    const hit = res.items.find((i) => i.entityId === "rt_r1");
    expect(hit).toBeTruthy();
    expect(hit!.matchedVia).toContain("fts");
  });

  it("码元<3 走 LIKE（auto 向量健康）：短词 LIKE+vec=hybrid，仍命中短词独有记录", async () => {
    // auto 下短词经 LIKE 路（非 FTS）；向量健康时并跑 vec，融合为 hybrid；rt_r2 的"贝塔"
    // 仅 LIKE 能命中（2 码元不达 trigram），命中即证明 LIKE 路实际参与召回。
    const res = await search("贝塔");
    expect(res.mode).toBe("hybrid");
    expect(res.items.map((i) => i.entityId)).toContain("rt_r2");
  });

  it("强制 fts：短词也只走关键词、永不调向量（mode=like）", async () => {
    const res = await search("贝塔", "fts");
    expect(res.mode).toBe("like");
    expect(res.items.map((i) => i.entityId)).toContain("rt_r2");
  });

  it("强制 vector 且向量可用：mode=vector，命中经 KNN", async () => {
    const res = await search("任意长查询词", "vector");
    expect(res.mode).toBe("vector");
    // mock 向量对所有记录相近；白名单内记录至少有命中
    expect(res.items.length).toBeGreaterThan(0);
  });

  it("policyVersion 透传、scopeTruncated=false（小集合）", async () => {
    const res = await search("长文体");
    expect(res.policyVersion).toBe(0);
    expect(res.scopeTruncated).toBe(false);
  });
});

describe("EXPLAIN 收敛证据（temp_scope/allowed 先于结果产出）", () => {
  it("FTS/LIKE/vec 三路 EXPLAIN 都含 temp_scope 唯一表名与 allowed 子查询/连接", async () => {
    const scope = await resolveVisibleNodeIds(h.prisma as unknown as AuthzClient, U, { actions: ["r"], kinds: ["table"] });
    const grantRows = buildFieldGrantRows(new Set(scope.nodeIds), scope.maskedTableFields);
    const blob = Buffer.from(new Float32Array(3).slice().buffer);

    // FTS 路（mode=fts 长词；vector.enabled=false，只跑 fts）。
    const ftsPlan = buildSearchQueryPlan("长文体", { mode: "fts", type: "all", limit: 20 });
    const ftsRecall = runRecall(store.db, ftsPlan, scope.nodeIds, grantRows, { explain: true });
    const ftsText = ftsRecall.plans.fts.join("\n");
    expect(ftsText).toMatch(/temp_scope_/); // scope 收敛进计划
    expect(ftsText).toMatch(/fts_chunks/);
    expect(ftsRecall.ran.vec).toBe(false);

    // LIKE 路（mode=fts 短词 -> 走参数化 LIKE；EXPLAIN 里 fts_chunks 显示为别名 f 的虚表扫描，
    // 收敛证据看 temp_scope COVERING INDEX 与三分支 CORRELATED SCALAR SUBQUERY）。
    const likePlan = buildSearchQueryPlan("贝塔", { mode: "fts", type: "all", limit: 20 });
    const likeRecall = runRecall(store.db, likePlan, scope.nodeIds, grantRows, { explain: true });
    const likeText = likeRecall.plans.like.join("\n");
    expect(likeText).toMatch(/temp_scope_/);
    expect(likeText).toMatch(/VIRTUAL TABLE/); // fts_chunks f 回查 body
    expect(likeText).toMatch(/CORRELATED SCALAR SUBQUERY/); // 三分支 g0/g
    expect(likeRecall.ran.like).toBe(true);

    // vec 路：对齐 query 编排的 effectivePlan（强制 vector 成功时关键词对象置 null，只跑 vec）。
    const vecRaw = buildSearchQueryPlan("长文体", { mode: "vector", type: "all", limit: 20 });
    const vecPlan = { ...vecRaw, fts: null, like: null };
    const vecRecall = runRecall(store.db, vecPlan, scope.nodeIds, grantRows, { queryVector: blob, explain: true });
    const vecText = vecRecall.plans.vec.join("\n");
    expect(vecText).toMatch(/vec_chunks/);
    // S11：allowed 作为 LIST SUBQUERY 收敛进 KNN 扫描（temp_scope），非应用层后置过滤。
    expect(vecText).toMatch(/LIST SUBQUERY|temp_scope_/);
    expect(vecRecall.ran.vec).toBe(true);
    expect(vecRecall.ran.fts).toBe(false);
    expect(vecRecall.ran.like).toBe(false);
  });
});

describe("scopeTruncated 诚实标记", () => {
  it("budget=1 截断时响应 scopeTruncated=true（不谎称全量）", async () => {
    const { deps } = await buildQueryRuntime(U, "all", {
      prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
      jwtSecret: "x", store, provider,
    });
    // 覆写 resolveScope 为 budget=1（模拟截断），其余依赖真实。
    const truncatedScope = await resolveVisibleNodeIds(h.prisma as unknown as AuthzClient, U, {
      actions: ["r"], budget: 1,
    });
    const depsTrunc: QueryRuntimeDeps = {
      ...deps,
      resolveScope: async () => ({
        nodeIds: truncatedScope.nodeIds,
        truncated: true,
        policyVersion: truncatedScope.policyVersion,
        maskedTableFields: truncatedScope.maskedTableFields,
      }),
    };
    const res = await executeUnifiedSearch(depsTrunc, { q: "客户", mode: "auto" });
    expect(res.scopeTruncated).toBe(true);
  });
});
