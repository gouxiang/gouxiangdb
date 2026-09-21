// M2/S6 停用闭环 + 最后 owner 保护（真迁移临时库 + 真 app + 真 jwt）。
// 覆盖：停用 -> 旧 token 下次请求对 /me 与 /v1 均 401；reactivate 后旧 token 仍 401 须重登；
// 自停用 400；最后 owner 三路径（直接授予唯一 / 部门继承唯一 / 移除授予路径在 roles 已覆盖悬挂）；
// 停用保留成员行；非管理员 403；停用登录 401。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
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
});

describe("停用即时失效（AC-M2-1）", () => {
  it("停用 -> 旧 token 对 /api/auth/me 与 /api/v1/org/members 的下一次请求均 401；登录 401", async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
    await h.createUser("target");
    // 通讯录读取现在是一枚显式权限（可见通讯录），零角色用户读不到；本用例要验的是
    // token 失效，故给 target 挂一枚只带 view_directory 的角色，让"停前可用"成立。
    const dirRole = await h.prisma.role.create({
      data: { id: "role_dir", workspaceId: "ws_default", name: "可看通讯录", isSystem: 0, permissions: '["view_directory"]' },
    });
    await h.grant(dirRole.id, "user", "target");

    const targetToken = await h.token("target", 0);
    const headers = { Authorization: `Bearer ${targetToken}` };
    // 停前可用
    expect((await h.app.request("/api/auth/me", { headers })).status).toBe(200);
    expect((await h.app.request("/api/v1/org/members", { headers })).status).toBe(200);

    const dis = await h.app.request("/api/v1/org/members/target/disable", {
      method: "POST",
      headers: await h.auth("admin"),
    });
    expect(dis.status).toBe(200);
    expect(await json(dis)).toMatchObject({ id: "target", status: "DISABLED" });

    // 旧 token 下次请求两面都 401
    expect((await h.app.request("/api/auth/me", { headers })).status).toBe(401);
    expect((await h.app.request("/api/v1/org/members", { headers })).status).toBe(401);
    // 登录也 401
    const login = await h.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "target@x.com", password: "password123" }),
    });
    expect(login.status).toBe(401);
  });

  it("停用保留 dept_members/授予行，reactivate 后恢复 ACTIVE 但旧 token 仍 401，需重新登录", async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
    await h.createUser("t2");
    // 建部门 + 归属
    const deptRes = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "D" }),
    });
    const deptId = (await json<{ id: string }>(deptRes)).id;
    await h.prisma.deptMember.create({ data: { departmentId: deptId, userId: "t2", isMain: 1 } });

    await h.app.request("/api/v1/org/members/t2/disable", { method: "POST", headers: await h.auth("admin") });
    expect(await h.prisma.deptMember.count({ where: { userId: "t2" } })).toBe(1);
    expect(await h.prisma.roleAssignment.count({ where: { roleId: "role_owner" } })).toBeGreaterThanOrEqual(1);

    const oldToken = await h.token("t2", 0); // 停用时 tv 已 bump 到 1
    // 重新激活
    const re = await h.app.request("/api/v1/org/members/t2/reactivate", {
      method: "POST",
      headers: await h.auth("admin"),
    });
    expect(re.status).toBe(200);
    const reBody = await json<{ status: string; disabledAt: null; tokenVersion: number }>(re);
    expect(reBody.status).toBe("ACTIVE");
    expect(reBody.disabledAt).toBeNull();
    expect(reBody.tokenVersion).toBe(2); // disable +1, reactivate +1

    // 旧 tv=0 token 仍 401（强制重登）
    const oldHeaders = { Authorization: `Bearer ${oldToken}` };
    expect((await h.app.request("/api/auth/me", { headers: oldHeaders })).status).toBe(401);
    // 新登录拿到新 tv token 后 200
    const login = await h.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "t2@x.com", password: "password123" }),
    });
    const { token } = await json<{ token: string }>(login);
    expect((await h.app.request("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    // 归属仍在
    expect(await h.prisma.deptMember.count({ where: { userId: "t2" } })).toBe(1);
  });

  it("重复停用幂等（不重复 bump）", async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
    await h.createUser("t3");
    await h.app.request("/api/v1/org/members/t3/disable", { method: "POST", headers: await h.auth("admin") });
    const second = await h.app.request("/api/v1/org/members/t3/disable", {
      method: "POST", headers: await h.auth("admin"),
    });
    expect(second.status).toBe(200);
    expect((await json<{ tokenVersion: number }>(second)).tokenVersion).toBe(1);
  });
});

