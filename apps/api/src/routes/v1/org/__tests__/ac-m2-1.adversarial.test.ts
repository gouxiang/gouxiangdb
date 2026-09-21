// M2/S8 AC-M2-1 六对抗端到端（计划 §7-S8 八条 + DoD 第 2/6 条）。
//
// 真迁移临时库 + 真 createApp 全路由 + 真登录 issueToken 签发，不 mock auth；
// 组织状态全部经 HTTP API 构造（部门逐级 POST、角色 PUT assignments、调岗 POST departments）。
// 与 S3-S6 分片测试的区别：本文件按"攻击者/管理员"视角串完整业务链，且断言响应机器码。
//
// 注意（事实留证）：/api/v1/* 的 401 由 requireActiveUser 抛 HttpError 经 errorResponse
// 返 {error,code:"UNAUTHORIZED"}；旧 /api/auth/me 的 401 是 auth.ts 手工响应，本文件对其
// code 字段的断言即 S8 对抗点。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "./orgHarness.js";

let h: OrgHarness;
let app: OrgHarness["app"];

const json = async (res: Response) => (await res.json()) as Record<string, any>;

async function login(email: string, password = "password123"): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${JSON.stringify(await res.json())}`);
  return (await res.json() as { token: string }).token;
}

/** 管理员直建 ACTIVE 账号（S4 端点），再走真登录拿带 tv 的 JWT。 */
async function provisionUser(ownerToken: string, id: string, displayName: string) {
  const res = await app.request("/api/v1/org/members", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email: `${id}@x.com`, displayName, password: "password123" }),
  });
  if (res.status !== 201) throw new Error(`provision failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { userId: string };
  return { id: body.userId, token: await login(`${id}@x.com`) };
}

async function mkDept(token: string, name: string, parentId?: string): Promise<string> {
  const res = await app.request("/api/v1/org/departments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(parentId ? { name, parentId } : { name }),
  });
  expect(res.status, `create dept ${name}`).toBe(201);
  return (await res.json() as { id: string }).id;
}

async function mkRole(token: string, name: string, actions: string[]): Promise<string> {
  const res = await app.request("/api/v1/org/roles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, actions }),
  });
  expect(res.status, `create role ${name}`).toBe(201);
  return (await res.json() as { id: string }).id;
}

