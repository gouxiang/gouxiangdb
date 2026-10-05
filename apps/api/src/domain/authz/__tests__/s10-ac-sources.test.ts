// M4/S10 AC-M4-1：去角色留其余来源 + O8 来源链 + 调岗即时生效（真库真 HTTP，不 mock）。
//
// 三源齐全用户 U 对 table A：
//   direct = auth_policies(user:U) 直授 r
//   role   = 角色 R 被节点授 r，U 持 roleAssignment(user->R)
//   dept   = 部门 D 被节点授 r，U 是 D 活成员
// 逐一切断一种来源，每切一次 GET /effective 的 perAction(r).sources 只剩其余来源；
// 调岗（移出 D 入无权部门 / 移入有权部门）下一次请求立即变化——effective 实时求值，
// 无 policyVersion/TTL 等待窗口。另含 owner_fallback 兜底独立例。
//
// 纯域三源展开已在 cutoff/scope-parity 覆盖；本文件锁定【HTTP 请求级】即时性与来源链形状。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  json,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

let h: CharHarness;
let tableNode = "";

const U = "s10_u";
const ROLE = "s10_role_r";
const D_HAVE = "s10_dept_have"; // 被 table 授 r
const D_NONE = "s10_dept_none"; // 无授予
const D_OTHER = "s10_dept_other"; // 另一个被授 r 的部门（调岗恢复目标）

async function sourceKinds(action = "r"): Promise<string[]> {
  const res = await h.app.request(`/api/v1/nodes/${tableNode}/effective`, { headers: await h.auth(U) });
  expect(res.status).toBe(200);
  const body = await json<{
    perAction: Array<{ action: string; allowed: boolean; sources: Array<{ kind: string }> }>;
  }>(res);
  const pa = body.perAction.find((p) => p.action === action);
  expect(pa).toBeTruthy();
  return [...new Set(pa!.sources.map((s) => s.kind))].sort();
}
async function allowed(action: string): Promise<boolean> {
  const res = await h.app.request(`/api/v1/nodes/${tableNode}/effective`, { headers: await h.auth(U) });
  const body = await json<{ perAction: Array<{ action: string; allowed: boolean }> }>(res);
  return body.perAction.find((p) => p.action === action)!.allowed;
}

async function setMembership(userId: string, deptId: string | null): Promise<void> {
  await h.prisma.deptMember.deleteMany({ where: { userId } });
  if (deptId) {
    await h.prisma.deptMember.create({ data: { id: `dm_${userId}_${deptId}`, departmentId: deptId, userId, isMain: 1 } });
  }
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s10-src-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  await h.createUser(U, { email: "u@x.com", displayName: "三源用户" });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });
  const seeded = await seedBaseWithStarter(h, "s10src");
  tableNode = nodeId("table", seeded.tableId);

  await h.prisma.role.create({ data: { id: ROLE, workspaceId: "ws_default", name: "可读角色", isSystem: 0, permissions: "[]" } });
  for (const d of [D_HAVE, D_NONE, D_OTHER]) {
    await h.prisma.department.create({ data: { id: d, workspaceId: "ws_default", parentId: null, path: `/${d}/`, name: d } });
  }
  // 三源授予（都授 r；再加一条 direct 的 comment 证明动作级来源独立）。
  await h.prisma.authPolicy.createMany({
    data: [
      { id: "s10_p_direct", workspaceId: "ws_default", nodeId: tableNode, subjectType: "user", subjectId: U, actions: "r,comment", reason: "policy:v1", createdBy: "seed" },
      { id: "s10_p_role", workspaceId: "ws_default", nodeId: tableNode, subjectType: "role", subjectId: ROLE, actions: "r", reason: "policy:v1", createdBy: "seed" },
      { id: "s10_p_dept", workspaceId: "ws_default", nodeId: tableNode, subjectType: "dept", subjectId: D_HAVE, actions: "r", reason: "policy:v1", createdBy: "seed" },
      { id: "s10_p_dept_other", workspaceId: "ws_default", nodeId: tableNode, subjectType: "dept", subjectId: D_OTHER, actions: "r", reason: "policy:v1", createdBy: "seed" },
    ],
  });
  // U 持角色 + 属有权部门。
  await h.prisma.roleAssignment.create({
    data: { id: "s10_ra_u", roleId: ROLE, subjectType: "user", subjectId: U, scopeType: "workspace", createdBy: "seed" },
  });
  await setMembership(U, D_HAVE);
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("AC-M4-1 三源齐全 -> 逐一切断（每切一次仅留其余来源）", () => {
  it("初始：r 来源链含 direct/dept/role 三类（O8），comment 仅 direct", async () => {
    expect(await sourceKinds("r")).toEqual(["dept", "direct", "role"]);
    expect(await sourceKinds("comment")).toEqual(["direct"]);
    expect(await allowed("r")).toBe(true);
  });

  it("切断 role（移除 role_assignment）：下一次请求 r 只剩 direct/dept，动作仍允许", async () => {
    await h.prisma.roleAssignment.deleteMany({ where: { roleId: ROLE, subjectType: "user", subjectId: U } });
    expect(await sourceKinds("r")).toEqual(["dept", "direct"]);
    // role 移除不影响 direct 独有的 comment。
    expect(await allowed("comment")).toBe(true);
  });

  it("切断 dept（移出有权部门入无权部门）：下一次请求 r 只剩 direct", async () => {
    await setMembership(U, D_NONE);
    expect(await sourceKinds("r")).toEqual(["direct"]);
  });

  it("切断 direct（删直授行）：r 完全失访，来源链空", async () => {
    await h.prisma.authPolicy.delete({ where: { id: "s10_p_direct" } });
    const res = await h.app.request(`/api/v1/nodes/${tableNode}/effective`, { headers: await h.auth(U) });
    // 无 r 即无权查看 effective（路由读门），返回 403；这本身证明最后一源已断。
    expect([403]).toContain(res.status);
  });
});

