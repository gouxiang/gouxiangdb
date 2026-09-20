// 企业化定位：通讯录五件套的路由守卫与「删除用户」端到端（真迁移临时库 + 真 app，不 mock）。
//
// 为什么必须有这一组：此前的口径是「登录即可读全员 + manage_members 一把梭管写」，
// 拆成五枚后每一枚的挂载如果接错，表现是**静默**的——要么多余的人仍能删账号（权限放大），
// 要么管理员突然建不了号（能力收回）。两种都不会报错，只能靠钉住 HTTP 状态码发现。
//
// 覆盖：
//   1. 读：GET /org/members 与 GET /org/roles 只认 view_directory；写动作不蕴含读。
//   2. 写：invite/create_users/disable_users/delete_users 各自独立生效、互不串台。
//   3. 删除：成功 200 + 悬挂授予清理；自删 400；删掉最后一位在岗 owner 409；无权限 403。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { json, setupOrgHarness, type OrgHarness } from "./orgHarness.js";

let h: OrgHarness;

/** 建自定义角色并授予某用户（到底是哪些动作由用例显式给，不依赖迁移之后的系统角色）。 */
async function grantActions(userId: string, actions: string[], seed = Date.now()): Promise<string> {
  const roleId = `role_${userId}_${seed}`;
  await h.prisma.role.create({
    data: {
      id: roleId,
      workspaceId: "ws_default",
      systemKey: null,
      name: roleId,
      description: "",
      isSystem: 0,
      permissions: JSON.stringify(actions),
    },
  });
  await h.prisma.roleAssignment.create({
    data: {
      roleId,
      subjectType: "user",
      subjectId: userId,
      scopeType: "workspace",
      createdBy: "test-admin",
    },
  });
  return roleId;
}

beforeAll(async () => {
  h = await setupOrgHarness();
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  await h.reset();
  await h.prisma.role.deleteMany({ where: { isSystem: 0 } });
});

describe("读：view_directory 是通讯录的唯一入口钥匙", () => {
  it("无任何角色的成员 GET /org/members -> 403", async () => {
    await h.createUser("u_plain");
    const res = await h.app.request("/api/v1/org/members", { headers: await h.auth("u_plain") });
    expect(res.status).toBe(403);
  });

  it("只持 view_directory -> 可读成员列表与角色列表", async () => {
    await h.createUser("u_read");
    await grantActions("u_read", ["view_directory"], 1);
    const members = await h.app.request("/api/v1/org/members", { headers: await h.auth("u_read") });
    expect(members.status).toBe(200);
    const roles = await h.app.request("/api/v1/org/roles", { headers: await h.auth("u_read") });
    expect(roles.status).toBe(200);
  });

  it("写动作不蕴含读：只持 invite_users 的人读不到通讯录", async () => {
    await h.createUser("u_inv");
    await grantActions("u_inv", ["invite_users"], 2);
    const res = await h.app.request("/api/v1/org/members", { headers: await h.auth("u_inv") });
    expect(res.status).toBe(403);
  });
});

describe("写：四枚成员动作各自独立生效", () => {
  it("invite_users -> POST /org/members/invite 201；只有 view_directory 则 403", async () => {
    await h.createUser("u_ok");
    await h.createUser("u_ro");
    await grantActions("u_ok", ["invite_users"], 3);
    await grantActions("u_ro", ["view_directory"], 4);

    const ok = await h.app.request("/api/v1/org/members/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("u_ok")) },
      body: JSON.stringify({ email: "invitee@x.com", displayName: "被邀请人" }),
    });
    expect(ok.status).toBe(201);

    const denied = await h.app.request("/api/v1/org/members/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("u_ro")) },
      body: JSON.stringify({ email: "other@x.com", displayName: "另一个" }),
    });
    expect(denied.status).toBe(403);
  });

  it("create_users -> POST /org/members 201；只有 invite_users 则不能建号", async () => {
    await h.createUser("u_cre");
    await h.createUser("u_invonly");
    await grantActions("u_cre", ["create_users"], 5);
    await grantActions("u_invonly", ["invite_users"], 6);

    const ok = await h.app.request("/api/v1/org/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("u_cre")) },
      body: JSON.stringify({ email: "made@x.com", displayName: "直接建", password: "password123" }),
    });
    expect(ok.status).toBe(201);

    const denied = await h.app.request("/api/v1/org/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("u_invonly")) },
      body: JSON.stringify({ email: "made2@x.com", displayName: "建不了", password: "password123" }),
    });
    expect(denied.status).toBe(403);
  });

  it("disable_users -> POST /:id/disable 200（在此之前该权限位是 manage_members）", async () => {
    await h.createUser("u_admin");
    await h.createUser("u_target");
    await grantActions("u_admin", ["disable_users"], 7);

    const res = await h.app.request("/api/v1/org/members/u_target/disable", {
      method: "POST",
      headers: await h.auth("u_admin"),
    });
    expect(res.status).toBe(200);
    const row = await h.prisma.user.findUnique({ where: { id: "u_target" } });
    expect(row!.status).toBe("DISABLED");
  });
});

