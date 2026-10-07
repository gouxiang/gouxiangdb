// enforce 接线原语测试（真迁移临时库 + 真引擎 + 直连 Prisma，不经 HTTP）：
// 权限引擎已永久单一化，enforceOrLegacy 恒定由引擎裁决，无 off/shadow/on、无对拍/drift：
//   A. 引擎 allow/deny：分别放行/拒绝，source 恒为 "engine"，nodeId 为反查节点；
//   B. conjunction（删库/删知识库专用）：只减不增——legacy ∧ engine，任一假即拒；
//   C. 引擎抛错 -> fail-closed：抛 HttpError(503,"权限服务暂不可用")，绝不回落；
//   D. 资源反查不到活 nav 节点 -> fail-closed：{ allowed:false, source:"engine", nodeId:null }。
//
// 纪律：adapter.js 顶层 import db 单例，故原语在 setupEngineHarness 注入临时 DATABASE_URL 后
// 动态 import。引擎抛错用例 spy Prisma delegate，restore 后该 delegate 失效，故放最后。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { HttpError } from "../../../httpError.js";

let h: EngineHarness;
let prisma: PrismaClient;
let enforceOrLegacy: typeof import("../enforceGate.js").enforceOrLegacy;

const NODE = "nav_eg_base";
const REF = { resourceType: "base", resourceId: "eg_base" } as const;
const MISSING_REF = { resourceType: "base", resourceId: "eg_base_no_node" } as const;
const USER = "eg_user";
const OUTSIDER = "eg_outsider";

beforeAll(async () => {
  h = await setupEngineHarness("gx-r1-enforce-");
  prisma = h.prisma;
  ({ enforceOrLegacy } = await import("../enforceGate.js"));
  await createUsers(prisma, [{ id: USER }, { id: OUTSIDER }]);
  await createRole(prisma, { id: "role_eg", name: "R1 演练角色" });
  await assignRole(prisma, { roleId: "role_eg", subjectType: "user", subjectId: USER });
  await createNavNodes(prisma, [{ id: NODE, kind: "base", resourceType: "base", resourceId: "eg_base" }]);
  await createPolicies(prisma, [
    // USER 有内容读 r + 删除必要位 d（供 conjunction 用例）；OUTSIDER 无任何策略。
    { id: "pol_eg_user_rd", nodeId: NODE, subjectType: "user", subjectId: USER, actions: "r,d" },
  ]);
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("A. 引擎为唯一权威：allow/deny", () => {
  it("引擎 allow -> 放行，source=engine，nodeId 为反查节点", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: false,
    });
    // authority 语义（默认）：即便 legacyAllowed=false，也以引擎为准放行。
    expect(out).toMatchObject({ allowed: true, source: "engine", nodeId: NODE });
  });

  it("引擎 deny -> 拒绝（即使 legacyAllowed=true），source=engine", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: OUTSIDER, ref: REF, action: "r", legacyAllowed: true,
    });
    expect(out.allowed).toBe(false);
    expect(out.source).toBe("engine");
    expect(out.nodeId).toBe(NODE);
  });
});

describe("B. conjunction：只减不增（legacy ∧ engine）", () => {
  it("引擎允 + legacy 拒 -> 仍拒绝", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanDeleteBase", userId: USER, ref: REF, action: "d",
      legacyAllowed: false, semantics: "conjunction",
    });
    expect(out.allowed).toBe(false);
    expect(out.source).toBe("engine");
  });

  it("引擎允 + legacy 允 -> 放行", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanDeleteBase", userId: USER, ref: REF, action: "d",
      legacyAllowed: true, semantics: "conjunction",
    });
    expect(out.allowed).toBe(true);
  });

  it("引擎拒 + legacy 允 -> 拒绝（引擎是必要条件）", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanDeleteBase", userId: OUTSIDER, ref: REF, action: "d",
      legacyAllowed: true, semantics: "conjunction",
    });
    expect(out.allowed).toBe(false);
  });
});

describe("C. 引擎故障：fail-closed 抛 503，绝不回落", () => {
  it("引擎内部抛错 -> 抛 HttpError 503『权限服务暂不可用』，不返回任何旧决策", async () => {
    vi.spyOn(prisma.workspace, "findUnique").mockRejectedValue(new Error("engine boom"));
    let caught: unknown;
    try {
      await enforceOrLegacy({
        guard: "requireCanView", userId: USER, ref: REF, action: "r", legacyAllowed: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(503);
    expect((caught as HttpError).message).toBe("权限服务暂不可用");
    // 本条 spy 的 restore 会使该 Prisma delegate 失效，故本文件用例到此为止。
    vi.restoreAllMocks();
  });
});

describe("D. 资源反查不到活节点：fail-closed 拒绝", () => {
  it("nodeId=null -> allowed=false、source=engine、nodeId=null（即使 legacyAllowed=true）", async () => {
    const out = await enforceOrLegacy({
      guard: "requireCanView", userId: USER, ref: MISSING_REF, action: "r", legacyAllowed: true,
    });
    expect(out.allowed).toBe(false);
    expect(out.source).toBe("engine");
    expect(out.nodeId).toBeNull();
  });
});
