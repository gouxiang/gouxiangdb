// M4/S4 scope 纯函数测试（不触库）：
//   A. scopeSql：clampBudget 三态收敛 + buildVisibleScopeSql 空集/单批 IN/超批/截断四形态，
//      占位符全 "?" 无内插（AC-M5-2 零泄漏工程契约）；
//   B. evaluate 共享内核：buildChain/collectChainPolicies/evaluateChainDecision 表驱动，
//      锁定 decide 与 scope 唯一共用的判定路径（creator -> workspace owner -> 动作命中 -> deny）。

import { describe, expect, it } from "vitest";
import {
  SCOPE_IN_BATCH,
  DEFAULT_SCOPE_BUDGET,
  MAX_SCOPE_BUDGET,
  EMPTY_SCOPE_PREDICATE,
  clampBudget,
  buildVisibleScopeSql,
} from "../scopeSql.js";
import { buildChain, collectChainPolicies, evaluateChainDecision } from "../evaluate.js";
import type { AuthzNode, ResolvedSubject, ScopedPolicy } from "../types.js";

function mkNode(id: string, overrides: Partial<AuthzNode> = {}): AuthzNode {
  return {
    id,
    workspaceId: "ws_default",
    parentId: null,
    kind: "doc",
    resourceType: "doc",
    resourceId: id,
    name: id,
    path: `/${id}/`,
    depth: 0,
    inheritAncestors: 1,
    deletedAt: null,
    ...overrides,
  };
}

function mkPolicy(overrides: Partial<ScopedPolicy> & Pick<ScopedPolicy, "id" | "nodeId">): ScopedPolicy {
  return {
    subjectType: "user",
    subjectId: "u1",
    actions: ["r"],
    fieldMask: null,
    rowConditions: null,
    viaAncestor: false,
    ...overrides,
  };
}

function subject(overrides: Partial<ResolvedSubject> = {}): ResolvedSubject {
  return {
    userId: "u1",
    roleIds: [],
    departments: [],
    deptAncestorIds: [],
    isWorkspaceOwner: false,
    ...overrides,
  };
}

describe("clampBudget", () => {
  it("缺省/非正整数/非整数回落默认 5000", () => {
    expect(clampBudget(undefined)).toBe(DEFAULT_SCOPE_BUDGET);
    expect(clampBudget(0)).toBe(DEFAULT_SCOPE_BUDGET);
    expect(clampBudget(-7)).toBe(DEFAULT_SCOPE_BUDGET);
    expect(clampBudget(1.5)).toBe(DEFAULT_SCOPE_BUDGET);
    expect(clampBudget(Number.NaN)).toBe(DEFAULT_SCOPE_BUDGET);
  });

  it("合法值透传；超硬上限收敛到 20000", () => {
    expect(clampBudget(1)).toBe(1);
    expect(clampBudget(4999)).toBe(4999);
    expect(clampBudget(MAX_SCOPE_BUDGET)).toBe(MAX_SCOPE_BUDGET);
    expect(clampBudget(MAX_SCOPE_BUDGET + 1)).toBe(MAX_SCOPE_BUDGET);
    expect(clampBudget(999_999)).toBe(MAX_SCOPE_BUDGET);
  });
});

describe("buildVisibleScopeSql", () => {
  it("0 节点 -> 空片段/空参数/不要求临时表（消费方用 1=0 永假）", () => {
    const r = buildVisibleScopeSql([], false);
    expect(r).toEqual({ sql: "", params: [], expectsTempTable: false, batches: [] });
    expect(EMPTY_SCOPE_PREDICATE).toBe("1=0");
  });

  it("1..499 节点 -> 全 ? 占位符单批，参数按序、零字面量内插", () => {
    const ids = ["a", "b", "c"];
    const r = buildVisibleScopeSql(ids, false);
    expect(r.sql).toBe("?,?,?");
    expect(r.params).toEqual(ids);
    expect(r.batches).toEqual([ids]);
    expect(r.expectsTempTable).toBe(false);
    expect(r.sql).not.toContain("a"); // id 绝不内插进 SQL 文本
  });

  it("恰好 499 -> 单批 IN；500 -> 必须临时表（超单批变量上限）", () => {
    const atEdge = Array.from({ length: SCOPE_IN_BATCH }, (_, i) => `n${i}`);
    const edge = buildVisibleScopeSql(atEdge, false);
    expect(edge.expectsTempTable).toBe(false);
    expect(edge.sql.split(",").length).toBe(499);
    expect(edge.batches).toHaveLength(1);

    const over = buildVisibleScopeSql([...atEdge, "n499"], false);
    expect(over).toEqual({ sql: "", params: [], expectsTempTable: true, batches: [] });
  });

  it("truncated=true 即便节点很少也必须物化为临时表（预算截断信号优先）", () => {
    const r = buildVisibleScopeSql(["a", "b"], true);
    expect(r).toEqual({ sql: "", params: [], expectsTempTable: true, batches: [] });
  });
});

