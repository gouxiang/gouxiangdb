// M4/R1 enforce 接线原语测试（真迁移临时库 + 真引擎 + 直连 Prisma，不经 HTTP）：
//   A. off：原样返回旧决策，engineDecideResource 调用数 = 0（零引擎 SQL 硬证据，spy 锁）；
//   B. shadow：旧决策为准 + 正向对拍（旧允引擎拒 -> OVERDENY，响应结论仍为旧）；
//   C. on（mode 显式演练，总门未翻故生产走不到）：引擎 allow/deny 分别决定放行/拒绝，
//      对拍方向为 reverse；conjunction 语义下引擎更宽也不放行（只减不增）；
//   D. on + 引擎抛错：回落旧决策（fail-safe），计 authz_enforce_error 并打日志，不抛出；
//   E. on + nodeId 为 null：fail-closed 拒绝，计 UNRESOLVED_NODE / enforceUnresolved。
//
// 纪律：adapter.js 顶层 import db 单例，故原语在 setupEngineHarness 注入临时 DATABASE_URL 后
// 动态 import；engineDecideResource 用 vi.mock 包一层计数器（ESM 具名导出不可直接 spy）。
// 末条用例 spy Prisma delegate，restore 后该 delegate 失效（同 shadow-integration 坑），故放最后。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  setupEngineHarness,
  createUsers,
  createRole,
  assignRole,
  createNavNodes,
  createPolicies,
  type EngineHarness,
} from "./engineHarness.js";
import { driftRegistry } from "../shadow.js";

const engineCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock("../adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapter.js")>();
  return {
    ...actual,
    engineDecideResource: (...args: Parameters<typeof actual.engineDecideResource>) => {
      engineCalls.n++;
      return actual.engineDecideResource(...args);
    },
  };
});

let h: EngineHarness;
let prisma: PrismaClient;
let enforceOrLegacy: typeof import("../enforceGate.js").enforceOrLegacy;
let reportEnforceError: typeof import("../enforceGate.js").reportEnforceError;

const NODE = "nav_eg_base";
const REF = { resourceType: "base", resourceId: "eg_base" } as const;
const MISSING_REF = { resourceType: "base", resourceId: "eg_base_no_node" } as const;
const USER = "eg_user";
const OUTSIDER = "eg_outsider";

beforeAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  h = await setupEngineHarness("gx-r1-enforce-");
  prisma = h.prisma;
  ({ enforceOrLegacy, reportEnforceError } = await import("../enforceGate.js"));
  await createUsers(prisma, [{ id: USER }, { id: OUTSIDER }, { id: "eg_super" }]);
  await createRole(prisma, { id: "role_eg", name: "R1 演练角色" });
  await assignRole(prisma, { roleId: "role_eg", subjectType: "user", subjectId: USER });
  await assignRole(prisma, { roleId: "role_owner", subjectType: "user", subjectId: "eg_super" });
  await createNavNodes(prisma, [{ id: NODE, kind: "base", resourceType: "base", resourceId: "eg_base" }]);
  await createPolicies(prisma, [
    { id: "pol_eg_user_r", nodeId: NODE, subjectType: "user", subjectId: USER, actions: "r" },
  ]);
}, 120000);

afterAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  await h.cleanup();
});

beforeEach(() => {
  driftRegistry.reset();
  engineCalls.n = 0;
});

describe("A. off：旧决策为准，零引擎接入", () => {
  it("mode=off 原样返回旧决策，source=legacy，不产生任何引擎调用", async () => {
    const allow = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: true, mode: "off",
    });
    const deny = await enforceOrLegacy({
      guard: "requireCanView", userId: OUTSIDER, ref: REF, action: "r", legacyAllowed: false, mode: "off",
    });
    expect(allow).toEqual({ allowed: true, source: "legacy" });
    expect(deny).toEqual({ allowed: false, source: "legacy" });
    expect(engineCalls.n).toBe(0);
    expect(driftRegistry.snapshot().compared).toBe(0);
  });

  it("缺省（不传 mode）且 env 未设 -> off，同样零引擎调用", async () => {
    delete process.env.GX_AUTHZ_ENGINE;
    const out = await enforceOrLegacy({
      guard: "requireCanEditData", userId: USER, ref: REF, action: "u", legacyAllowed: true,
    });
    expect(out).toEqual({ allowed: true, source: "legacy" });
    expect(engineCalls.n).toBe(0);
  });
});

describe("B. shadow：旧决策仍为准，正向对拍只记数", () => {
  it("旧允引擎拒 -> allowed 仍 true（旧为准）+ OVERDENY=1，direction=forward", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: OUTSIDER, ref: REF, action: "r", legacyAllowed: true, mode: "shadow",
    });
    expect(out.allowed).toBe(true);
    expect(out.source).toBe("legacy");
    expect(out.direction).toBe("forward");
    const s = driftRegistry.snapshot();
    expect(s.overDeny).toBe(1);
    expect(s.compared).toBe(1);
    expect(s.comparedReverse).toBe(0); // 正向期不计入 reverse 桶
    expect(s.recent[0]!.direction).toBe("forward");
  });

  it("两路一致 -> 无 drift，compared=1", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: true, mode: "shadow",
    });
    expect(out.allowed).toBe(true);
    const s = driftRegistry.snapshot();
    expect(s.compared).toBe(1);
    expect(s.overDeny + s.overAllow).toBe(0);
  });
});

