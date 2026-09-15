// M4/S1 ARCH §5.8 越权矩阵 #2/#3/#7/#8/#9/#10/#10b/#11 引擎直调（不经 HTTP，真库真迁移）。
// 纯 allow：owner/creator 兜底 -> 节点直接 allow -> cutoff 内祖先并集 -> 无 allow 即拒。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  addDeptMembership,
  createDepts,
  createNavNodes,
  createPolicies,
  createRole,
  createUsers,
  assignRole,
  deletePolicy,
  mapCreatedBy,
  setupEngineHarness,
  type EngineHarness,
} from "./engineHarness.js";
import { resolveSubject } from "../subjects.js";
import { decide } from "../engine.js";
import type { AuthzClient, CreatedByResolver, ResolvedSubject } from "../types.js";

let h: EngineHarness;
let db: PrismaClient;

// 节点 id
const B = "n_base";
const T = "n_table";
const L1 = "n_doc1"; // restricted（inheritAncestors=0）
const L2 = "n_doc2"; // 普通继承
const DR = "n_dres"; // 部门授权资源
const L9 = "n_doc9"; // #9 角色部门继承 + 用户直授并存

async function seed(): Promise<void> {
  await createUsers(db, [
    { id: "u_out" }, { id: "u_child" }, { id: "u_multi" }, { id: "u9" },
    { id: "u_v" }, { id: "u_e" }, { id: "u10b" }, { id: "u10c" },
    { id: "u_cr" }, { id: "u_own" },
  ]);

  // 部门树：D（/D/）-> D/S（/D/S/）；D1、D2 平级。
  await createDepts(db, [
    { id: "D", parentId: null, path: "/D/" },
    { id: "DS", parentId: "D", path: "/D/DS/" },
    { id: "D1", parentId: null, path: "/D1/" },
    { id: "D2", parentId: null, path: "/D2/" },
  ]);
  await addDeptMembership(db, [
    { id: "dm_out", departmentId: "D2", userId: "u_out" },
    { id: "dm_child", departmentId: "DS", userId: "u_child" },
    { id: "dm_multi_1", departmentId: "D1", userId: "u_multi" },
    { id: "dm_multi_2", departmentId: "D2", userId: "u_multi", isMain: 0 },
    { id: "dm_9", departmentId: "D", userId: "u9" },
  ]);

  // 角色：role_v（viewer 仅 r，经用户直授）、role_x（#9 经部门 D 继承）。
  await createRole(db, { id: "role_v" });
  await createRole(db, { id: "role_x" });
  await assignRole(db, { roleId: "role_v", subjectType: "user", subjectId: "u_v" });
  await assignRole(db, { roleId: "role_v", subjectType: "user", subjectId: "u10b" });
  await assignRole(db, { roleId: "role_v", subjectType: "user", subjectId: "u10c" });
  await assignRole(db, { roleId: "role_x", subjectType: "dept", subjectId: "D" });
  // workspace owner
  await assignRole(db, { roleId: "role_owner", subjectType: "user", subjectId: "u_own" });

  await createNavNodes(db, [
    { id: B, kind: "base", parentId: null },
    { id: T, kind: "table", parentId: B },
    { id: DR, kind: "doc", parentId: B },
    { id: L9, kind: "doc", parentId: B },
    { id: L2, kind: "doc", parentId: B, inheritAncestors: 1 },
    { id: L1, kind: "doc", parentId: B, inheritAncestors: 0 },
  ]);

  await createPolicies(db, [
    { id: "p_b_rolev", nodeId: B, subjectType: "role", subjectId: "role_v", actions: "r" },
    { id: "p_t_editor", nodeId: T, subjectType: "user", subjectId: "u_e", actions: "c,r,u", fieldMask: '{"allowFields":["f1"]}' },
    { id: "p_dr_deptD", nodeId: DR, subjectType: "dept", subjectId: "D", actions: "r" },
    { id: "p_l9_role", nodeId: L9, subjectType: "role", subjectId: "role_x", actions: "r" },
    { id: "p_l9_user", nodeId: L9, subjectType: "user", subjectId: "u9", actions: "r" },
  ]);
}