describe("buildChain / collectChainPolicies", () => {
  it("path 叶->根切段；缺失节点容错跳过", () => {
    const byId = new Map([["x", mkNode("x")], ["g", mkNode("g")]]);
    // path 根->叶 "/g/missing/x/"，reverse 后叶->根，缺失段 missing 容错跳过。
    const target = mkNode("x", { path: "/g/missing/x/" });
    const chain = buildChain(target, byId);
    expect(chain.map((n) => n.id)).toEqual(["x", "g"]);
  });

  it("祖先策略标 viaAncestor，自身策略不标；policyId 去重保链序", () => {
    const x = mkNode("x", { path: "/x/p/", parentId: "p", depth: 1 });
    const p = mkNode("p", { path: "/p/" });
    const policiesByNode = new Map<string, ScopedPolicy[]>([
      ["x", [mkPolicy({ id: "pol_self", nodeId: "x", actions: ["r"] })]],
      ["p", [
        mkPolicy({ id: "pol_anc", nodeId: "p", actions: ["r", "u"] }),
        mkPolicy({ id: "pol_self", nodeId: "p", actions: ["r"] }), // 同 id 去重
      ]],
    ]);
    const out = collectChainPolicies([x, p], policiesByNode);
    expect(out.map((q) => q.id)).toEqual(["pol_self", "pol_anc"]);
    expect(out.find((q) => q.id === "pol_self")!.viaAncestor).toBe(false);
    expect(out.find((q) => q.id === "pol_anc")!.viaAncestor).toBe(true);
  });

  it("cutoff：叶子 inherit=0 时祖先策略不进收集集（私密子树裁剪）", () => {
    const x = mkNode("x", { path: "/x/p/", parentId: "p", depth: 1, inheritAncestors: 0 });
    const p = mkNode("p", { path: "/p/" });
    const policiesByNode = new Map<string, ScopedPolicy[]>([
      ["p", [mkPolicy({ id: "pol_anc", nodeId: "p", actions: ["r"] })]],
    ]);
    const out = collectChainPolicies([x, p], policiesByNode);
    expect(out).toEqual([]);
  });
});

