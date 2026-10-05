// M4/S5 开关往返 + legacyUnmappable 数据不变量（裁决 A-5，§7-S5 验收①②）。
//
// 阶段门约束（S5）：AUTHZ_ENFORCE_READY=false，GX_AUTHZ_ENGINE=on 在本阶段降级 shadow——
// 守卫永不以引擎为准（S6 翻门后才变）。故"不可映射授权在 off 失效、重开恢复"在 S5 只能、
// 也必须在【权威数据层】证明，而不是 HTTP 守卫响应：
//   1. 角色授予（不可映射旧三表）经 PUT 落 auth_policies，200 带 legacyUnmappable，旧表零行；
//   2. 无论 flag off/shadow/on 如何往返，auth_policies 权威行始终保留、动作串不回灌不删除；
//   3. 引擎 decide 与 flag 无关（flag 只作用于守卫是否采信），权威行恒被求值 -> 重开即恢复；
//   4. 旧三表（members）在往返全程对该用户零行——不可映射授权绝不污染旧权威，off 期旧决策不受其影响。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupEngineHarness,
  createUsers,
  createRole,
  assignRole,
  createNavNodes,
  type EngineHarness,
} from "./engineHarness.js";
// 注意纪律：任何【运行时】拉 db 单例的模块（policyAdminTx 用单例、subjects ->
// org/authorization -> db）都禁止顶层静态 import，否则 db.ts 在 setupEngineHarness 注入
// globalThis.__gx_prisma 之前求值、单例绑到默认库。setup 后首次 await import 才是正确单例。
// decide 纯 db-free（只收注入 client），可静态；resolveSubject 改动态。
import { decide } from "../engine.js";
import { authzShadowActive } from "../../../configAuthz.js";
import type { applyPolicyBatch as ApplyPolicyBatch } from "../policyAdminTx.js";
import type { resolveSubject as ResolveSubject } from "../subjects.js";

let h: EngineHarness;
let applyPolicyBatch: typeof ApplyPolicyBatch;
let resolveSubject: typeof ResolveSubject;
const baseNode = "nav_base_s5tog";

beforeAll(async () => {
  h = await setupEngineHarness("gx-s5-toggle-");
  await createUsers(h.prisma, [{ id: "ru" }]);
  await createRole(h.prisma, { id: "role_tog", name: "只读角色" });
  await assignRole(h.prisma, { roleId: "role_tog", subjectType: "user", subjectId: "ru" });
  await createNavNodes(h.prisma, [{ id: baseNode, kind: "base", resourceType: "base", resourceId: "s5tog_base" }]);
  // 注入完成后首次动态 import：db 单例此刻才按临时库求值。
  ({ applyPolicyBatch } = await import("../policyAdminTx.js"));
  ({ resolveSubject } = await import("../subjects.js"));
}, 120000);

beforeEach(() => {
  process.env.GX_AUTHZ_ENGINE = "off";
});

afterAll(async () => {
  process.env.GX_AUTHZ_ENGINE = "off";
  await h.cleanup();
});

describe("不可映射（角色）授权：落权威表、不回灌旧表、开关往返行恒保留", () => {
  it("PUT 角色授予 -> 200 带 legacyUnmappable，members 旧表零行，auth_policies 有行", async () => {
    // ADR-0056 后 base 节点禁手授内容位（r 等会无 mask 下放），改用合法的库门 enter；
    // 主体仍为 role，依旧不可映射旧三表（旧表只承载 per-user），本测试不变量不变。
    const res = await applyPolicyBatch(baseNode, {
      upserts: [{ subjectType: "role", subjectId: "role_tog", actions: ["enter"] }],
    }, "test-admin");

    const item = res.legacyUnmappable.find((x) => x.subjectType === "role" && x.subjectId === "role_tog");
    expect(item).toBeTruthy();
    expect(item!.reasons.length).toBeGreaterThan(0);

    // 旧三表永不承载角色授予（无对应实体 base 成员行，亦无投影）。
    expect(await h.prisma.member.count({ where: { userId: "ru" } })).toBe(0);
    // 权威表行落地。
    const pol = await h.prisma.authPolicy.findFirst({
      where: { nodeId: baseNode, subjectType: "role", subjectId: "role_tog" },
    });
    expect(pol).not.toBeNull();
    expect(pol!.actions).toBe("enter");
  });

  it.each([
    ["off", false],
    ["shadow", true],
    ["on", true], // S5 阶段门：on 降级 shadow，shadowActive=true
    ["off", false],
  ])("flag=%s 往返：权威行保留且旧表仍零行（shadowActive=%s）", async (mode, shadow) => {
    process.env.GX_AUTHZ_ENGINE = mode;
    expect(authzShadowActive()).toBe(shadow);

    const pol = await h.prisma.authPolicy.findFirst({
      where: { nodeId: baseNode, subjectType: "role", subjectId: "role_tog" },
    });
    expect(pol).not.toBeNull();
    expect(pol!.actions).toBe("enter");
    expect(await h.prisma.member.count({ where: { userId: "ru" } })).toBe(0);
  });

  it("引擎 decide 与 flag 无关：off 下权威行仍被求值为 allow（重开即恢复的根据）", async () => {
    process.env.GX_AUTHZ_ENGINE = "off";
    const subject = await resolveSubject("ru", h.prisma);
    const result = await decide({ client: h.prisma }, subject, baseNode, "enter");
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.sources.some((s) => s.kind === "role")).toBe(true);
  });
});
