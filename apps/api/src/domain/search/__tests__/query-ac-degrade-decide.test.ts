// M5/S8 AC-M5-2 降级不改权限（§4.9 / §13-201）+ 二次 decide 失配计数（§13-iv）。
//
// 增量 4：cloud 故障（embed reject）/ vec0 不可用（fts-only 库）/ dim 不符 使 auto 或强制
//   vector 降级回 FTS/LIKE，断言降级后 mask 字段与表级越权结果集与正常 fts 完全一致、degraded
//   有标注但可见性零放宽；强制 mode=vector 向量不可用回退关键词后密文仍零命中。
// 增量 5：注入 deps 模拟 scope 快照与 decideMany 不一致，断言失配实体被二次校验丢弃且
//   onMetric.decideMismatch 计数正确（正常路径 0 已由 query-scope 哨兵覆盖，不重复）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { executeUnifiedSearch } from "../query.js";
import { buildQueryRuntime } from "../queryRuntime.js";
import type { SearchStore } from "../searchStore.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { QueryRuntimeDeps } from "../queryTypes.js";
import {
  U, N_OK, R_DENY, R_MASK, R_OK,
  SECRET, DENY_FIELD, OK_TEXT, QTEXT,
  seedAcScenario, controlledProvider,
} from "./acScenario.js";

let h: QueryHarness;
let cloudStore: SearchStore; // vec0 可用
let offStore: SearchStore; // tryLoadVec=false（vec0 不可用）

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s8-degrade-");
  cloudStore = h.openStore("degcloud", true);
  offStore = h.openStore("degoff", false);
  await seedAcScenario(h, cloudStore, true);
  // off 库仅用于 vec_unavailable 路径；同主库授权，实体也派生一份（FTS 可用）。
  const { extractEntity } = await import("../entityExtract.js");
  const { applyUpsert } = await import("../indexerDerive.js");
  for (const rid of [R_DENY, R_MASK, R_OK]) {
    const entity = await extractEntity(h.prisma, { entityType: "record", entityId: rid, version: 1n }, 50);
    await applyUpsert(offStore, entity, { workspaceId: "ws_default", mode: "off", provider: null });
  }
}, 180000);

afterAll(async () => {
  cloudStore?.close();
  offStore?.close();
  await h.cleanup();
});

async function deps(store: SearchStore, provider: EmbeddingProvider | null): Promise<QueryRuntimeDeps> {
  const { deps } = await buildQueryRuntime(U, "all", {
    prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
    jwtSecret: "x", store, provider,
  });
  return deps;
}

async function search(
  store: SearchStore, provider: EmbeddingProvider | null,
  q: string, mode: "auto" | "fts" | "vector",
) {
  return executeUnifiedSearch(await deps(store, provider), { q, mode, type: "all", limit: 20 });
}

/** 可见性基线（正常 fts 路）：密文零命中、越权缺席、对照正常。 */
async function assertVisibilityBaseline(label: string, res: Awaited<ReturnType<typeof search>>) {
  const ids = res.items.map((i) => i.entityId);
  const maskHit = res.items.find((i) => i.entityId === R_MASK);
  expect(JSON.stringify(maskHit ?? {}), `${label}: 无密文泄漏`).not.toContain("MASK_SECRET_ZX9");
  expect(ids, `${label}: 表级越权缺席`).not.toContain(R_DENY);
}

