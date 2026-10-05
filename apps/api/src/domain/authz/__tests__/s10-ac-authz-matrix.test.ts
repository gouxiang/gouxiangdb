// M4/S10 越权直调矩阵（真库真 HTTP，不 mock）：把 ARCH #1/#2/#12/#17 的"认证通过但无权/越界"
// 拒绝集中锁一张表。停用即时 401 已在 auth-state.test.ts 覆盖 /meta，本文件补齐 v1 权限端点。
//
// 三主体：
//   nobody  = 已登录 ACTIVE 但与被测资源无任何关系（非成员/无策略）
//   viewer  = 仅对节点有 r（能读，不能写/不能查他人/不能切继承）
//   disabled= 先建好授权再停用，持停用前签发的旧 JWT
//
// on 态菜单无权项剔除 + A-6 父无权子有权三通道已由 s7-prune 11 例覆盖，不重复。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  seedKbWithDocs,
  json,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

let h: CharHarness;
let baseNode = "";
let docNode = "";
let groupNode = "";

async function grant(node: string, subjectId: string, actions: string, id: string): Promise<void> {
  await h.prisma.authPolicy.create({
    data: { id, workspaceId: "ws_default", nodeId: node, subjectType: "user", subjectId, actions, reason: "policy:v1", createdBy: "seed" },
  });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s10-authz-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  await h.createUser("nobody", { email: "nobody@x.com", displayName: "无关系用户" });
  await h.createUser("viewer", { email: "viewer@x.com", displayName: "只读成员" });
  await h.createUser("disabled", { email: "disabled@x.com", displayName: "停用用户" });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });
  const base = await seedBaseWithStarter(h, "s10az");
  baseNode = nodeId("base", base.baseId);
  const kb = await seedKbWithDocs(h, "s10az");
  docNode = nodeId("doc", kb.rootDoc);
  await grant(baseNode, "viewer", "enter", "s10az_v_base");
  await grant(docNode, "viewer", "r", "s10az_v_doc");
  // disabled 停用前给足授权（停用后旧 JWT 必须在鉴权链第一道被 401，根本到不了授权判定）。
  await grant(baseNode, "disabled", "manage_share,enter", "s10az_d_base");
  const created = await h.app.request("/api/v1/nav/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
    body: JSON.stringify({ name: "s10az 组" }),
  });
  groupNode = (await json<{ id: string }>(created)).id;
  await h.prisma.user.update({ where: { id: "disabled" }, data: { status: "DISABLED" } });
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

/** 无关系用户对 v1 权限/资源端点一律不得 200（403 无权或 404 不泄漏存在性）。 */
describe("无关系用户直调：读 403/404，写 403，绝不 200", () => {
  const readGet: Array<[string, string]> = [
    ["节点策略", `/api/v1/nodes/${baseNode}/policies`],
    ["有效权限", `/api/v1/nodes/${baseNode}/effective`],
    ["继承影响", `/api/v1/nodes/${docNode}/inheritance/impact?value=0`],
    ["面包屑", `/api/v1/nodes/${docNode}/breadcrumb`],
    ["他人可见集", "/api/v1/authz/visible-scope?userId=owner"],
  ];
  it.each(readGet)("GET %s -> 403/404", async (_label, url) => {
    const res = await h.app.request(url, { headers: await h.auth("nobody") });
    expect([403, 404]).toContain(res.status);
  });

  it("PUT policies 写 -> 403（无 manage_share）", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("nobody")) },
      body: JSON.stringify({ upserts: [{ subjectType: "user", subjectId: "nobody", actions: ["r"] }] }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH inheritance 写 -> 403", async () => {
    const res = await h.app.request(`/api/v1/nodes/${docNode}/inheritance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("nobody")) },
      body: JSON.stringify({ value: false, confirmed: true }),
    });
    expect(res.status).toBe(403);
  });

  it("POST nav/groups 写（需 manage_menu）-> 403", async () => {
    const res = await h.app.request("/api/v1/nav/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("nobody")) },
      body: JSON.stringify({ name: "越权组" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("viewer（仅 r）直调写/排障端点 -> 403", () => {
  it("PUT policies -> 403；读本人 effective/policies 仍 200", async () => {
    const write = await h.app.request(`/api/v1/nodes/${baseNode}/policies`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await h.auth("viewer")) },
      body: JSON.stringify({ upserts: [{ subjectType: "user", subjectId: "owner", actions: ["enter"] }] }),
    });
    expect(write.status).toBe(403);
    const read = await h.app.request(`/api/v1/nodes/${baseNode}/effective`, { headers: await h.auth("viewer") });
    expect(read.status).toBe(200);
  });

  it("查他人 effective（需 manage_share）-> 403", async () => {
    const res = await h.app.request(`/api/v1/nodes/${baseNode}/effective?userId=owner`, { headers: await h.auth("viewer") });
    expect(res.status).toBe(403);
  });

  it("PATCH inheritance -> 403（r 不含 manage_share）", async () => {
    const res = await h.app.request(`/api/v1/nodes/${docNode}/inheritance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("viewer")) },
      body: JSON.stringify({ value: false, confirmed: true }),
    });
    expect(res.status).toBe(403);
  });

  it("查他人 visible-scope（需 workspace owner）-> 403，即便 viewer 对节点有 r", async () => {
    const res = await h.app.request("/api/v1/authz/visible-scope?userId=owner", { headers: await h.auth("viewer") });
    expect(res.status).toBe(403);
  });
});

describe("停用用户持旧 JWT：v1 权限端点全 401（鉴权链先于授权）", () => {
  const cases: Array<[string, string, string?]> = [
    ["GET", `/api/v1/nodes/${baseNode}/policies`],
    ["GET", `/api/v1/nodes/${baseNode}/effective`],
    ["GET", "/api/v1/authz/visible-scope"],
    ["GET", `/api/v1/nodes/${docNode}/breadcrumb`],
    ["PUT", `/api/v1/nodes/${baseNode}/policies`],
  ];
  it.each(cases)("%s 停用旧 token -> 401（即便停用前有 manage_share）", async (method, url) => {
    const res = await h.app.request(url, {
      method,
      headers: { "Content-Type": "application/json", ...(await h.auth("disabled")) },
      body: method === "PUT" ? JSON.stringify({ upserts: [] }) : undefined,
    });
    expect(res.status).toBe(401);
    expect((await json<{ code: string }>(res)).code).toBe("UNAUTHORIZED");
  });

  it("group 继承端点对停用者同样 401（不到 NODE_NOT_INHERITABLE 业务判定）", async () => {
    const res = await h.app.request(`/api/v1/nodes/${groupNode}/inheritance/impact?value=0`, {
      headers: await h.auth("disabled"),
    });
    expect(res.status).toBe(401);
  });
});
