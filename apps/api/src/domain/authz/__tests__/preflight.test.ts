// 通电前【体检】真库集成测试（临时库 + 真迁移）：覆盖/对账/legacy/库级判定可达性
// 与 READY/NOT_READY 分级。门（AUTHZ_ENFORCE_READY）与双写接线是注入的静态事实，
// 故判定逻辑可脱离运行时单独验。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createAuthzTempDb, resetTables, mkRole, mkBase, mkTable, mkNode, mkScope, seedFixture,
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

/** 把「库级判定不可达」这项待修项摘掉（它另有专门用例锁住），用于单独验分级接线。 */
const withoutReachabilityGap = <T extends { reachability: unknown }>(data: T): T =>
  ({ ...data, reachability: { sampled: 4, libraryUnreachable: 0, samples: [], errors: 0 } });

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
});

describe("B 投影完成后的判定", () => {
  it("数据面齐了、门已翻，仍 NOT_READY：库级判定不可达（enforce 侧待修项）", async () => {
    await seedFixture(prisma);
    await projectAll();

    const data = await computePreflightData(prisma);
    expect(data.coverage.gap).toBe(0);
    expect(data.coverage.rolesWithoutProjection).toEqual([]);
    expect(data.coverage.scopeRows).toBe(2);
    expect(data.reconcile.summary).toMatchObject({ B: 0, C: 0, S: 0 });
    // A 段可能含 A3（投影动作串恰等于旧档，只报不改的已知噪声）-> 提示不阻断
    expect(data.reconcile.byCode.every((x) => x.kind === "advisory")).toBe(true);

    const r = evaluatePreflight(data, wiredFacts(true));
    expect(r.verdict).toBe("NOT_READY");
    expect(r.blocking.some((b) => b.includes("库级判定不可达"))).toBe(true);

    // 待修项摘掉后回到 READY：证明 evaluate 的分级接线本身正确
    expect(evaluatePreflight(withoutReachabilityGap(data), wiredFacts(true)).verdict).toBe("READY");
    const gated = evaluatePreflight(withoutReachabilityGap(data), wiredFacts(false));
    expect(gated.verdict).toBe("NOT_READY");
    expect(gated.blocking.some((b) => b.includes("AUTHZ_ENFORCE_READY"))).toBe(true);
  });

  it("库级判定不可达：库节点判不到 r/u，但库内表节点判得到（投影层不能补，补了是越权）", async () => {
    await seedFixture(prisma);
    await projectAll();

    const data = await computePreflightData(prisma);
    expect(data.reachability.sampled).toBeGreaterThan(0);
    expect(data.reachability.errors).toBe(0);
    expect(data.reachability.libraryUnreachable).toBeGreaterThan(0);
    // 抽样必须同时看到「库=false / 表并集=true」这一对，否则这条缝测不出来
    expect(data.reachability.samples.some((s) => s.library === false && s.anyTable === true)).toBe(true);
  });

  it("反证：在库节点补一条不带 mask 的 r 会淹没表节点字段收窄（故投影层不能补 r）", async () => {
    await seedFixture(prisma);
    await projectAll();
    const { decide } = await import("../engine.js");
    const subject = {
      userId: "", roleIds: ["r1"], departments: [], deptAncestorIds: [], isWorkspaceOwner: false,
    };
    const tableNode = nodeId("table", "t1");
    const F2 = "f2"; // r1 在 scope 配置里把 f2 设为 hidden

    // 补之前：r1 在 t1 只有窄来源（allow=[f1]），f2 不可见
    const before = await decide({ client: prisma }, subject, tableNode, "r");
    expect(before.decision.allowed).toBe(true);
    expect(before.capability.visibleAll).toBe(false);
    expect(before.capability.visibleFields?.has(F2)).toBe(false);

    // 手工在【库节点】补一条不带 mask 的 r（即"投影补 r"方案）
    await prisma.authPolicy.create({
      data: {
        id: "pol_probe_wide", workspaceId: "ws_default", nodeId: nodeId("base", "b1"),
        subjectType: "role", subjectId: "r1", actions: "r", reason: "probe", createdBy: "tester",
      },
    });

    // 补之后：库节点成为"不裁剪"的宽来源，沿继承进入表节点并集 -> 字段收窄被淹没（越权）
    const after = await decide({ client: prisma }, subject, tableNode, "r");
    expect(after.capability.visibleAll).toBe(true);
    expect(after.capability.visibleFields?.has(F2) ?? true).toBe(true);
  });

  it("库节点有 r 时不计不可达（库级授权本身就存在的场景）", async () => {
    await mkBase(prisma, "b9");
    await mkTable(prisma, "b9", "t9", ["f9"]);
    await mkNode(prisma, "base", "b9", null);
    await mkNode(prisma, "table", "t9", nodeId("base", "b9"));
    await mkRole(prisma, "r9");
    await prisma.workspace.upsert({
      where: { id: "ws_default" }, create: { id: "ws_default", name: "ws_default" }, update: {},
    });
    await mkScope(prisma, { roleId: "r9", libraryId: "b9", visible: 1 });
    // 手工在【库节点】补一条 r（模拟 enforce 侧改走库级并集之前的对照事实）
    await prisma.authPolicy.create({
      data: {
        id: "pol_probe", workspaceId: "ws_default", nodeId: nodeId("base", "b9"),
        subjectType: "role", subjectId: "r9", actions: "r", reason: "manual", createdBy: "tester",
      },
    });

    const data = await computePreflightData(prisma);
    const hit = data.reachability.samples.filter((s) => s.libraryId === "b9" && s.action === "r");
    expect(hit).toEqual([]); // 库=true，不计入不可达
  });
});

describe("C 静态事实分级", () => {
  it("主路径双写钩子缺失 -> 阻断；结构性钩子缺失 -> 仅提示", async () => {
    await seedFixture(prisma);
    await projectAll();
    const data = withoutReachabilityGap(await computePreflightData(prisma));

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
