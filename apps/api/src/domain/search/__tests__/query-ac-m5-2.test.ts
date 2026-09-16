// M5/S8 AC-M5-2 字段/表级物理缺席系统对抗（§8 637-638 / §13 / §17 S8）。
//
// 不重复 S7 已绿用例，只补组合矩阵与"收敛先于产出"硬证据：
//   AC-M5-2a：主体对 node 无 r，以独有文本/语义近邻在 auto/fts/vector 三 mode 检索 -> 零命中、
//             整个响应序列化无该实体独有词/标题/snippet；越权节点 identity chunk 也不进（temp_scope）。
//             cloud（vec0 库）与 off（fts-only）两形态各跑。
//   AC-M5-2b：被 fieldMask 字段的向量在数据里与查询向量几乎重合（距离 0，全局最近邻），但在
//             mode=vector/auto 下该 field chunk 必须在 KNN 扫描层被 temp_field_grant 剔除；
//             EXPLAIN 三路都含 temp_scope/allowed(field_grant 三分支) 且出现在结果扫描路径上。
//   §4.7 规则 6：mask 命中同实体白名单字段时，matchedField 只可能是白名单字段或 null、
//             措辞无"无权限"、不出现被 mask 字段名。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, type QueryHarness } from "./queryHarness.js";
import { executeUnifiedSearch } from "../query.js";
import { buildQueryRuntime } from "../queryRuntime.js";
import { runRecall, toQueryBlob } from "../queryRecall.js";
import { buildSearchQueryPlan } from "../queryPlan.js";
import { buildFieldGrantRows } from "../fieldGrant.js";
import { resolveVisibleNodeIds } from "../../authz/scope.js";
import type { AuthzClient } from "../../authz/types.js";
import type { SearchStore } from "../searchStore.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { QueryRuntimeDeps, UnifiedSearchResponse } from "../queryTypes.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import {
  U,
  N_MASK, R_DENY, R_MASK, R_OK,
  DENY_FIELD, DENY_TABLE, OK_TEXT, QTEXT,
  seedAcScenario, controlledProvider,
} from "./acScenario.js";

let h: QueryHarness;
let cloudStore: SearchStore;
let offStore: SearchStore;

