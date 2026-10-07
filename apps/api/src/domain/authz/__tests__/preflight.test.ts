// 通电前【体检】真库集成测试（临时库 + 真迁移）：覆盖/对账/legacy/库级聚合位等价性/
// 库节点可见集，与 READY/NOT_READY 分级。门（AUTHZ_ENFORCE_READY）与双写接线是注入的静态事实，
// 故判定逻辑可脱离运行时单独验。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createAuthzTempDb, resetTables, seedFixture,
} from "./scopeBackfillFixture.js";
import { nodeId } from "../../nav/backfill.js";

let prisma: PrismaClient;
let cleanup: () => void;
let planScopeBackfill: typeof import("../scopeBackfill.js")["planScopeBackfill"];
let applyScopeBackfill: typeof import("../scopeBackfill.js")["applyScopeBackfill"];
let computePreflightData: typeof import("../preflight.js")["computePreflightData"];
let evaluatePreflight: typeof import("../preflight.js")["evaluatePreflight"];
type Facts = Parameters<typeof evaluatePreflight>[1];

beforeAll(async () => {
  const db = createAuthzTempDb("gx-preflight-");
  prisma = db.prisma;
  cleanup = db.cleanup;
  const backfill = await import("../scopeBackfill.js");
  planScopeBackfill = backfill.planScopeBackfill;
  applyScopeBackfill = backfill.applyScopeBackfill;
  const pf = await import("../preflight.js");
  computePreflightData = pf.computePreflightData;
  evaluatePreflight = pf.evaluatePreflight;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

beforeEach(async () => {
  await resetTables(prisma);
});

const wiredFacts = (enforceReady: boolean): Facts => ({
  enforceReady,
  hooks: [{ hook: "rebuildScopePoliciesTx", required: true, why: "PUT 主路径", callSites: ["src/x.ts:1"] }],
});

/**
 * 把两项语义面待修项摘掉（它们另有专门用例锁住），用于单独验分级接线本身：
 *   - reachability：库节点聚合位 enter/edit_data 与 legacy 等价性；
 *   - scopeVisibility：库节点是否进可见集（判定层 scope.ts 尚未按 enter 改判）。
 */
const withoutSemanticGaps = <T extends { reachability: unknown; scopeVisibility: unknown }>(data: T): T =>
  ({
    ...data,
    reachability: { sampled: 4, mismatches: 0, samples: [], errors: 0 },
    scopeVisibility: {
      sampledUsers: 1, ownerSkipped: 0, checked: 2, visible: 2,
      orphanTableUsers: 0, samples: [], errors: 0,
    },
  });

async function projectAll(): Promise<void> {
  const p = await planScopeBackfill(prisma);
  await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));
}

describe("A 存量未投影", () => {
  it("覆盖缺口 + S1 -> NOT_READY，阻断项写明缺多少行", async () => {
    await seedFixture(prisma);
    const data = await computePreflightData(prisma);
    expect(data.coverage.gap).toBeGreaterThan(0);
    expect(data.coverage.rolesWithoutProjection).toContain("role_admin");

    const r = evaluatePreflight(data, wiredFacts(true));
    expect(r.verdict).toBe("NOT_READY");
    expect(r.blocking.some((b) => b.includes("存量覆盖缺口"))).toBe(true);
    expect(r.blocking.some((b) => b.includes("S1_MISSING"))).toBe(true);
  });

  it("未投影时：库节点缺聚合位 -> parity mismatch（翻 on 必误拒/越权）", async () => {
    await seedFixture(prisma);
    const data = await computePreflightData(prisma);
    expect(data.reachability.sampled).toBeGreaterThan(0);
    expect(data.reachability.errors).toBe(0);
    expect(data.reachability.mismatches).toBeGreaterThan(0);
    // 样例必须能定位到 enter 或 edit_data 中至少一枚的引擎/legacy 分歧
    expect(data.reachability.samples.some((s) => s.engine !== s.legacy)).toBe(true);
  });
});

