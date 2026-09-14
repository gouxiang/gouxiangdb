// M2/S5 角色管理端到端（真迁移临时库 + 真 app + 真 jwt）。
// 覆盖：系统角色固定序/锁定、自定义角色动作白名单、CRUD、授予 user/dept、PUT 批量 diff、
// 删角色悬挂保护与 reassignTo、scope nodeId 一律 400、越权 403、effective-roles 路由来源。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "./orgHarness.js";

let h: OrgHarness;

beforeAll(async () => {
  h = await setupOrgHarness();
}, 120000);
afterAll(async () => {
  await h.cleanup();
});
beforeEach(async () => {
  await h.reset();
  await h.createUser("admin");
  await h.grantSystemRole("admin", "owner");
});

async function dept(name: string, parentId?: string): Promise<string> {
  const res = await h.app.request("/api/v1/org/departments", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
    body: JSON.stringify({ name, ...(parentId ? { parentId } : {}) }),
  });
  return (await json<{ id: string }>(res)).id;
}

describe("角色列表与系统角色锁定", () => {
  it("列表系统角色固定序在前，仅 owner 持四动作", async () => {
    const res = await h.app.request("/api/v1/org/roles", { headers: await h.auth("admin") });
    const list = await json<Array<{ id: string; systemKey: string | null; isSystem: boolean; actions: string[]; name: string }>>(res);
    expect(list.slice(0, 5).map((r) => r.systemKey)).toEqual([
      "owner", "creator", "editor", "commenter", "viewer",
    ]);
    const owner = list.find((r) => r.systemKey === "owner")!;
    expect(owner.actions.sort()).toEqual(["manage_departments", "manage_members", "manage_menu", "manage_roles"]);
    for (const k of ["creator", "editor", "commenter", "viewer"]) {
      expect(list.find((r) => r.systemKey === k)!.actions).toEqual([]);
    }
  });

  it("系统角色不可删（405）、不可改 name/actions（405），仅 description 可改", async () => {
    const del = await h.app.request("/api/v1/org/roles/role_viewer", {
      method: "DELETE", headers: await h.auth("admin"),
    });
    expect(del.status).toBe(405);

    const rename = await h.app.request("/api/v1/org/roles/role_viewer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "改不了" }),
    });
    expect(rename.status).toBe(405);

    const desc = await h.app.request("/api/v1/org/roles/role_viewer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ description: "更新说明" }),
    });
    expect(desc.status).toBe(200);
    expect((await json<{ description: string }>(desc)).description).toBe("更新说明");
  });
});

describe("自定义角色与动作白名单", () => {
  async function createRole(name: string, actions: unknown) {
    return h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name, actions }),
    });
  }

  it("可建四动作任意子集（M3-S6 含 manage_menu）；非法动作 400；重名 409", async () => {
    const ok = await createRole("成员管理员", ["manage_members"]);
    expect(ok.status).toBe(201);
    expect((await json<{ actions: string[]; isSystem: boolean }>(ok)).actions).toEqual(["manage_members"]);

    // M3-S6：manage_menu 是合法第四枚，自定义角色可勾选。
    const menuRole = await createRole("导航编排员", ["manage_menu"]);
    expect(menuRole.status).toBe(201);
    expect((await json<{ actions: string[] }>(menuRole)).actions).toEqual(["manage_menu"]);

    const bad2 = await createRole("非法动作2", ["drop_table"]);
    expect(bad2.status).toBe(400);

    const dup = await createRole("成员管理员", []);
    expect(dup.status).toBe(409);
  });

  it("仅持 manage_members 的自定义角色不能建角色（需 manage_roles）", async () => {
    await h.createUser("mgr");
    const created = await createRole("成员管理员2", ["manage_members"]);
    const roleId = (await json<{ id: string }>(created)).id;
    await h.grant(roleId, "user", "mgr");

    const attempt = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("mgr")) },
      body: JSON.stringify({ name: "越权", actions: [] }),
    });
    expect(attempt.status).toBe(403);
    // 但 manage_members 动作允许其管成员
    const invite = await h.app.request("/api/v1/org/members/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("mgr")) },
      body: JSON.stringify({ email: "m@x.com", displayName: "M" }),
    });
    expect(invite.status).toBe(201);
  });
});