beforeAll(async () => {
  h = await makeQueryHarness("gx-m5-s8-ac2-");
  cloudStore = h.openStore("ac2cloud", true);
  offStore = h.openStore("ac2off", false);
  // 同一主库场景：完整播种一次（用户/表/字段/nav/policy），实体派生进 cloud(vec0) 库；
  // 再把三实体同内容派生进 off(fts-only) 库（两库各自独立，主库授权共用）。
  await seedAcScenario(h, cloudStore, true);
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
): Promise<UnifiedSearchResponse> {
  return executeUnifiedSearch(await deps(store, provider), { q, mode, type: "all", limit: 20 });
}

describe("AC-M5-2a 表级越权（无 r）：三 mode 零命中 + 序列化零泄漏", () => {
  for (const [label, store, provider, cloud] of [
    ["cloud/vec0", cloudStore, controlledProvider("controlled"), true],
    ["off/fts-only", offStore, null, false],
  ] as const) {
    describe(`形态 ${label}`, () => {
      for (const mode of ["auto", "fts", "vector"] as const) {
        it(`独有字段文本 mode=${mode}：实体缺席且响应无任何独有词/标题/snippet`, async () => {
          if (!cloud && mode === "vector") return; // off 形态无向量路（强制 vector 回退关键词）
          const res = await search(store, provider, DENY_FIELD, mode);
          expect(res.items.map((i) => i.entityId)).not.toContain(R_DENY);
          const ser = JSON.stringify(res);
          expect(ser).not.toContain(DENY_FIELD);
          expect(ser).not.toContain(R_DENY);
        });

        it(`identity 独有表名 mode=${mode}：越权节点 identity chunk 也不进（temp_scope，与字段无关）`, async () => {
          if (!cloud && mode === "vector") return;
          const res = await search(store, provider, DENY_TABLE, mode);
          expect(res.items.map((i) => i.entityId)).not.toContain(R_DENY);
          expect(JSON.stringify(res)).not.toContain(DENY_TABLE);
        });
      }
    });
  }

  it("cloud：纯语义近邻查询（QTEXT，无任何 FTS 词）下越权实体在 auto/vector 都缺席", async () => {
    for (const mode of ["auto", "vector"] as const) {
      const res = await search(cloudStore, controlledProvider("controlled"), QTEXT, mode);
      expect(res.items.map((i) => i.entityId), mode).not.toContain(R_DENY);
    }
  });
});

describe("AC-M5-2b vec 路 fieldMask：密文 chunk 是全局最近邻仍在 KNN 扫描层被排除", () => {
  it("mode=vector：返回的 mask 表记录经白名单 PUBLIC 命中，密文 SECRET 零命中/零摘要", async () => {
    const res = await search(cloudStore, controlledProvider("controlled"), QTEXT, "vector");
    // mask 记录可因白名单 field chunk(PUBLIC, 距离 0.632)/identity(1.414) 命中，但密文 chunk(距离 0) 必须被排除。
    const ser = JSON.stringify(res);
    expect(ser).not.toContain("MASK_SECRET_ZX9");
    expect(ser).not.toContain("机密向量近邻密文");
    const maskHit = res.items.find((i) => i.entityId === R_MASK);
    if (maskHit) {
      expect(maskHit.snippet).not.toContain("MASK_SECRET_ZX9");
      expect(maskHit.matchedField === null || maskHit.matchedField === "公开备注").toBe(true);
    }
  });

  it("mode=auto：hybrid 召回同样排除密文 chunk（不因其距离 0 占满 top-k 挤掉白名单/对照实体）", async () => {
    const res = await search(cloudStore, controlledProvider("controlled"), QTEXT, "auto");
    const ids = res.items.map((i) => i.entityId);
    expect(JSON.stringify(res)).not.toContain("MASK_SECRET_ZX9");
    // 白名单 mask 记录与无 mask 对照记录不因密文挤占而丢失（密文若泄漏会以最高分占首位）。
    expect(ids).toContain(R_OK);
  });

  it("密文文本在 FTS/LIKE 两路也零命中（物理缺席三路一致，非仅向量层）", async () => {
    const res = await search(cloudStore, controlledProvider("controlled"), "MASK_SECRET_ZX9", "fts");
    expect(res.items.map((i) => i.entityId)).not.toContain(R_MASK);
    expect(res.items.some((i) => JSON.stringify(i).includes("MASK_SECRET_ZX9"))).toBe(false);
  });
});

describe("AC-M5-2b EXPLAIN：temp_scope/allowed 收敛在结果扫描路径上（先于产出）", () => {
  async function scopeForUser() {
    const scope = await resolveVisibleNodeIds(h.prisma as unknown as AuthzClient, U, {
      actions: ["r"], kinds: ["table"],
    });
    return {
      scope,
      grantRows: buildFieldGrantRows(new Set(scope.nodeIds), scope.maskedTableFields),
    };
  }

  it("FTS：MATCH 路经 allowed CTE JOIN temp_scope + 三分支 field_grant 标量子查询", async () => {
    const { scope, grantRows } = await scopeForUser();
    const plan = buildSearchQueryPlan("PUBLIC_TOKEN_P7", { mode: "fts", type: "all", limit: 20 });
    const recall = runRecall(cloudStore.db, plan, scope.nodeIds, grantRows, { explain: true });
    const text = recall.plans.fts.join("\n");
    expect(text).toMatch(/temp_scope_/); // 表级收敛
    expect(text).toMatch(/CORRELATED SCALAR SUBQUERY/); // 三分支 NOT EXISTS/EXISTS(field_grant)
    expect(text).toMatch(/fts_chunks/);
    // 收敛 JOIN/子查询出现在产出扫描路径（计划非空且含 scope 表）即"召回前排除"的留证。
    expect(recall.ran.fts).toBe(true);
  });

  it("LIKE：短词 LIKE 路同样内联 temp_scope JOIN + 三分支标量子查询", async () => {
    const { scope, grantRows } = await scopeForUser();
    const plan = buildSearchQueryPlan("密文", { mode: "fts", type: "all", limit: 20 });
    const recall = runRecall(cloudStore.db, plan, scope.nodeIds, grantRows, { explain: true });
    const text = recall.plans.like.join("\n");
    expect(text).toMatch(/temp_scope_/);
    expect(text).toMatch(/CORRELATED SCALAR SUBQUERY/);
    expect(text).toMatch(/VIRTUAL TABLE/); // fts_chunks f 回查 body
    expect(recall.ran.like).toBe(true);
  });

  it("vec：KNN 扫描约束含 allowed LIST SUBQUERY（field_grant 三分支）+ temp_scope，非应用层后置过滤", async () => {
    const { scope, grantRows } = await scopeForUser();
    const raw = buildSearchQueryPlan(QTEXT, { mode: "vector", type: "all", limit: 20 });
    const plan = { ...raw, fts: null, like: null }; // 对齐 query 编排强制 vector 成功形态
    const { toQueryBlob } = await import("../queryRecall.js");
    const recall = runRecall(
      cloudStore.db, plan, scope.nodeIds, grantRows,
      { queryVector: toQueryBlob(new Float32Array([1, 0, 0, 0])), explain: true },
    );
    const text = recall.plans.vec.join("\n");
    expect(text).toMatch(/vec_chunks/);
    expect(text).toMatch(/LIST SUBQUERY/); // rowid IN (SELECT rid FROM allowed)
    expect(text).toMatch(/temp_scope_/);
    expect(text).toMatch(/CORRELATED SCALAR SUBQUERY/); // allowed 内三分支（含 temp_field_grant）
    // 密文 chunk 即便向量最近也不在 vec 召回行。
    const secretLeak = recall.vec.some((r) => r.entityId === R_MASK && (r.fieldId === "ac2_f_secret"));
    expect(secretLeak).toBe(false);
  });

  it("决定性反证：撤掉 field_grant 收敛（grantRows 空=无 mask 的错误实现）时密文 chunk 排 KNN 首位", async () => {
    // 证明 f_secret 向量确实物理写入 vec_chunks 且是查询向量的全局最近邻；生产口径下它被
    // 排除【只可能】来自 temp_field_grant 三分支收敛，而非向量本身不够近（AC-M5-2b 不靠距离侥幸）。
    const raw = buildSearchQueryPlan(QTEXT, { mode: "vector", type: "all", limit: 20 });
    const plan = { ...raw, fts: null, like: null };
    // 错误实现模拟：scope 仍只含可见表 N_MASK（表级收敛保留），但 grantRows=空 ->
    // 三分支中 NOT EXISTS 恒真 -> 该表【全部】 field chunk（含密文）可见。KNN 按距离升序，首位即最近邻。
    const recall = runRecall(
      cloudStore.db, plan, [N_MASK], [],
      { queryVector: toQueryBlob(new Float32Array([1, 0, 0, 0])) },
    );
    const first = recall.vec[0];
    expect(first).toBeTruthy();
    expect(first!.entityId).toBe(R_MASK);
    expect(first!.fieldId).toBe("ac2_f_secret"); // 密文 chunk 排首位（数据层确实最近）
  });
});

describe("§4.7 规则 6 mask 命中的中性呈现", () => {
  it("mask 记录经白名单字段命中：matchedField 为白名单字段名、snippet 是白名单值；不出现被 mask 字段名/密文/无权限字样", async () => {
    const res = await search(cloudStore, controlledProvider("controlled"), "PUBLIC_TOKEN_P7", "fts");
    const hit = res.items.find((i) => i.entityId === R_MASK);
    expect(hit).toBeTruthy();
    expect(hit!.matchedField).toBe("公开备注"); // 白名单 f_pub 名
    expect(hit!.snippet).toContain("PUBLIC_TOKEN_P7");
    const ser = JSON.stringify(hit);
    expect(ser).not.toContain("机密字段"); // 被 mask 字段名不出现
    expect(ser).not.toContain("MASK_SECRET_ZX9");
    expect(ser).not.toContain("无权限"); // 中性措辞，不反证字段存在
  });

  it("对照：无 mask 表记录正常呈现主字段值，不被过度收窄", async () => {
    const res = await search(cloudStore, controlledProvider("controlled"), OK_TEXT, "fts");
    const hit = res.items.find((i) => i.entityId === R_OK);
    expect(hit).toBeTruthy();
    expect(hit!.title).toBe(OK_TEXT);
  });
});