describe("B 根因修复后的判定（投影 + 判定两层都已接线）", () => {
  it("聚合位 parity=0 且库节点进可见集；语义面两段同时归零", async () => {
    await seedFixture(prisma);
    await projectAll();

    const data = await computePreflightData(prisma);
    expect(data.coverage.gap).toBe(0);
    expect(data.coverage.rolesWithoutProjection).toEqual([]);
    expect(data.coverage.scopeRows).toBe(2);
    expect(data.reconcile.summary).toMatchObject({ B: 0, C: 0, S: 0 });
    // A 段可能含 A3（投影动作串恰等于旧档，只报不改的已知噪声）-> 提示不阻断
    expect(data.reconcile.byCode.every((x) => x.kind === "advisory")).toBe(true);

    // 语义面一：库节点聚合位 enter/edit_data 与 legacy 逐值等价
    expect(data.reachability.errors).toBe(0);
    expect(data.reachability.mismatches).toBe(0);
    // 语义面二：判定层 scope.ts 已按 enter 改判 -> 库节点进可见集，无「表可见库消失」用户
    expect(data.scopeVisibility.errors).toBe(0);
    expect(data.scopeVisibility.orphanTableUsers).toBe(0);
    expect(data.scopeVisibility.visible).toBeGreaterThan(0);

    const r = evaluatePreflight(data, wiredFacts(true));
    expect(r.blocking.some((b) => b.includes("库节点缺席可见集"))).toBe(false);
    expect(r.verdict).toBe("READY"); // 语义面与数据面齐即 READY：引擎永久单一化，无总门再挡
    // enforceReady 仅为稳定报告结构保留，传 false 也不再产生 AUTHZ_ENFORCE_READY 阻断。
    const alsoReady = evaluatePreflight(data, wiredFacts(false));
    expect(alsoReady.blocking.some((b) => b.includes("AUTHZ_ENFORCE_READY"))).toBe(false);
    expect(alsoReady.verdict).toBe("READY");
  });

  it("聚合位 parity：抽样覆盖 r1/role_admin × b1/b2，逐值引擎==legacy", async () => {
    await seedFixture(prisma);
    await projectAll();

    const data = await computePreflightData(prisma);
    // 2 角色 × 2 库 × 2 聚合位 = 8 个值（r1 在 b2 无行、role_admin 在 b2 无行：各得空期望）
    expect(data.reachability.sampled).toBe(8);
    expect(data.reachability.mismatches).toBe(0);
    // 全等价 -> 无样例留存
    expect(data.reachability.samples).toEqual([]);
  });

  it("反证（A-4 专项 §11.2）：库节点已带 enter，但 visibleAll 仍为 false、hidden 字段不可见", async () => {
    await seedFixture(prisma);
    await projectAll();
    const { decide } = await import("../engine.js");
    const subject = {
      userId: "", roleIds: ["r1"], departments: [], deptAncestorIds: [], isWorkspaceOwner: false,
    };
    const tableNode = nodeId("table", "t1");
    const F2 = "f2"; // r1 在 scope 配置里把 f2 设为 hidden

    // 库节点此刻已带 enter（ADR-0056 聚合位），它不是 r，故不进 capability 并集；
    // r1 在 t1 仍只有窄来源（allow=[f1]），f2 不可见。
    const before = await decide({ client: prisma }, subject, tableNode, "r");
    expect(before.decision.allowed).toBe(true);
    expect(before.capability.visibleAll).toBe(false);
    expect(before.capability.visibleFields?.has(F2)).toBe(false);

    // 手工在【库节点】再补一枚不带 mask 的 r（即被否决的方案 ①）
    // 库节点策略行已存在（enter），(nodeId, subjectType, subjectId) 唯一，故改写而非新建。
    await prisma.authPolicy.updateMany({
      where: { nodeId: nodeId("base", "b1"), subjectType: "role", subjectId: "r1" },
      data: { actions: "enter,r" },
    });

    // 补 r 之后：库节点成为"不裁剪"的宽来源，沿继承进入表节点并集 -> 字段收窄被淹没（越权）
    const after = await decide({ client: prisma }, subject, tableNode, "r");
    expect(after.capability.visibleAll).toBe(true);
    expect(after.capability.visibleFields?.has(F2) ?? true).toBe(true);
  });
});

describe("B2 库节点进入可见集（判定层 scope.ts 已按 enter 改判）", () => {
  it("库节点进可见集：表可见、库也可见（不再整层消失）", async () => {
    await seedFixture(prisma);
    await projectAll();

    const data = await computePreflightData(prisma);
    const sv = data.scopeVisibility;
    expect(sv.sampledUsers).toBeGreaterThan(0);
    expect(sv.errors).toBe(0);
    expect(sv.checked).toBeGreaterThan(0);
    // scope.ts 已按 enter 改判：库节点进可见集，无 orphan 用户
    expect(sv.visible).toBeGreaterThan(0);
    expect(sv.orphanTableUsers).toBe(0);

    const r = evaluatePreflight(data, wiredFacts(true));
    expect(r.blocking.some((b) => b.includes("库节点缺席可见集"))).toBe(false);
  });

  it("对照：用户本就无任何库视野时（表同样不可见，属合法空集）", async () => {
    await seedFixture(prisma);
    await prisma.roleAssignment.deleteMany({});
    await prisma.roleLibraryScope.deleteMany({});
    await projectAll();

    const data = await computePreflightData(prisma);
    const sv = data.scopeVisibility;
    expect(sv.sampledUsers).toBeGreaterThan(0);
    expect(sv.visible).toBe(0);
    // 关键：这条体检项只在「表可见而库不可见」时红，空视野不算失效
    expect(sv.orphanTableUsers).toBe(0);
    expect(evaluatePreflight(data, wiredFacts(true)).blocking.some((b) => b.includes("库节点缺席可见集")))
      .toBe(false);
  });
});

describe("C 静态事实分级", () => {
  it("主路径双写钩子缺失 -> 阻断；结构性钩子缺失 -> 仅提示", async () => {
    await seedFixture(prisma);
    await projectAll();
    const data = withoutSemanticGaps(await computePreflightData(prisma));

    const missingMain = evaluatePreflight(data, {
      enforceReady: true,
      hooks: [{ hook: "rebuildScopePoliciesTx", required: true, why: "PUT 主路径", callSites: [] }],
    });
    expect(missingMain.verdict).toBe("NOT_READY");
    expect(missingMain.blocking.some((b) => b.includes("rebuildScopePoliciesTx"))).toBe(true);

    const missingStructural = evaluatePreflight(data, {
      enforceReady: true,
      hooks: [{ hook: "resyncTableMaskTx", required: false, why: "字段重算", callSites: [] }],
    });
    expect(missingStructural.verdict).toBe("READY");
    expect(missingStructural.advisory.some((a) => a.includes("resyncTableMaskTx"))).toBe(true);
  });
});
