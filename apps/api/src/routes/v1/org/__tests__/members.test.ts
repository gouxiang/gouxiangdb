// M2/S4 成员多部门 + 邀请激活端到端（真迁移临时库 + 真 app + 真 jwt）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "./orgHarness.js";

let h: OrgHarness;
let dept: (name: string, parentId?: string) => Promise<string>;

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("admin");
  await h.grantSystemRole("admin", "owner");
  dept = async (name: string, parentId?: string) => {
    const res = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name, ...(parentId ? { parentId } : {}) }),
    });
    expect(res.status).toBe(201);
    return (await json<{ id: string }>(res)).id;
  };
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  await h.reset();
  await h.createUser("admin");
  await h.grantSystemRole("admin", "owner");
});

async function invite(email: string, displayName = email) {
  const res = await h.app.request("/api/v1/org/members/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
    body: JSON.stringify({ email, displayName }),
  });
  return res;
}

describe("邀请与一次性激活", () => {
  it("邀请建 INVITED，明文码仅返一次；公开 accept 兑换 ACTIVE+JWT；重放 404", async () => {
    const res = await invite("bob@x.com", "Bob");
    expect(res.status).toBe(201);
    const body = await json<{ userId: string; status: string; inviteToken: string }>(res);
    expect(body.status).toBe("INVITED");
    expect(body.inviteToken).toMatch(/^[0-9a-f]{64}$/);

    // 库存是摘要而非明文
    const row = await h.prisma.user.findUnique({ where: { id: body.userId } });
    expect(row?.inviteTokenHash).toBeTruthy();
    expect(row?.inviteTokenHash).not.toBe(body.inviteToken);

    // 未激活不能登录 -> 403
    const loginBefore = await h.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@x.com", password: "secret123" }),
    });
    expect(loginBefore.status).toBe(403);

    // 公开 accept（不带登录 token）
    const accept = await h.app.request("/api/v1/auth/invite/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: body.inviteToken, password: "secret123", displayName: "Bob2" }),
    });
    expect(accept.status).toBe(200);
    const accepted = await json<{ token: string; user: { status: string; displayName: string } }>(accept);
    expect(accepted.token).toBeTruthy();
    expect(accepted.user.status).toBe("ACTIVE");
    expect(accepted.user.displayName).toBe("Bob2");

    // hash 已清、可登录
    const after = await h.prisma.user.findUnique({ where: { id: body.userId } });
    expect(after?.inviteTokenHash).toBeNull();
    const loginAfter = await h.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@x.com", password: "secret123" }),
    });
    expect(loginAfter.status).toBe(200);

    // 重放同一码 -> 404
    const replay = await h.app.request("/api/v1/auth/invite/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: body.inviteToken, password: "secret123" }),
    });
    expect(replay.status).toBe(404);
  });

  it("重复邮箱邀请 -> 409；非法邮箱/短密码 -> 400", async () => {
    expect((await invite("dup@x.com")).status).toBe(201);
    expect((await invite("dup@x.com")).status).toBe(409);
    const badEmail = await h.app.request("/api/v1/org/members/invite", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ email: "not-an-email", displayName: "x" }),
    });
    expect(badEmail.status).toBe(400);
  });

  it("accept 密码过短 -> 400；无 token -> 400", async () => {
    const inv = await json<{ inviteToken: string }>(await invite("carol@x.com"));
    const short = await h.app.request("/api/v1/auth/invite/accept", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inv.inviteToken, password: "short" }),
    });
    expect(short.status).toBe(400);
    const noTok = await h.app.request("/api/v1/auth/invite/accept", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret123" }),
    });
    expect(noTok.status).toBe(400);
  });
});

describe("直接创建 ACTIVE 账号", () => {
  it("建后即可登录；重复 409", async () => {
    const res = await h.app.request("/api/v1/org/members", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ email: "dave@x.com", displayName: "Dave", password: "initial123" }),
    });
    expect(res.status).toBe(201);
    const login = await h.app.request("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dave@x.com", password: "initial123" }),
    });
    expect(login.status).toBe(200);

    const dup = await h.app.request("/api/v1/org/members", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ email: "dave@x.com", displayName: "Dave2", password: "initial123" }),
    });
    expect(dup.status).toBe(409);
  });

  // 口径变更（权限核心模型）：通讯录读取不再是"登录即可"，而是一枚显式权限
  // 「可见通讯录」。新账号默认是受限成员（零动作），故读目录同样是 403。
  it("非管理员写 -> 403；无『可见通讯录』读目录也 403（登录即可读的旧口径已废）", async () => {
    await h.createUser("plain");
    const denied = await h.app.request("/api/v1/org/members", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("plain")) },
      body: JSON.stringify({ email: "x@x.com", displayName: "x", password: "initial123" }),
    });
    expect(denied.status).toBe(403);
    const read = await h.app.request("/api/v1/org/members", { headers: await h.auth("plain") });
    expect(read.status).toBe(403);
  });
});