async function putAssignments(token: string, roleId: string, subjects: unknown) {
  const res = await app.request(`/api/v1/org/roles/${roleId}/assignments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subjects }),
  });
  expect(res.status, `put assignments ${roleId}`).toBe(200);
  return res.json();
}

async function assign(token: string, userId: string, body: Record<string, unknown>) {
  const res = await app.request(`/api/v1/org/members/${userId}/departments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  expect(res.status, `assign departments ${userId}`).toBe(200);
  return res.json();
}

async function effRoles(token: string, userId: string) {
  const res = await app.request(`/api/v1/org/members/${userId}/effective-roles`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { roles: Array<Record<string, unknown>> }).roles;
}

beforeAll(async () => {
  h = await setupOrgHarness();
  app = h.app;
}, 120000);

afterAll(() => h.cleanup());

beforeEach(async () => {
  await h.reset();
});

describe("AC-M2-1 对抗 1-4：6 层部门 + 双兼岗 + 部门授予并集与调岗即时性", () => {
  it("U 兼 D3/D6：R 经 D3 祖先链命中（来源 D2）、Q 经 D6、viewer 直接授予，来源三路径完整", async () => {
    await h.createUser("u_owner");
    await h.grantSystemRole("u_owner");
    const ownerToken = await h.token("u_owner");

    const d = [] as string[];
    for (let i = 1; i <= 6; i++) d.push(await mkDept(ownerToken, `D${i}`, i === 1 ? undefined : d[i - 2]));

    const u = await provisionUser(ownerToken, "u_alice", "Alice");
    await assign(ownerToken, u.id, { add: [d[2], d[5]], mainDeptId: d[2] }); // D3 main, D6 concurrent

    const rId = await mkRole(ownerToken, "R_members", ["manage_members"]);
    await putAssignments(ownerToken, rId, [{ subjectType: "dept", subjectId: d[1] }]); // R -> D2
    const qId = await mkRole(ownerToken, "Q_readonly", []);
    await putAssignments(ownerToken, qId, [{ subjectType: "dept", subjectId: d[5] }]); // Q -> D6
    await h.grant("role_viewer", "user", u.id); // 直接授予

    const roles = await effRoles(ownerToken, u.id);
    const byId = new Map(roles.map((x) => [x.roleId as string, x] as const));
    // 第四个是受限成员：账号经 POST /org/members 落成，按「新建用户未指定角色时的默认角色
    // = 受限成员」自动获得。它零动作，不参与下列任何并集，但必须在列表里——否则
    // 有效角色与"这个人为什么什么都不能做"对不上账。
    expect([...byId.keys()].sort()).toEqual([qId, rId, "role_restricted", "role_viewer"].sort());
    expect(byId.get("role_restricted")!.actions).toEqual([]);

    const r = byId.get(rId)!;
    expect(r.actions).toEqual(["manage_members"]);
    expect(r.sources).toEqual([{ type: "dept", id: d[1], name: "D2" }]);
    const q = byId.get(qId)!;
    expect(q.sources).toEqual([{ type: "dept", id: d[5], name: "D6" }]);
    expect(byId.get("role_viewer")!.sources).toEqual([{ type: "user", id: u.id }]);
  });

  it("调岗即时：移出分支兼岗下次请求 R 消失而并列分支 Q 仍在；加回下次请求恢复（无 sleep）", async () => {
    // 几何说明：6 层主链 A1..A6 之外，在 A1 下挂并列分支 B1。单链上 D6 的祖先闭包包 D2，
    // 无法构造"移近根兼岗点、角色消失而另一角色保留"（计划 §7-S8 文字的 D3/D6 同链隐含矛盾）；
    // 并列分支下 B1 祖先仅 {A1,B1}，不含 A2，故 R 授 A2 仅经 A3 命中、Q 授 B1 独立。
    await h.createUser("u_owner2");
    await h.grantSystemRole("u_owner2");
    const ot = await h.token("u_owner2");
    const a = [] as string[];
    for (let i = 1; i <= 6; i++) a.push(await mkDept(ot, `A${i}`, i === 1 ? undefined : a[i - 2]));
    const b1 = await mkDept(ot, "B1", a[0]); // 与 A2 并列，path=/{A1}/{B1}/
    expect((await h.prisma.department.findUniqueOrThrow({ where: { id: b1 } })).path.split("/").filter(Boolean)).toEqual([a[0], b1]);

    const u = await provisionUser(ot, "u_bob", "Bob");
    await assign(ot, u.id, { add: [a[2], b1] }); // 兼 A3（主链第 3 层）与 B1（并列分支）
    const rId = await mkRole(ot, "R2", ["manage_members"]);
    await putAssignments(ot, rId, [{ subjectType: "dept", subjectId: a[1] }]); // R -> A2
    const qId = await mkRole(ot, "Q2", []);
    await putAssignments(ot, qId, [{ subjectType: "dept", subjectId: b1 }]); // Q -> B1

    let ids = (await effRoles(ot, u.id)).map((x) => x.roleId);
    expect(ids).toContain(rId);
    expect(ids).toContain(qId);

    await assign(ot, u.id, { remove: [a[2]] }); // 移出 A3，仍在 B1
    ids = (await effRoles(ot, u.id)).map((x) => x.roleId);
    expect(ids).not.toContain(rId);
    expect(ids).toContain(qId);

    await assign(ot, u.id, { add: [a[2]] }); // 加回 A3
    ids = (await effRoles(ot, u.id)).map((x) => x.roleId);
    expect(ids).toContain(rId);
    expect(ids).toContain(qId);
  });
});

describe("AC-M2-1 对抗 5-6：停用即时失效，旧 token 对两个门面的下一次请求均 401", () => {
  it("owner 停用 U：旧 tv token 对 /api/auth/me 与 /api/v1/org/members 连续两次均 401 且带机器码", async () => {
    await h.createUser("u_owner3");
    await h.grantSystemRole("u_owner3");
    const ot = await h.token("u_owner3");
    const u = await provisionUser(ot, "u_carol", "Carol");
    // 通讯录读取是显式权限（可见通讯录），新账号默认受限成员零动作读不到；
    // 本用例验的是 token 失效，故补一枚只带 view_directory 的角色让"停前可用"成立。
    const dirRole = await mkRole(ot, "R_dir", ["view_directory"]);
    await h.grant(dirRole, "user", u.id);

    // 停用前两个门面均 200
    expect((await app.request("/api/auth/me", { headers: { Authorization: `Bearer ${u.token}` } })).status).toBe(200);
    expect((await app.request("/api/v1/org/members?limit=1", { headers: { Authorization: `Bearer ${u.token}` } })).status).toBe(200);

    const dis = await app.request(`/api/v1/org/members/${u.id}/disable`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ot}` },
    });
    expect(dis.status).toBe(200);
    expect((await json(dis)).status).toBe("DISABLED");

    for (let i = 0; i < 2; i++) {
      // 模拟主窗口与嵌入 iframe 刷新：同一旧 token 第二次仍必须 401。
      const me = await app.request("/api/auth/me", { headers: { Authorization: `Bearer ${u.token}` } });
      expect(me.status).toBe(401);
      expect((await json(me)).code, `/me 401 机器码（第 ${i + 1} 次）`).toBe("UNAUTHORIZED");

      const v1 = await app.request("/api/v1/org/members?limit=1", { headers: { Authorization: `Bearer ${u.token}` } });
      expect(v1.status).toBe(401);
      expect((await json(v1)).code, `v1 401 机器码（第 ${i + 1} 次）`).toBe("UNAUTHORIZED");
    }

    const relogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "u_carol@x.com", password: "password123" }),
    });
    expect(relogin.status).toBe(401);
    expect((await json(relogin)).code).toBe("UNAUTHORIZED"); // login DISABLED 分支同样带机器码
  });
});

describe("AC-M2-1 对抗 7：最后 owner 三路径保护", () => {
  it("自停用 400", async () => {
    await h.createUser("u_o4");
    await h.grantSystemRole("u_o4");
    const ot = await h.token("u_o4");
    const res = await app.request("/api/v1/org/members/u_o4/disable", {
      method: "POST",
      headers: { Authorization: `Bearer ${ot}` },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("BAD_REQUEST");
  });

  it("仅剩的 owner 经【部门授予展开】在岗时，非 owner 管理员停用仍 409", async () => {
    // owner 自举行随后拆掉；唯一在岗 owner 是子部门里的 z（role_owner 授给上层部门）。
    await h.createUser("u_o5");
    await h.grantSystemRole("u_o5");
    const ot = await h.token("u_o5");
    const root = await mkDept(ot, "OROOT");
    const child = await mkDept(ot, "OCHILD", root);

    // 仅持 manage_members 的管理员（可调停用端点，但不是 owner）
    const mgr = await provisionUser(ot, "u_mgr", "Mgr");
    const mgrRole = await mkRole(ot, "MgrOnly", ["manage_members", "disable_users"]);
    await h.grant(mgrRole, "user", mgr.id);

    // 部门继承 owner：role_owner 授 root，z 在 child
    const z = await provisionUser(ot, "u_zeta", "Zeta");
    await assign(ot, z.id, { add: [child] });
    await putAssignments(ot, "role_owner", [{ subjectType: "dept", subjectId: root }]);
    // 拆掉直接 owner 授予：全库在岗 owner 仅剩经部门展开的 z
    await h.revoke("role_owner", "user", "u_o5");

    const res = await app.request(`/api/v1/org/members/${z.id}/disable`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mgr.token}` },
    });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("CONFLICT");
  });

  it("存在第二位在岗 owner 时，停用其中一位成功 200（保护不过度拦截）", async () => {
    await h.createUser("u_o6");
    await h.grantSystemRole("u_o6");
    const ot = await h.token("u_o6");
    const second = await provisionUser(ot, "u_second_owner", "Second");
    await h.grant("role_owner", "user", second.id);

    const res = await app.request(`/api/v1/org/members/${second.id}/disable`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ot}` },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("DISABLED");
  });
});

describe("AC-M2-1 对抗 8：匿名公开外链不受成员停用影响（§5-D.5）", () => {
  it("停用与分享无关的成员后，GET /api/public/s/:token 匿名仍 200", async () => {
    await h.createUser("u_o7");
    await h.grantSystemRole("u_o7");
    const ot = await h.token("u_o7");

    await h.prisma.knowledgeBase.create({ data: { id: "kb_share", name: "kb", createdBy: "u_sharer" } });
    await h.createUser("u_sharer");
    await h.prisma.kbDoc.create({
      data: {
        id: "doc_share", kbId: "kb_share", kind: "doc", title: "公开", content: "正文",
        createdBy: "u_sharer", updatedBy: "u_sharer",
        shareEnabled: true, shareToken: "s8-token", shareRole: "viewer",
      },
    });
    // 一个与外链完全无关的成员，停用之
    const victim = await provisionUser(ot, "u_victim", "Victim");
    const dis = await app.request(`/api/v1/org/members/${victim.id}/disable`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ot}` },
    });
    expect(dis.status).toBe(200);

    const share = await app.request("/api/public/s/s8-token"); // 无任何 Authorization
    expect(share.status).toBe(200);
    expect((await json(share)).doc.id).toBe("doc_share");
  });
});