describe("DELETE /org/members/:id 删除用户", () => {
  it("成功删除：账号消失，且抹掉级联覆盖不到的 role_assignments 授予行", async () => {
    await h.createUser("u_del");
    await h.createUser("u_gone", { status: "INVITED" });
    const roleId = await grantActions("u_del", ["delete_users"], 8);
    await grantActions("u_gone", ["view_directory"], 9);
    expect(await h.prisma.roleAssignment.count({ where: { subjectId: "u_gone" } })).toBe(1);

    const res = await h.app.request("/api/v1/org/members/u_gone", {
      method: "DELETE",
      headers: await h.auth("u_del"),
    });
    expect(res.status).toBe(200);
    const body = await json<{ id: string; email: string; deleted: boolean }>(res);
    expect(body).toMatchObject({ id: "u_gone", deleted: true });

    expect(await h.prisma.user.findUnique({ where: { id: "u_gone" } })).toBeNull();
    // 授予行无外键、SQLite 不级联；deleteUser 必须手工清，否则 usersWithRole 会算出幽灵 owner。
    expect(await h.prisma.roleAssignment.count({ where: { subjectId: "u_gone" } })).toBe(0);
    expect(await h.prisma.role.findUnique({ where: { id: roleId } })).not.toBeNull();
  });

  it("自删 -> 400（帐号对自己没有 delete_users 也不该走到 owner 判定）", async () => {
    await h.createUser("u_self");
    await grantActions("u_self", ["delete_users"], 10);

    const res = await h.app.request("/api/v1/org/members/u_self", {
      method: "DELETE",
      headers: await h.auth("u_self"),
    });
    expect(res.status).toBe(400);
    expect(await h.prisma.user.findUnique({ where: { id: "u_self" } })).not.toBeNull();
  });

  it("删掉最后一位在岗 owner -> 409 且整笔回滚（owner 仍在）", async () => {
    await h.createUser("u_owner");
    await h.createUser("u_cleaner");
    await h.grantSystemRole("u_owner", "owner");
    await grantActions("u_cleaner", ["delete_users"], 11);

    const res = await h.app.request("/api/v1/org/members/u_owner", {
      method: "DELETE",
      headers: await h.auth("u_cleaner"),
    });
    expect(res.status).toBe(409);
    // 事务回滚：账号与它的 owner 授予都必须还在。
    expect(await h.prisma.user.findUnique({ where: { id: "u_owner" } })).not.toBeNull();
    expect(
      await h.prisma.roleAssignment.count({
        where: { roleId: "role_owner", subjectType: "user", subjectId: "u_owner" },
      }),
    ).toBe(1);
  });

  it("无 delete_users -> 403（只读角色够不着删除）", async () => {
    await h.createUser("u_watcher");
    await h.createUser("u_victim");
    await grantActions("u_watcher", ["view_directory"], 12);

    const res = await h.app.request("/api/v1/org/members/u_victim", {
      method: "DELETE",
      headers: await h.auth("u_watcher"),
    });
    expect(res.status).toBe(403);
    expect(await h.prisma.user.findUnique({ where: { id: "u_victim" } })).not.toBeNull();
  });

  it("目标不存在 -> 404，不能返回成功（删除是幂等语义的重灾区）", async () => {
    await h.createUser("u_ghost_admin");
    await grantActions("u_ghost_admin", ["delete_users"], 13);

    const res = await h.app.request("/api/v1/org/members/u_nobody", {
      method: "DELETE",
      headers: await h.auth("u_ghost_admin"),
    });
    expect(res.status).toBe(404);
  });
});