describe("evaluateChainDecision（decide/scope 共享判定内核）", () => {
  const x = mkNode("x", { path: "/x/", name: "X 节点" });

  it("creator 兜底优先于一切：无任何策略也 allow，来源标 creator", () => {
    const d = evaluateChainDecision({
      subject: subject(), node: x, chain: [x], policies: [], action: "u", isCreator: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.sources).toEqual([
      expect.objectContaining({ kind: "owner_fallback", fallback: "creator" }),
    ]);
  });

  it("workspace owner 兜底：非 creator 时全动作 allow，来源标 workspace_owner", () => {
    const d = evaluateChainDecision({
      subject: subject({ isWorkspaceOwner: true }), node: x, chain: [x],
      policies: [], action: "manage_share", isCreator: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.sources[0]!.fallback).toBe("workspace_owner");
  });

  it("直接 user 策略命中动作 -> allow/direct；未承载动作 -> deny/no_matching_allow", () => {
    const pol = mkPolicy({ id: "p1", nodeId: "x", actions: ["r"] });
    const allow = evaluateChainDecision({
      subject: subject(), node: x, chain: [x], policies: [pol], action: "r", isCreator: false,
    });
    expect(allow.allowed).toBe(true);
    expect(allow.sources).toEqual([expect.objectContaining({ kind: "direct", policyId: "p1" })]);

    const deny = evaluateChainDecision({
      subject: subject(), node: x, chain: [x], policies: [pol], action: "u", isCreator: false,
    });
    expect(deny.allowed).toBe(false);
    expect(deny.reason).toBe("no_matching_allow");
    expect(deny.sources).toEqual([]);
  });

  it("role/dept 来源 kind 映射且回传 subjectId；多源并集全部列入", () => {
    const policies = [
      mkPolicy({ id: "pr", nodeId: "x", subjectType: "role", subjectId: "role_editor", actions: ["r"] }),
      mkPolicy({ id: "pd", nodeId: "x", subjectType: "dept", subjectId: "dept_sales", actions: ["r"] }),
    ];
    const d = evaluateChainDecision({
      subject: subject(), node: x, chain: [x], policies, action: "r", isCreator: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.sources.map((s) => s.kind)).toEqual(["role", "dept"]);
    expect(d.sources.map((s) => s.subjectId)).toEqual(["role_editor", "dept_sales"]);
  });

  it("fieldMask 上下文：r 动作字段不在白名单则该策略不构成本次 allow", () => {
    const pol = mkPolicy({
      id: "p1", nodeId: "x", actions: ["r"],
      fieldMask: { allowFields: ["title"] },
    });
    const blocked = evaluateChainDecision({
      subject: subject(), node: x, chain: [x], policies: [pol],
      action: "r", ctx: { fieldId: "salary" }, isCreator: false,
    });
    expect(blocked.allowed).toBe(false);
    const visible = evaluateChainDecision({
      subject: subject(), node: x, chain: [x], policies: [pol],
      action: "r", ctx: { fieldId: "title" }, isCreator: false,
    });
    expect(visible.allowed).toBe(true);
  });
});

// role_admin「库门」角色级兜底（老库零投影也能进门；越权边界锁死）。
// 依据：implicitAdminProject F8（管理员对全部活库恒 visible/enter）+ guards P0-A（库门判 enter）。
describe("evaluateChainDecision · role_admin 库门兜底", () => {
  const admin = () => subject({ roleIds: ["role_admin"] });
  const base = mkNode("b1", { resourceType: "base", kind: "base", path: "/b1/", name: "老库" });
  const kb = mkNode("k1", { resourceType: "kb", kind: "kb", path: "/k1/", name: "老知识库" });
  const table = mkNode("t1", { resourceType: "table", kind: "table", path: "/b1/t1/", name: "客户表" });

  it("老库零物化投影：管理员对 base 的 enter 仍 allow，来源标 role/role_admin", () => {
    const d = evaluateChainDecision({
      subject: admin(), node: base, chain: [base], policies: [], action: "enter", isCreator: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.sources).toEqual([
      expect.objectContaining({ kind: "role", subjectId: "role_admin" }),
    ]);
  });

  it("kb 库门 enter 同样兜底", () => {
    const d = evaluateChainDecision({
      subject: admin(), node: kb, chain: [kb], policies: [], action: "enter", isCreator: false,
    });
    expect(d.allowed).toBe(true);
  });

  it("越权边界：不兜内容动作（base r / table r 零投影即 deny），守住 §1.3 字段掩码口", () => {
    const baseR = evaluateChainDecision({
      subject: admin(), node: base, chain: [base], policies: [], action: "r", isCreator: false,
    });
    expect(baseR.allowed).toBe(false);
    const tableR = evaluateChainDecision({
      subject: admin(), node: table, chain: [table], policies: [], action: "r", isCreator: false,
    });
    expect(tableR.allowed).toBe(false);
  });

  it("越权边界：不兜管理权（edit_data/manage_table/manage_schema/manage_share）零投影即 deny", () => {
    for (const a of ["edit_data", "manage_table", "manage_schema", "manage_share"] as const) {
      const d = evaluateChainDecision({
        subject: admin(), node: base, chain: [base], policies: [], action: a, isCreator: false,
      });
      expect(d.allowed, a).toBe(false);
    }
  });

  it("越权边界：不兜删库（base d 零投影即 deny；删库另有 conjunction 硬规则）", () => {
    const d = evaluateChainDecision({
      subject: admin(), node: base, chain: [base], policies: [], action: "d", isCreator: false,
    });
    expect(d.allowed).toBe(false);
  });

  it("非管理员角色不享受该兜底：只有 enter 也不给（避免任何角色天然进库）", () => {
    const editor = subject({ roleIds: ["role_editor"] });
    const d = evaluateChainDecision({
      subject: editor, node: base, chain: [base], policies: [], action: "enter", isCreator: false,
    });
    expect(d.allowed).toBe(false);
  });
});