describe("C. on：引擎为权威，反向对拍", () => {
  it("引擎 allow -> 放行，source=engine，direction=reverse，drift=null", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: true, mode: "on",
    });
    expect(out.allowed).toBe(true);
    expect(out.source).toBe("engine");
    expect(out.direction).toBe("reverse");
    expect(out.drift).toBeNull();
    expect(out.nodeId).toBe(NODE);
    expect(engineCalls.n).toBe(1);
    const s = driftRegistry.snapshot();
    expect(s.compared).toBe(1);
    expect(s.comparedReverse).toBe(1);
  });

  it("引擎 deny -> 拒绝（旧决策允也拒绝），记 OVERDENY", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: OUTSIDER, ref: REF, action: "r", legacyAllowed: true, mode: "on",
    });
    expect(out.allowed).toBe(false);
    expect(out.source).toBe("engine");
    expect(out.drift).toBe("DRIFT_OVERDENY");
    expect(driftRegistry.snapshot().overDeny).toBe(1);
  });

  it("旧拒引擎允 -> 以引擎为准放行，记 OVERALLOW（越权方向，R2 零容忍项）", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: false, mode: "on",
    });
    expect(out.allowed).toBe(true);
    expect(out.drift).toBe("DRIFT_OVERALLOW");
    expect(driftRegistry.snapshot().overAllow).toBe(1);
  });

  it("conjunction：引擎允 + 旧拒 -> 仍拒绝（只减不增，绝不因引擎更宽放行）", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanDeleteBase", userId: USER, ref: REF, action: "d",
      legacyAllowed: false, mode: "on", semantics: "conjunction",
    });
    expect(out.allowed).toBe(false);
    expect(out.source).toBe("engine");
  });

  it("conjunction：引擎拒 + 旧允 -> 拒绝（引擎是必要条件）", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanDeleteBase", userId: OUTSIDER, ref: REF, action: "d",
      legacyAllowed: true, mode: "on", semantics: "conjunction",
    });
    expect(out.allowed).toBe(false);
  });
});

describe("D. on + 引擎故障：fail-safe 回落旧决策并可观测", () => {
  it("直接调用 reportEnforceError：事件名独立、日志无错误明文、计数进 enforceErrors", () => {
    driftRegistry.reset();
    const sink = vi.fn();
    reportEnforceError(
      { guard: "requireCanView", action: "r", nodeId: NODE, userId: "u-secret" },
      new Error("SELECT boom near secret_table"),
      new Date("2026-09-20T00:00:00Z"),
      sink,
    );
    const line = sink.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      event: "authz_enforce_error", guard: "requireCanView", action: "r", fallback: "legacy",
    });
    expect(line).not.toContain("secret_table");
    expect(line).not.toContain("u-secret");
    const s = driftRegistry.snapshot();
    expect(s.enforceErrors).toBe(1);
    expect(s.errors).toBe(1); // 与 authz_shadow_error 同族同一 error 环形缓冲
    expect(s.recentErrors[0]!.message).toContain("boom"); // 明文仅进进程内缓冲
  });

  it("引擎抛错 -> 结论回落旧决策（不 500、不抛出），enforceErrors=1", async () => {
    // 旧 base 链路不读 workspaces，引擎 navVersionOf 必读 -> 只在引擎侧抛错。
    vi.spyOn(prisma.workspace, "findUnique").mockRejectedValue(new Error("engine boom"));
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: true, mode: "on",
    });
    expect(out.allowed).toBe(true);
    expect(out.source).toBe("legacy");
    expect(out.degraded).toBe(true);
    expect(driftRegistry.snapshot().enforceErrors).toBe(1);
    // 本条 spy 的 restore 会使该 Prisma delegate 失效，故其为文件倒数第二条用例。
    vi.restoreAllMocks();
  });
});

describe("E. on + nodeId 为 null：fail-closed 拒绝并计数", () => {
  it("资源反查不到活 nav 节点 -> 拒绝（即使旧决策允），UNRESOLVED_NODE 与 enforceUnresolved 各 +1", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: MISSING_REF, action: "r", legacyAllowed: true, mode: "on",
    });
    expect(out.allowed).toBe(false);
    expect(out.source).toBe("engine");
    expect(out.nodeId).toBeNull();
    expect(out.unresolvedNode).toBe(true);
    const s = driftRegistry.snapshot();
    expect(s.unresolvedNode).toBe(1);
    expect(s.enforceUnresolved).toBe(1);
    expect(s.compared).toBe(0); // 未解析不当漂移对拍
  });
});

// 放文件最末：Prisma delegate 的 spy 在 restore 后失效，其后不得再跑任何引擎查询。
describe("F. off 零引擎 SQL（Prisma delegate 层硬证据）", () => {
  it("off 态 navNode/authPolicy/workspace 三张引擎表零查询，engineDecideResource 零调用", async () => {
    const delegates = prisma as unknown as Record<string, Record<string, unknown>>;
    const spies = ["findUnique", "findFirst", "findMany", "count"].flatMap((m) =>
      ["navNode", "authPolicy", "workspace"].map(
        (d) => vi.spyOn(delegates[d]!, m as never) as unknown as ReturnType<typeof vi.fn>,
      ),
    );
    const out = await enforceOrLegacy({
      guard: "requireCanDeleteBase", userId: USER, ref: REF, action: "d", legacyAllowed: true, mode: "off",
    });
    expect(out.allowed).toBe(true);
    expect(engineCalls.n).toBe(0);
    expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
  });
});
