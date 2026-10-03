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
//   - 现状：两边同为 false（库节点没 r）——一致，故本测试当前是绿的；
//   - 走「守卫改活表并集」单侧改动：守卫 true、可见集 false -> 本测试红（这正是要抓的）；
//   - 走「库级可见性」一等语义且 decide 与 scope 同步落地：两边同变 true -> 本测试保持绿。
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

/** on 态下守卫对【库节点】的结论（mode 显式覆盖仅单测用，生产走 effectiveAuthzMode）。 */
async function guardVerdict(): Promise<boolean> {
  const out = await enforceOrLegacy({
    guard: "requireCanView",
    userId: USER_ID,
    ref: { resourceType: "base", resourceId: BASE_ID },
    action: "r",
    legacyAllowed: true, // 第二代口径：visible=1，旧决策放行
    client: prisma as never,
    mode: "on",
  });
  return out.allowed;
}

async function libraryInVisibleScope(): Promise<boolean> {
  const scope = await resolveVisibleNodeIds(prisma as never, USER_ID, { actions: ["r"] });
  return scope.nodeIds.includes(nodeId("base", BASE_ID));
}

describe("守卫口径 <-> 可见集口径", () => {
  it("两者必须一致；且表节点确实可见（否则这条比较是 false==false 的空转）", async () => {
    const scope = await resolveVisibleNodeIds(prisma as never, USER_ID, { actions: ["r"] });
    // 判别力前提：该用户确有库内视野（表节点进可见集），否则两边恒 false，比对无意义。
    expect(scope.nodeIds).toContain(nodeId("table", TABLE_ID));

    const inScope = await libraryInVisibleScope();
    const guarded = await guardVerdict();
    expect(guarded).toBe(inScope);
  });

  it("单侧改动必被抓：只把守卫换成『库内活表并集』而可见集不动 -> 两边分叉", async () => {
    expect(await libraryInVisibleScope()).toBe(false);

    // 模拟 enforceGate 改成「库内活表并集」：直接读表节点结论代替库节点结论
    const { decide } = await import("../engine.js");
    const tableAllowed = (await decide(
      { client: prisma as never },
      await (await import("../subjects.js")).resolveSubject(USER_ID, prisma as never),
      nodeId("table", TABLE_ID),
      "r",
    )).decision.allowed;
    expect(tableAllowed).toBe(true); // 表节点确实给 r

    // 于是守卫会说放行、可见集仍说库不可见 —— 分叉，本哨兵存在的唯一理由
    expect(tableAllowed).not.toBe(await libraryInVisibleScope());
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