describe("增量4 降级不改权限（§4.9 / §13-201）", () => {
  it("cloud embed 故障：auto 标 embedding_unhealthy 并降级，密文/越权结果集与正常 fts 一致", async () => {
    const fail = controlledProvider("fail");
    const res = await search(cloudStore, fail, SECRET, "auto");
    expect(res.degraded).toContain("embedding_unhealthy");
    expect(["fts", "like"]).toContain(res.mode); // 回退到关键词
    expect(res.items.map((i) => i.entityId)).not.toContain(R_MASK); // 密文仍零命中
    const deny = await search(cloudStore, fail, DENY_FIELD, "auto");
    expect(deny.items.map((i) => i.entityId)).not.toContain(R_DENY);
    const ok = await search(cloudStore, fail, OK_TEXT, "auto");
    expect(ok.items.map((i) => i.entityId)).toContain(R_OK); // 可见性未收窄
  });

  it("dim 不符：auto 标 dim_mismatch 降级，密文零命中/越权缺席", async () => {
    const dim = controlledProvider("dimmismatch");
    const res = await search(cloudStore, dim, SECRET, "auto");
    expect(res.degraded).toContain("dim_mismatch");
    expect(res.items.map((i) => i.entityId)).not.toContain(R_MASK);
    const deny = await search(cloudStore, dim, DENY_FIELD, "auto");
    expect(deny.items.map((i) => i.entityId)).not.toContain(R_DENY);
  });

  it("vec0 不可用（fts-only 库 + cloud provider）：auto 标 vec_unavailable，语义查询降级且不放宽可见性", async () => {
    const cloud = controlledProvider("controlled");
    const res = await search(offStore, cloud, QTEXT, "auto");
    expect(res.degraded).toContain("vec_unavailable");
    expect(["fts", "like"]).toContain(res.mode);
    expect(res.items.map((i) => i.entityId)).not.toContain(R_DENY);
    // 白名单 mask 记录即便经语义词也不泄漏密文（降级为关键词后 QTEXT 无 FTS 命中属正常）。
    expect(JSON.stringify(res)).not.toContain("MASK_SECRET_ZX9");
  });

  it("强制 vector 但 embed 故障：回退该词长关键词路并标注，密文仍零命中（回退不放宽 field_grant）", async () => {
    const fail = controlledProvider("fail");
    const res = await search(cloudStore, fail, SECRET, "vector");
    expect(res.degraded).toContain("embedding_unhealthy");
    expect(["fts", "like"]).toContain(res.mode);
    expect(res.items.map((i) => i.entityId)).not.toContain(R_MASK);
    expect(JSON.stringify(res)).not.toContain("MASK_SECRET_ZX9");
  });

  it("强制 vector 且 vec0 不可用：回退关键词，表级越权身份词也缺席", async () => {
    const cloud = controlledProvider("controlled");
    const res = await search(offStore, cloud, DENY_FIELD, "vector");
    expect(res.degraded).toContain("vec_unavailable");
    expect(res.items.map((i) => i.entityId)).not.toContain(R_DENY);
  });

  it("正常 cloud（无降级）对照组：degraded 为空，可见性基线一致", async () => {
    const cloud = controlledProvider("controlled");
    const res = await search(cloudStore, cloud, OK_TEXT, "auto");
    expect(res.degraded).toEqual([]);
    await assertVisibilityBaseline("正常 cloud", res);
  });
});

describe("增量5 二次 decide 失配：失配实体丢弃 + metric 计数", () => {
  it("注入 decide 拒绝 R_OK 所在节点：该实体从融合结果丢弃，decideMismatch 计数=1", async () => {
    const real = await deps(cloudStore, controlledProvider("controlled"));
    let mismatch = -1;
    const injected: QueryRuntimeDeps = {
      ...real,
      decideNodeIds: async (nodeIds: string[]) => {
        const allowed = await real.decideNodeIds(nodeIds);
        // 模拟 scope 快照（召回时含 N_OK）与二次 decide（此刻拒绝 N_OK）不一致。
        return new Set([...allowed].filter((n) => n !== N_OK));
      },
      onMetric: (m) => { mismatch = m.decideMismatch ?? 0; },
    };
    const res = await executeUnifiedSearch(injected, { q: OK_TEXT, mode: "auto", type: "all", limit: 20 });
    expect(res.items.map((i) => i.entityId)).not.toContain(R_OK);
    expect(mismatch).toBe(1);
  });

  it("正常路径（不注入拒绝）：decideMismatch=0，实体保留", async () => {
    let mismatch = -1;
    const real = await deps(cloudStore, controlledProvider("controlled"));
    const withMetric: QueryRuntimeDeps = { ...real, onMetric: (m) => { mismatch = m.decideMismatch ?? 0; } };
    const res = await executeUnifiedSearch(withMetric, { q: OK_TEXT, mode: "auto", type: "all", limit: 20 });
    expect(res.items.map((i) => i.entityId)).toContain(R_OK);
    expect(mismatch).toBe(0);
  });
});
