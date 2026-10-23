// M2/S5 角色管理端到端（真迁移临时库 + 真 app + 真 jwt）。
// 覆盖：系统角色固定序/锁定、自定义角色动作白名单、CRUD、授予 user/dept、PUT 批量 diff、
// 删角色悬挂保护与 reassignTo、scope nodeId 一律 400、越权 403、effective-roles 路由来源。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "./orgHarness.js";
import { ORG_ACTIONS } from "@gx/shared-types";

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
  it("列表系统角色固定序在前，超级管理员/管理员持全部 ORG_ACTIONS", async () => {
    const res = await h.app.request("/api/v1/org/roles", { headers: await h.auth("admin") });
    const list = await json<Array<{ id: string; systemKey: string | null; isSystem: boolean; actions: string[]; name: string }>>(res);
    // 三枚权限预设在前，其后为 M4 资源名锚点，最后是自定义角色。
    expect(list.slice(0, 7).map((r) => r.systemKey)).toEqual([
      "super_admin", "admin", "restricted", "creator", "editor", "commenter", "viewer",
    ]);
    const all = [...ORG_ACTIONS].sort();
    expect(list.find((r) => r.id === "role_owner")!.actions.sort()).toEqual(all);
    expect(list.find((r) => r.id === "role_admin")!.actions.sort()).toEqual(all);
    expect(list.find((r) => r.systemKey === "restricted")!.actions).toEqual([]);
    for (const k of ["creator", "editor", "commenter", "viewer"]) {
      // 四枚资源锚点系统角色没有任何管理动作，但迁移 20260920220000 给它们补了读基线
      // view_directory（原来登录即可读通讯录，不能因为加守卫让被授予它们的人突然失读）。
      // 写动作一枚都不给——能不能改通讯录仍然只能由管理员勾选自定义角色决定。
      expect(list.find((r) => r.systemKey === k)!.actions).toEqual(["view_directory"]);
    }
  });

  it("immutable 角色不可删（405）、连 description 也不可改（405）", async () => {
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

    // 权限核心模型：immutable=1 的角色完全钉死，说明也不再开放——
    // 否则「不可编辑」只挡住名字，实际口径仍是半开。
    const desc = await h.app.request("/api/v1/org/roles/role_viewer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ description: "更新说明" }),
    });
    expect(desc.status).toBe(405);
  });

  it("管理员/受限成员是预置但 immutable=0：可改名（断言后还原，不破坏后续用例）", async () => {
    const listed = await h.app.request("/api/v1/org/roles", { headers: await h.auth("admin") });
    expect(listed.status).toBe(200);
    const rows = (await json<Array<{ id: string; immutable: boolean }>>(listed));
    expect(rows.find((r) => r.id === "role_owner")!.immutable).toBe(true);
    expect(rows.find((r) => r.id === "role_admin")!.immutable).toBe(false);
    expect(rows.find((r) => r.id === "role_restricted")!.immutable).toBe(false);

    const rename = await h.app.request("/api/v1/org/roles/role_admin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "二级管理员" }),
    });
    expect(rename.status).toBe(200);
    expect((await json<{ name: string }>(rename)).name).toBe("二级管理员");
    // 还原（同一文件内用例共用一套库，不把预设行留在改名状态）。
    await h.app.request("/api/v1/org/roles/role_admin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "管理员" }),
    });
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

  it("可建任意动作子集（M6 含 create_library）；非法动作 400 文案由 ORG_ACTIONS 派生；重名 409", async () => {
    const ok = await createRole("成员管理员", ["manage_members"]);
    expect(ok.status).toBe(201);
    expect((await json<{ actions: string[]; isSystem: boolean }>(ok)).actions).toEqual(["manage_members"]);

    // M3-S6：manage_menu 是合法第四枚，自定义角色可勾选。
    const menuRole = await createRole("导航编排员", ["manage_menu"]);
    expect(menuRole.status).toBe(201);
    expect((await json<{ actions: string[] }>(menuRole)).actions).toEqual(["manage_menu"]);

    // M4-S5：manage_share 是合法第五枚，自定义角色可勾选。
    const shareRole = await createRole("授权管理员", ["manage_share"]);
    expect(shareRole.status).toBe(201);
    expect((await json<{ actions: string[] }>(shareRole)).actions).toEqual(["manage_share"]);

    // M6：create_library 是合法第六枚，自定义角色可勾选（建库/建知识库权限门）。
    const libRole = await createRole("建库权限", ["create_library"]);
    expect(libRole.status).toBe(201);
    expect((await json<{ actions: string[] }>(libRole)).actions).toEqual(["create_library"]);

    // 非法动作 400，文案必须由 ORG_ACTIONS 派生列出全部动作（派生而非硬编码，加动作位不回退）。
    const bad2 = await createRole("非法动作2", ["drop_table"]);
    expect(bad2.status).toBe(400);
    const badBody = await json<{ error: string }>(bad2);
    expect(badBody.error).toBe(
      `存在非法组织管理动作（仅允许 ${[...ORG_ACTIONS].join("/")}）`,
    );
    for (const a of ORG_ACTIONS) {
      expect(badBody.error).toContain(a);
    }

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

    // 企业化定位后，成员管理拆成 invite_users/create_users/disable_users/delete_users 四枚：
    // 本次新建的角色只勾了 manage_members，它就只有 manage_members 那一件（调岗/兼岗），
    // 不能邀请。想邀必须显式勾 invite_users——这正是「细粒度可按角色分别授予」要达到的效果。
    const noInvite = await h.app.request("/api/v1/org/members/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("mgr")) },
      body: JSON.stringify({ email: "m@x.com", displayName: "M" }),
    });
    expect(noInvite.status).toBe(403);
  });

  it("补勾 invite_users 后同一个角色即可邀请（验收口径：能力来自勾选，不来自 manage_members）", async () => {
    await h.createUser("mgr2");
    const created = await createRole("成员管理员3", ["manage_members", "invite_users"]);
    const roleId = (await json<{ id: string }>(created)).id;
    await h.grant(roleId, "user", "mgr2");

    const invite = await h.app.request("/api/v1/org/members/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("mgr2")) },
      body: JSON.stringify({ email: "m2@x.com", displayName: "M2" }),
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

describe("提权硬闸：非超级管理员不得授予管理员/超级管理员（#1046c）", () => {
  async function putAssignments(token: string, roleId: string, subjects: unknown) {
    return h.app.request(`/api/v1/org/roles/${roleId}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ subjects }),
    });
  }

  it("持 role_admin 的管理员授予管理员/超级管理员 -> 均 403，且授予行未落库", async () => {
    // 操作人：role_admin 持全部 ORG_ACTIONS（含 assign_role_members），但不是超级管理员。
    await h.createUser("mgr");
    await h.grant("role_admin", "user", "mgr");
    await h.createUser("target");

    const mgrToken = await h.token("mgr");
    const toAdmin = await putAssignments(mgrToken, "role_admin", [{ subjectType: "user", subjectId: "target" }]);
    expect(toAdmin.status).toBe(403);
    const toOwner = await putAssignments(mgrToken, "role_owner", [{ subjectType: "user", subjectId: "target" }]);
    expect(toOwner.status).toBe(403);
    expect((await json<{ error: string }>(toOwner)).error).toContain("仅超级管理员");

    // 硬闸在写事务前拦截：target 未获得任何管理员级角色，mgr 也没能把自己提权。
    const rows = await h.prisma.roleAssignment.findMany({
      where: { roleId: { in: ["role_admin", "role_owner"] }, subjectId: "target" },
    });
    expect(rows).toHaveLength(0);
    const selfPromo = await putAssignments(mgrToken, "role_owner", [{ subjectType: "user", subjectId: "mgr" }]);
    expect(selfPromo.status).toBe(403);
  });

  it("仅持 assign_role_members 的自定义角色封官 -> 403（动作位够、身份不够）", async () => {
    await h.createUser("mgr2");
    const created = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "封官员", actions: ["assign_role_members"] }),
    });
    const roleId = (await json<{ id: string }>(created)).id;
    await h.grant(roleId, "user", "mgr2");
    await h.createUser("target2");

    const res = await putAssignments(await h.token("mgr2"), "role_admin", [
      { subjectType: "user", subjectId: "target2" },
    ]);
    expect(res.status).toBe(403);
  });

  it("超级管理员授予管理员/超级管理员 -> 200（白名单不是无脑拦死）", async () => {
    // beforeEach 已建 admin 并授 role_owner。另建两名 target 分别授 admin / owner。
    await h.createUser("toAdmin");
    await h.createUser("toOwner");
    const ownerToken = await h.token("admin");

    const r1 = await putAssignments(ownerToken, "role_admin", [{ subjectType: "user", subjectId: "toAdmin" }]);
    expect(r1.status).toBe(200);
    expect((await json<{ added: unknown[] }>(r1)).added).toHaveLength(1);

    // 授 role_owner 时库里已有 admin 这位在岗 owner，不触发最后 owner 保护，应放行。
    const r2 = await putAssignments(ownerToken, "role_owner", [
      { subjectType: "user", subjectId: "admin" },
      { subjectType: "user", subjectId: "toOwner" },
    ]);
    expect(r2.status).toBe(200);
    expect((await h.prisma.roleAssignment.findMany({ where: { roleId: "role_admin", subjectId: "toAdmin" } }))).toHaveLength(1);
    expect((await h.prisma.roleAssignment.findMany({ where: { roleId: "role_owner", subjectId: "toOwner" } }))).toHaveLength(1);
  });

  it("非 owner 维护普通/自定义角色成员仍放行（闸门只护两枚管理员级角色）", async () => {
    await h.createUser("mgr3");
    await h.grant("role_admin", "user", "mgr3"); // 持全部动作，非超级管理员
    await h.createUser("plain");
    const created = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "普通角色", actions: ["manage_members"] }),
    });
    const customId = (await json<{ id: string }>(created)).id;

    const custom = await putAssignments(await h.token("mgr3"), customId, [
      { subjectType: "user", subjectId: "plain" },
    ]);
    expect(custom.status).toBe(200);

    const restricted = await putAssignments(await h.token("mgr3"), "role_restricted", [
      { subjectType: "user", subjectId: "plain" },
    ]);
    expect(restricted.status).toBe(200);
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
