// 守卫口径 <-> 可见集口径 哨兵（两条修路的唯一 CI 报警点）
//
// 为什么必须单列这一条：`scope-parity.test.ts` 对拍的是 decide <-> scope（:161-178），
// 全程不经过 guards/enforceGate。所以：
//   - 修法落在【enforceGate/守卫聚合】层 -> decide 与 scope 都没动 -> scope-parity 恒绿，
//     而守卫已经与可见集分叉了。它抓不到；
//   - 修法落在【decide 内核】层而 scope 没同步 -> decide↔scope 分叉 -> scope-parity 才红。
// 也就是说 scope-parity 只覆盖后者。本文件补的是前者，两条加一起才覆盖全部修路。
//
// 判据形态：同一用户、同一库，【守卫在 on 态的结论】必须等于【该库节点是否在 visible-scope 里】。
//   - 定稿前：两边同为 false（库节点没 r）——一致，本测试绿；
//   - 定稿后：库节点按 enter 投影，守卫判 enter、可见集（preflightScopeVisibility 已同步）也判
//     enter，两边同为 true —— 仍一致，本测试保持绿且具备判别力；
//   - 任一侧单独改动（守卫改动作位而可见集不改 / 反之）-> 分叉，用例 2 会点名。
// 即：它只抓【单侧改动】，不判越权（越权由 preflight.test.ts 的 fieldMask 反证用例守）。

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
let enforceOrLegacy: typeof import("../enforceGate.js")["enforceOrLegacy"];
let resolveVisibleNodeIds: typeof import("../scope.js")["resolveVisibleNodeIds"];

const BASE_ID = "b1";
const TABLE_ID = "t1";
const USER_ID = "u1";

beforeAll(async () => {
  const db = createAuthzTempDb("gx-guard-scope-");
  prisma = db.prisma;
  cleanup = db.cleanup;
  const backfill = await import("../scopeBackfill.js");
  planScopeBackfill = backfill.planScopeBackfill;
  applyScopeBackfill = backfill.applyScopeBackfill;
  const gate = await import("../enforceGate.js");
  enforceOrLegacy = gate.enforceOrLegacy;
  const scope = await import("../scope.js");
  resolveVisibleNodeIds = scope.resolveVisibleNodeIds;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

beforeEach(async () => {
  await resetTables(prisma);
  await seedFixture(prisma);
  const plan = await planScopeBackfill(prisma);
  await prisma.$transaction((tx) => applyScopeBackfill(tx, plan, "tester"));
});

/**
 * on 态下守卫对【库节点】的结论（mode 显式覆盖仅单测用，生产走 effectiveAuthzMode）。
 * 动作位必须与守卫现状一致：requireCanView 判 enter（= legacy access.visible），
 * 内容 r 只投影在 table 节点上，库节点判 r 恒假 —— 用 r 会让本哨兵退化成恒 false 的空转。
 */
async function guardVerdict(): Promise<boolean> {
  const out = await enforceOrLegacy({
    guard: "requireCanView",
    userId: USER_ID,
    ref: { resourceType: "base", resourceId: BASE_ID },
    action: "enter",
    legacyAllowed: true, // 第二代口径：visible=1，旧决策放行
    client: prisma as never,
    mode: "on",
  });
  return out.allowed;
}

/** 可见集对库节点同样按 enter 判定（preflightScopeVisibility 已同步，口径一致才不分叉）。 */
async function libraryInVisibleScope(): Promise<boolean> {
  const scope = await resolveVisibleNodeIds(prisma as never, USER_ID, { actions: ["enter"] });
  return scope.nodeIds.includes(nodeId("base", BASE_ID));
}

describe("守卫口径 <-> 可见集口径", () => {
  it("两者必须一致；且库节点确实在可见集里（否则这条比较是 false==false 的空转）", async () => {
    // 判别力前提：定稿后库节点按 enter 进可见集（P0-B 已修），两边若恒 false 则比对无意义。
    expect(await libraryInVisibleScope()).toBe(true);

    const guarded = await guardVerdict();
    expect(guarded).toBe(true);
    expect(guarded).toBe(await libraryInVisibleScope());
  });

  it("单侧改动必被抓：可见集若仍按 r 判库节点，就与守卫的 enter 口径分叉", async () => {
    // 模拟「可见集那侧没跟着改」：仍按内容 r 判库节点（库节点没有 r -> 不可见）。
    const stale = await resolveVisibleNodeIds(prisma as never, USER_ID, { actions: ["r"] });
    const staleInScope = stale.nodeIds.includes(nodeId("base", BASE_ID));
    expect(staleInScope).toBe(false);

    // 守卫按 enter 放行、可见集按 r 说不可见 -> 分叉。这正是本哨兵存在的唯一理由：
    // 任何一侧单独改动（守卫改动作位 / 可见集改动作位）都会被这里点名。
    expect(await guardVerdict()).not.toBe(staleInScope);
  });

  it("哨兵只抓单侧改动：库节点补 r 时两边同步变 true，不误报（越权另由 fieldMask 用例守）", async () => {
    // 库节点策略行已存在（enter），唯一键冲突，故改写而非新建。
    await prisma.authPolicy.updateMany({
      where: { nodeId: nodeId("base", BASE_ID), subjectType: "role", subjectId: "r1" },
      data: { actions: "enter,r" },
    });
    // decide 与 scope 同内核，补 r 后两边一起翻 -> 哨兵保持绿（它不判这条修路的对错）
    expect(await libraryInVisibleScope()).toBe(true);
    expect(await guardVerdict()).toBe(true);
  });
});