describe("自我停用与最后 owner 保护", () => {
  it("owner 停用自己 -> 400", async () => {
    await h.createUser("solo");
    await h.grantSystemRole("solo", "owner");
    const res = await h.app.request("/api/v1/org/members/solo/disable", {
      method: "POST", headers: await h.auth("solo"),
    });
    expect(res.status).toBe(400);
  });

  it("有第二 owner 时可停用其一；直接授予的唯一 owner 被非 owner 管理员停用 -> 409", async () => {
    await h.createUser("a");
    await h.grantSystemRole("a", "owner");
    await h.createUser("b");
    await h.grantSystemRole("b", "owner");
    // 两个 owner：a 停用 b 允许
    const dis = await h.app.request("/api/v1/org/members/b/disable", {
      method: "POST", headers: await h.auth("a"),
    });
    expect(dis.status).toBe(200); // 停用后 b 不进 ACTIVE owner 集合，a 成为唯一 owner

    // c 是持 manage_members 的非 owner 管理员；c 停用最后 owner a -> 409
    await h.createUser("c");
    const role = await h.app.request("/api/v1/org/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("a")) },
      body: JSON.stringify({ name: "成员主管", actions: ["manage_members", "disable_users"] }),
    });
    const roleId = (await json<{ id: string }>(role)).id;
    await h.grant(roleId, "user", "c");
    const last = await h.app.request("/api/v1/org/members/a/disable", {
      method: "POST", headers: await h.auth("c"),
    });
    expect(last.status).toBe(409);
  });

  it("部门继承 owner：仅靠部门授予成为 owner 的成员被停用时同样触发最后 owner 保护", async () => {
    // admin 是操作人（持 manage_members 但通过自定义角色，不是 owner），owner 集合仅 deptOwner（部门授予）
    await h.createUser("admin");
    await h.createUser("deptOwner");
    // 建部门树 root -> child，deptOwner 在 child
    const root = await h.prisma.department.create({
      data: { id: "root", workspaceId: "ws_default", parentId: null, path: "/root/", name: "root", status: "active" },
    });
    await h.prisma.department.create({
      data: { id: "child", workspaceId: "ws_default", parentId: "root", path: "/root/child/", name: "child", status: "active" },
    });
    await h.prisma.deptMember.create({ data: { departmentId: "child", userId: "deptOwner", isMain: 1 } });
    // owner 角色授予部门 root -> 荫及子树 deptOwner（usersWithRole 计入）
    await h.prisma.roleAssignment.create({
      data: { roleId: "role_owner", subjectType: "dept", subjectId: "root", scopeType: "workspace" },
    });
    // admin 仅持 manage_members 自定义角色（非 owner，不进 owner 集合）
    const mgrRole = await h.prisma.role.create({
      data: { id: "role_mgr", workspaceId: "ws_default", name: "mgr", isSystem: 0, permissions: '["manage_members","disable_users"]' },
    });
    await h.prisma.roleAssignment.create({
      data: { roleId: mgrRole.id, subjectType: "user", subjectId: "admin", scopeType: "workspace" },
    });
    void root;

    const res = await h.app.request("/api/v1/org/members/deptOwner/disable", {
      method: "POST", headers: await h.auth("admin"),
    });
    expect(res.status).toBe(409); // 部门继承的 owner 被展开计入，停用即清空 owner 集合
  });

  it("非 manage_members 不能停用他人 -> 403", async () => {
    await h.createUser("x");
    await h.createUser("y");
    const res = await h.app.request("/api/v1/org/members/y/disable", {
      method: "POST", headers: await h.auth("x"),
    });
    expect(res.status).toBe(403);
  });
});

describe("S6 审计事件落 JSONL", () => {
  it("停用/邀请激活产生对应事件，且不泄露密码/激活码明文", async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
    const inv = await h.app.request("/api/v1/org/members/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ email: "audit@x.com", displayName: "Audit" }),
    });
    const inviteBody = await json<{ userId: string }>(inv);
    // 还需第二 owner，否则停用唯一 owner（admin 是唯一 owner，目标非 owner 不受影响）
    await h.createUser("secondowner");
    await h.grantSystemRole("secondowner", "owner");
    const dis = await h.app.request(`/api/v1/org/members/${inviteBody.userId}/disable`, {
      method: "POST", headers: await h.auth("admin"),
    });
    expect(dis.status).toBe(200);

    // 审计目录由 GX_AUDIT_DIR 注入临时目录
    const auditDir = path.join((h as unknown as { tmpDir: string }).tmpDir, ".audit");
    const file = path.join(auditDir, "audit.logl");
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    expect(content).toContain("member_invited");
    expect(content).toContain("member_disabled");
    // 不出现明文激活码（64 hex）或密码字段
    expect(content).not.toMatch(/inviteToken|passwordHash/);
  });
});