describe("授予/撤销与 scope 约束", () => {
  async function customRole(actions: string[] = []): Promise<string> {
    const res = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: `R-${Math.random().toString(36).slice(2)}`, actions }),
    });
    return (await json<{ id: string }>(res)).id;
  }

  it("PUT 批量主体集 diff：增删即时生效；授予 dept 后成员经祖先获得角色", async () => {
    const roleId = await customRole();
    await h.createUser("u1");
    await h.createUser("u2");
    const d = await dept("研发");
    await h.prisma.deptMember.create({ data: { departmentId: d, userId: "u1", isMain: 1 } });

    const put = await h.app.request(`/api/v1/org/roles/${roleId}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ subjects: [{ subjectType: "user", subjectId: "u2" }, { subjectType: "dept", subjectId: d }] }),
    });
    expect(put.status).toBe(200);
    const set = await json<{ assignments: Array<{ subjectType: string; subjectId: string }> }>(put);
    expect(set.assignments).toHaveLength(2);

    // u1 经部门 d 获得该角色（来源 dept=d）
    const eff = await h.app.request("/api/v1/org/members/u1/effective-roles", { headers: await h.auth("admin") });
    const effBody = await json<{ roles: Array<{ roleId: string; sources: Array<{ type: string; id: string }> }> }>(eff);
    const mine = effBody.roles.find((r) => r.roleId === roleId)!;
    expect(mine.sources).toEqual([{ type: "dept", id: d, name: "研发" }]);

    // 第二次 PUT 仅留 u2 -> dept 授予被撤销，u1 下次求值即失角色（调岗即时性的撤销侧）
    await h.app.request(`/api/v1/org/roles/${roleId}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ subjects: [{ subjectType: "user", subjectId: "u2" }] }),
    });
    const eff2 = await json<{ roles: Array<{ roleId: string }> }>(
      await h.app.request("/api/v1/org/members/u1/effective-roles", { headers: await h.auth("admin") }),
    );
    expect(eff2.roles.find((r) => r.roleId === roleId)).toBeUndefined();
  });

  it("body 带 nodeId/scopeType!=workspace -> 400；授予不存在用户/部门 -> 400", async () => {
    const roleId = await customRole();
    const node = await h.app.request(`/api/v1/org/roles/${roleId}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ subjects: [{ subjectType: "user", subjectId: "u1" }], nodeId: "x" }),
    });
    expect(node.status).toBe(400);

    const badScope = await h.app.request(`/api/v1/org/roles/${roleId}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ subjects: [], scopeType: "node" }),
    });
    expect(badScope.status).toBe(400);

    const ghost = await h.app.request(`/api/v1/org/roles/${roleId}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ subjects: [{ subjectType: "user", subjectId: "ghost" }] }),
    });
    expect(ghost.status).toBe(400);
  });
});

describe("删角色悬挂保护", () => {
  it("有授予 -> 409 带数；指定 reassignTo 迁移后可删；系统角色 405", async () => {
    const a = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "旧角色", actions: ["manage_members"] }),
    });
    const aId = (await json<{ id: string }>(a)).id;
    const b = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "新角色", actions: [] }),
    });
    const bId = (await json<{ id: string }>(b)).id;
    await h.createUser("u");
    await h.grant(aId, "user", "u");

    const blocked = await h.app.request(`/api/v1/org/roles/${aId}`, {
      method: "DELETE", headers: await h.auth("admin"),
    });
    expect(blocked.status).toBe(409);
    expect(await json<{ error: string }>(blocked)).toMatchObject({ error: expect.stringMatching(/1 条授予/) });

    const moved = await h.app.request(`/api/v1/org/roles/${aId}?reassignTo=${bId}`, {
      method: "DELETE", headers: await h.auth("admin"),
    });
    expect(moved.status).toBe(200);
    // 授予已迁到 b
    const onB = await h.prisma.roleAssignment.findMany({ where: { roleId: bId } });
    expect(onB).toHaveLength(1);
    expect(onB[0].subjectId).toBe("u");
  });
});
