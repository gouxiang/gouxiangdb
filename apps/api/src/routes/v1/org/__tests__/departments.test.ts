// M2/S3 部门路由端到端（真迁移临时库 + 真 app + 真 jwt）。
// 覆盖：读全员可见/写需 manage_departments、建/改名/6 层链/移动中间层子树重写/防环/
// 深度护栏/同父同名 409/软删 409 带 counts/memberCount 聚合。
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
});

async function createChain(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const parentId = i === 1 ? undefined : ids[i - 2];
    const res = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: `D${i}`, ...(parentId ? { parentId } : {}) }),
    });
    expect(res.status).toBe(201);
    const d = await json<{ id: string }>(res);
    ids.push(d.id);
  }
  return ids;
}

describe("鉴权：读登录可读，写需 manage_departments", () => {
  it("无 token 读 -> 401", async () => {
    expect((await h.app.request("/api/v1/org/departments")).status).toBe(401);
  });

  it("无任何组织角色的登录用户可读空列表，但写 -> 403", async () => {
    await h.createUser("plain");
    const headers = await h.auth("plain");
    const get = await h.app.request("/api/v1/org/departments", { headers });
    expect(get.status).toBe(200);
    expect(await json(get)).toEqual([]);

    const post = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name: "X" }),
    });
    expect(post.status).toBe(403);
    expect((await json<{ code: string }>(post)).code).toBe("FORBIDDEN");
  });

  it("持 owner（manage_departments）可写；无该动作的系统角色（viewer）写 -> 403", async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
    await h.createUser("v");
    await h.grantSystemRole("v", "viewer");

    const ok = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "研发" }),
    });
    expect(ok.status).toBe(201);

    const denied = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("v")) },
      body: JSON.stringify({ name: "研发2" }),
    });
    expect(denied.status).toBe(403);
  });
});

describe("部门树结构与 path", () => {
  beforeEach(async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
  });

  it("建 6 层链，path 逐级物化正确", async () => {
    const ids = await createChain();
    const res = await h.app.request("/api/v1/org/departments", { headers: await h.auth("admin") });
    const list = await json<Array<{ id: string; path: string; parentId: string | null }>>(res);
    const byId = new Map(list.map((d) => [d.id, d]));
    ids.forEach((id, i) => {
      const expectPath = `/${ids.slice(0, i + 1).join("/")}/`;
      expect(byId.get(id)?.path).toBe(expectPath);
      expect(byId.get(id)?.parentId).toBe(i === 0 ? null : ids[i - 1]);
    });
  });

  it("移动中间层（D2 及其子树）到新根下，全部后代 path 重写，D1 不动", async () => {
    const ids = await createChain();
    // 新建顶层 R，把 D2 移到 R 下
    const r = await h.app.request("/api/v1/org/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "R" }),
    });
    const rId = (await json<{ id: string }>(r)).id;

    const mv = await h.app.request(`/api/v1/org/departments/${ids[1]}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ parentId: rId }),
    });
    expect(mv.status).toBe(200);

    const res = await h.app.request("/api/v1/org/departments", { headers: await h.auth("admin") });
    const byId = new Map((await json<Array<{ id: string; path: string }>>(res)).map((d) => [d.id, d]));
    expect(byId.get(ids[0])?.path).toBe(`/${ids[0]}/`); // D1 不动
    expect(byId.get(ids[1])?.path).toBe(`/${rId}/${ids[1]}/`); // D2
    expect(byId.get(ids[2])?.path).toBe(`/${rId}/${ids[1]}/${ids[2]}/`); // D3
    expect(byId.get(ids[5])?.path).toBe(`/${rId}/${ids.slice(1).join("/")}/`); // D6
  });

  it("把部门移到自身/子孙之下 -> 400 防环", async () => {
    const ids = await createChain();
    for (const target of [ids[0], ids[2]]) {
      const res = await h.app.request(`/api/v1/org/departments/${ids[0]}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
        body: JSON.stringify({ parentId: target }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("同父同名 -> 409；不同父同名允许", async () => {
    const root = await h.app.request("/api/v1/org/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "同名" }),
    });
    const rootId = (await json<{ id: string }>(root)).id;
    const dup = await h.app.request("/api/v1/org/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "同名" }),
    });
    expect(dup.status).toBe(409);

    const child = await h.app.request("/api/v1/org/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "同名", parentId: rootId }),
    });
    expect(child.status).toBe(201);
  });

  it("非法名（空/非字符串）-> 400", async () => {
    for (const name of ["", "   ", 123]) {
      const res = await h.app.request("/api/v1/org/departments", {
        method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("软删与 memberCount", () => {
  beforeEach(async () => {
    await h.createUser("admin");
    await h.grantSystemRole("admin", "owner");
  });

  it("空部门可软删，再列表消失", async () => {
    const created = await h.app.request("/api/v1/org/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "待删" }),
    });
    const { id } = await json<{ id: string }>(created);
    const del = await h.app.request(`/api/v1/org/departments/${id}`, {
      method: "DELETE", headers: await h.auth("admin"),
    });
    expect(del.status).toBe(200);
    const list = await json<Array<{ id: string }>>(
      await h.app.request("/api/v1/org/departments", { headers: await h.auth("admin") }),
    );
    expect(list.find((d) => d.id === id)).toBeUndefined();
  });

  it("有子部门 -> 409 带 counts；有成员 -> 409 且 memberCount 反映在列表", async () => {
    const root = await h.app.request("/api/v1/org/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "父" }),
    });
    const rootId = (await json<{ id: string }>(root)).id;
    await h.app.request("/api/v1/org/departments", {
      method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("admin")) },
      body: JSON.stringify({ name: "子", parentId: rootId }),
    });
    const blockedByChild = await h.app.request(`/api/v1/org/departments/${rootId}`, {
      method: "DELETE", headers: await h.auth("admin"),
    });
    expect(blockedByChild.status).toBe(409);
    const errBody = await json<{ error: string }>(blockedByChild);
    expect(errBody.error).toMatch(/1 个子部门/);

    // memberCount 聚合
    await h.createUser("staff");
    await h.prisma.deptMember.create({ data: { departmentId: rootId, userId: "staff", isMain: 1 } });
    const list = await json<Array<{ id: string; memberCount: number }>>(
      await h.app.request("/api/v1/org/departments", { headers: await h.auth("admin") }),
    );
    expect(list.find((d) => d.id === rootId)?.memberCount).toBe(1);
  });

  it("删不存在部门 -> 404", async () => {
    const res = await h.app.request("/api/v1/org/departments/nope", {
      method: "DELETE", headers: await h.auth("admin"),
    });
    expect(res.status).toBe(404);
  });
});