describe("多部门归属：兼岗/调岗/主部门", () => {
  it("add 两部门兼岗，setMain 唯一，remove 即时反映", async () => {
    await h.createUser("u");
    const d1 = await dept("工程");
    const d2 = await dept("产品");

    const add = await h.app.request("/api/v1/org/members/u/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ add: [d1, d2], mainDeptId: d1 }),
    });
    expect(add.status).toBe(200);
    const added = await json<{ deptMemberships: Array<{ departmentId: string; isMain: boolean }> }>(add);
    expect(added.deptMemberships).toHaveLength(2);
    expect(added.deptMemberships.filter((m) => m.isMain)).toHaveLength(1);
    expect(added.deptMemberships.find((m) => m.departmentId === d1)?.isMain).toBe(true);

    // 切主部门到 d2（一人仍仅一主）
    const switchMain = await h.app.request("/api/v1/org/members/u/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ mainDeptId: d2 }),
    });
    const switched = await json<{ deptMemberships: Array<{ departmentId: string; isMain: boolean }> }>(switchMain);
    expect(switched.deptMemberships.filter((m) => m.isMain).map((m) => m.departmentId)).toEqual([d2]);

    // 主部门唯一性在库级也成立
    const mainCount = await h.prisma.deptMember.count({ where: { userId: "u", isMain: 1 } });
    expect(mainCount).toBe(1);

    // 移出 d2 即时反映
    const remove = await h.app.request("/api/v1/org/members/u/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ remove: [d2] }),
    });
    const removed = await json<{ deptMemberships: Array<{ departmentId: string }> }>(remove);
    expect(removed.deptMemberships.map((m) => m.departmentId)).toEqual([d1]);
  });

  it("把主部门设为未归属部门 -> 400；不存在部门 -> 400", async () => {
    await h.createUser("u2");
    const d1 = await dept("A");
    const d2 = await dept("B");
    await h.prisma.deptMember.create({ data: { departmentId: d1, userId: "u2", isMain: 1 } });

    const notMember = await h.app.request("/api/v1/org/members/u2/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ mainDeptId: d2 }),
    });
    expect(notMember.status).toBe(400);

    const badDept = await h.app.request("/api/v1/org/members/u2/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ add: ["nope"] }),
    });
    expect(badDept.status).toBe(400);
  });
});

describe("成员目录分页/搜索/部门子树", () => {
  it("分页 hasMore/total 正确；q 命中 email/displayName", async () => {
    for (let i = 0; i < 5; i++) {
      await h.createUser(`s${i}`, { email: `search${i}@x.com`, displayName: `搜索员${i}` });
    }
    const p1 = await h.app.request("/api/v1/org/members?limit=2&page=1", { headers: await h.auth("admin") });
    const body1 = await json<{ items: unknown[]; total: number; hasMore: boolean; page: number; limit: number }>(p1);
    expect(body1.items).toHaveLength(2);
    expect(body1.total).toBe(6); // admin + 5
    expect(body1.hasMore).toBe(true);
    expect(body1.page).toBe(1);
    expect(body1.limit).toBe(2);

    const q = await h.app.request("/api/v1/org/members?q=search3", { headers: await h.auth("admin") });
    const qb = await json<{ items: Array<{ email: string }>; total: number }>(q);
    expect(qb.total).toBe(1);
    expect(qb.items[0].email).toBe("search3@x.com");

    const qName = await h.app.request(
      `/api/v1/org/members?q=${encodeURIComponent("搜索员1")}`,
      { headers: await h.auth("admin") },
    );
    expect((await json<{ total: number }>(qName)).total).toBe(1);
  });

  it("deptId 含子树：子部门成员被命中", async () => {
    const root = await dept("总");
    const child = await dept("分", root);
    await h.createUser("inchild");
    await h.prisma.deptMember.create({ data: { departmentId: child, userId: "inchild", isMain: 1 } });
    await h.createUser("nodept");

    const res = await h.app.request(`/api/v1/org/members?deptId=${root}`, { headers: await h.auth("admin") });
    const body = await json<{ items: Array<{ id: string }>; total: number }>(res);
    expect(body.items.map((m) => m.id)).toContain("inchild");
    expect(body.items.map((m) => m.id)).not.toContain("nodept");
  });
});

describe("signup 运行时 owner 自举", () => {
  it("空工作区首个 signup 自动获系统 owner；后续 signup 不获", async () => {
    // beforeEach 已播 admin；此处清空到真正的 0 用户工作区。
    await h.reset();
    // 公开注册默认 fail-closed，非空库第二个 signup 会被 403 SIGNUP_CLOSED 挡掉，
    // 本用例要验的是"第二个注册者不再自举 owner"，故显式开注册让该路径可达。
    process.env.GX_ALLOW_PUBLIC_SIGNUP = "on";
    const first = await h.app.request("/api/auth/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "first@x.com", password: "password123", displayName: "First" }),
    });
    expect(first.status).toBe(200);
    const firstCount = await h.prisma.roleAssignment.count({
      where: { roleId: "role_owner", subjectType: "user", subjectId: (await first.json() as {user:{id:string}}).user.id },
    });
    expect(firstCount).toBe(1);

    const second = await h.app.request("/api/auth/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "second@x.com", password: "password123", displayName: "Second" }),
    });
    const secondId = (await second.json() as { user: { id: string } }).user.id;
    const secondCount = await h.prisma.roleAssignment.count({
      where: { roleId: "role_owner", subjectType: "user", subjectId: secondId },
    });
    expect(secondCount).toBe(0);
  });
});