describe("AC-M4-1 调岗即时性（无 policyVersion/TTL 等待窗口）", () => {
  it("重新建 direct 与 role 后，移入有权部门 D_OTHER，下一次请求 dept 来源立即恢复", async () => {
    // 恢复 direct + role（上一组删掉了 direct/role 绑定）。
    await h.prisma.authPolicy.create({
      data: { id: "s10_p_direct2", workspaceId: "ws_default", nodeId: tableNode, subjectType: "user", subjectId: U, actions: "r", reason: "policy:v1", createdBy: "seed" },
    });
    await h.prisma.roleAssignment.create({
      data: { id: "s10_ra_u2", roleId: ROLE, subjectType: "user", subjectId: U, scopeType: "workspace", createdBy: "seed" },
    });
    // 当前在 D_NONE（无权）：只有 direct/role。
    expect(await sourceKinds("r")).toEqual(["direct", "role"]);
    // 调岗到 D_OTHER（被授 r）：同一 JWT、下一次请求即多 dept，无需刷新 token/等版本。
    await setMembership(U, D_OTHER);
    expect(await sourceKinds("r")).toEqual(["dept", "direct", "role"]);
  });
});

describe("AC-M4-1 owner_fallback 兜底独立例", () => {
  it("base 创建人无任何策略行时 enter 仍允许，来源 kind=owner_fallback 且 fallback=creator、policyId=null", async () => {
    // seeded base 的节点；owner 是创建人（seedBaseWithStarter createdBy=owner）。
    const baseNode = nodeId("base", "s10src_b");
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/effective`, { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<{
      perAction: Array<{ action: string; allowed: boolean; sources: Array<{ kind: string; fallback: string | null; policyId: string | null }> }>;
    }>(res);
    // base 库节点只呈现库门位 enter；创建人兜底同样落在 enter 上。
    expect(body.perAction.some((p) => p.action === "r")).toBe(false);
    const enter = body.perAction.find((p) => p.action === "enter")!;
    expect(enter.allowed).toBe(true);
    const fallback = enter.sources.find((s) => s.kind === "owner_fallback");
    expect(fallback).toBeTruthy();
    expect(fallback!.fallback).toBe("creator");
    expect(fallback!.policyId).toBeNull();
  });
});