beforeAll(async () => {
  h = await setupEngineHarness();
  db = h.prisma;
  await seed();
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

async function sub(userId: string): Promise<ResolvedSubject> {
  return resolveSubject(userId, db as unknown as AuthzClient);
}

function deps(resolveCreatedBy?: CreatedByResolver | null) {
  return { client: db as unknown as AuthzClient, resolveCreatedBy: resolveCreatedBy ?? null };
}

describe("#1 无任何关系：默认拒绝（纯 allow）", () => {
  it("u_out 对库/表 r 均 no_matching_allow", async () => {
    const r = await decide(deps(), await sub("u_out"), T, "r");
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.reason).toBe("no_matching_allow");
    const onBase = await decide(deps(), await sub("u_out"), B, "u");
    expect(onBase.decision.allowed).toBe(false);
    expect(onBase.decision.reason).toBe("no_matching_allow");
  });
});

describe("#2 仅 viewer 角色：r 放行；c/u/d 拒绝", () => {
  it("role_v 仅在库节点授 r，表经祖先继承仅得 r", async () => {
    const s = await sub("u_v");
    expect(s.roleIds).toContain("role_v");
    const r = await decide(deps(), s, T, "r");
    expect(r.decision.allowed).toBe(true);
    expect(r.decision.sources[0]?.kind).toBe("role");
    expect(r.decision.sources[0]?.viaAncestor).toBe(true);
    for (const a of ["c", "u", "d", "comment", "manage_share"] as const) {
      const x = await decide(deps(), s, T, a);
      expect(x.decision.allowed).toBe(false);
    }
  });
});

describe("#3 editor 表级 allow:c,u,r 但字段未授：未授字段键 u 拒绝（整行不写）", () => {
  it("f1 可写，未在 allowFields 的 f2 拒绝", async () => {
    const s = await sub("u_e");
    const ok = await decide(deps(), s, T, "u", { fieldId: "f1" });
    expect(ok.decision.allowed).toBe(true);
    const blocked = await decide(deps(), s, T, "u", { fieldId: "f2" });
    expect(blocked.decision.allowed).toBe(false);
    expect(blocked.decision.reason).toBe("no_matching_allow");
    // r 同样按掩码：f2 不可见
    expect((await decide(deps(), s, T, "r", { fieldId: "f2" })).decision.allowed).toBe(false);
  });
});

describe("#7 部门 D 授权：D 子部门成员放行，D 外成员拒绝", () => {
  it("DS 成员命中祖先部门授予；D2 成员不命中", async () => {
    const child = await decide(deps(), await sub("u_child"), DR, "r");
    expect(child.decision.allowed).toBe(true);
    expect(child.decision.sources[0]?.kind).toBe("dept");
    expect(child.decision.sources[0]?.subjectId).toBe("D");

    const out = await decide(deps(), await sub("u_out"), DR, "r");
    expect(out.decision.allowed).toBe(false);
  });
});

describe("#8 用户多部门（D1 有权/D2 无权）：并集放行", () => {
  it("u_multi 在 D1 与 D2，给 D1 授 r 的资源放行（另建资源与策略隔离）", async () => {
    await db.navNode.create({
      data: { id: "n_d1", workspaceId: "ws_default", parentId: B, kind: "doc", resourceType: "doc", resourceId: "n_d1", name: "n_d1", path: `/${B}/n_d1/`, depth: 2, isSystem: 1, inheritAncestors: 1 },
    });
    await db.authPolicy.create({
      data: { id: "p_d1", workspaceId: "ws_default", nodeId: "n_d1", subjectType: "dept", subjectId: "D1", actions: "r", createdBy: "seed" },
    });
    const yes = await decide(deps(), await sub("u_multi"), "n_d1", "r");
    expect(yes.decision.allowed).toBe(true);
    expect(yes.decision.sources[0]?.subjectId).toBe("D1");
  });
});

describe("#9 角色经部门继承 + 用户直接 allow 并存：并集放行且 O8 同列两来源", () => {
  it("u9 对 L9 的 r 决策来源含 role(dept 继承) 与 direct 两条", async () => {
    const s = await sub("u9");
    expect(s.roleIds).toContain("role_x"); // role_x 经部门 D 继承
    const r = await decide(deps(), s, L9, "r");
    expect(r.decision.allowed).toBe(true);
    const kinds = r.decision.sources.map((x) => x.kind).sort();
    expect(kinds).toEqual(["direct", "role"]);
  });
});

describe("#10/#10b 叶子 inheritAncestors=0：无直接 allow 拒绝；组内某人加直接 allow 放行；移除即恢复", () => {
  it("L1 restricted 对仅继承主体拒绝，同库 L2 继承开仍可访问", async () => {
    const denied = await decide(deps(), await sub("u10b"), L1, "r");
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.reason).toBe("no_matching_allow");
    const sibling = await decide(deps(), await sub("u10b"), L2, "r");
    expect(sibling.decision.allowed).toBe(true); // 同库其他 doc 不受影响
  });

  it("对 u10b 在 L1 加直接 allow -> 放行；u10c 仍拒绝；删除后 u10b 恢复拒绝（O8 收权）", async () => {
    await db.authPolicy.create({
      data: { id: "p_l1_direct", workspaceId: "ws_default", nodeId: L1, subjectType: "user", subjectId: "u10b", actions: "r", createdBy: "seed" },
    });
    const yes = await decide(deps(), await sub("u10b"), L1, "r");
    expect(yes.decision.allowed).toBe(true);
    expect(yes.decision.sources[0]?.kind).toBe("direct");
    expect(yes.decision.sources[0]?.viaAncestor).toBe(false);

    const other = await decide(deps(), await sub("u10c"), L1, "r");
    expect(other.decision.allowed).toBe(false); // 其余继承主体仍拒

    await deletePolicy(db, "p_l1_direct");
    const restored = await decide(deps(), await sub("u10b"), L1, "r");
    expect(restored.decision.allowed).toBe(false);
  });
});

describe("#11 创建人 / workspace owner vs 普通 viewer：restricted 叶子管理动作", () => {
  const resolver = mapCreatedBy({ [L1]: "u_cr" });

  it("创建人对自己创建的 restricted 叶子 manage_share 放行（creator 兜底）", async () => {
    const r = await decide(deps(resolver), await sub("u_cr"), L1, "manage_share");
    expect(r.decision.allowed).toBe(true);
    expect(r.decision.sources[0]?.fallback).toBe("creator");
  });

  it("workspace owner 对 restricted 叶子放行（workspace_owner 兜底），即使无任何策略", async () => {
    const s = await sub("u_own");
    expect(s.isWorkspaceOwner).toBe(true);
    const r = await decide(deps(resolver), s, L1, "manage_share");
    expect(r.decision.allowed).toBe(true);
    expect(r.decision.sources[0]?.fallback).toBe("workspace_owner");
  });

  it("普通 viewer 对 restricted 叶子 manage_share 拒绝", async () => {
    const r = await decide(deps(resolver), await sub("u10c"), L1, "manage_share");
    expect(r.decision.allowed).toBe(false);
  });
});
