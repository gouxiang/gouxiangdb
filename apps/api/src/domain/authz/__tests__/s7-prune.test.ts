// M4/S7 裁决 A-6 端到端：tree/menu 服务端剪枝 + 三通道 + 面包屑中性截断 + S6 缺口闭合。
//
// 覆盖：
//   - off/shadow 字节一致：tree/menu/breadcrumb 两态 Response.text() 完全相同且无 dimmed 键；
//   - A-6 三通道（父 kb 无权、子 doc 直授有权）：on 态 tree 无子位置（不造伪父链）、
//     menu shortcut 正常显示且摘要 alive、旧守卫 URL 直达 200；
//   - 面包屑：on 态链无无权父名且 truncatedAbove=true；自身无 r -> 403；缺失 -> 404；
//   - S6 缺口闭合：无任何来源用户的 base/table/doc 在 tree/menu 真正被剪（items 空）；
//   - 空容器：普通成员隐藏、管理能力者保留 dimmed:true；资源节点永不下发 dimmed；
//   - 子树锚点自身不可见 -> 403（防存在性探测，不返回空壳 200）；all=1 管理员不剪枝；
//   - shortcut 只看节点自身 r：父无权不影响 shortcut 可见。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupS7Fixture, insertShortcut, OWNER, ADMIN, DIRECT, NOBODY, type S7Fixture } from "./s7Harness.js";
import { nodeId } from "../../nav/backfill.js";
import { json } from "../../nav/__tests__/characterization/charHarness.js";

let fx: S7Fixture;
const I = (): S7Fixture["ids"] => fx.ids;

beforeAll(async () => {
  fx = await setupS7Fixture();
}, 120000);

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(() => {
  delete process.env.GX_AUTHZ_ENGINE;
});

const TREE = "/api/v1/workspaces/current/tree?parentId=root&maxDepth=3";
const MENU = "/api/v1/workspaces/current/menu";

async function get(user: string, url: string): Promise<Response> {
  return fx.call("GET", url, user);
}

interface TreeNode { id: string; parentId: string | null; kind: string; dimmed?: boolean }
interface TreeBody { items: TreeNode[]; navVersion: number }
interface MenuBody { items: Array<{ id: string; type: string; nodeId: string | null; node: { state: string } | null }> }

describe("off/shadow 与 M3 金标准字节一致（独立门关闭，零剪枝）", () => {
  it("tree/menu/breadcrumb 在 off 与 shadow 下逐字节相同，且不下发 dimmed/truncatedAbove=true", async () => {
    const d1Node = nodeId("doc", I().d1);
    process.env.GX_AUTHZ_ENGINE = "off";
    const off = {
      tree: await (await get(DIRECT, TREE)).text(),
      menu: await (await get(DIRECT, MENU)).text(),
      crumb: await (await get(DIRECT, `/api/v1/nodes/${d1Node}/breadcrumb`)).text(),
    };
    process.env.GX_AUTHZ_ENGINE = "shadow";
    const shadow = {
      tree: await (await get(DIRECT, TREE)).text(),
      menu: await (await get(DIRECT, MENU)).text(),
      crumb: await (await get(DIRECT, `/api/v1/nodes/${d1Node}/breadcrumb`)).text(),
    };
    expect(shadow.tree).toBe(off.tree);
    expect(shadow.menu).toBe(off.menu);
    expect(shadow.crumb).toBe(off.crumb);
    expect(off.tree).not.toContain("dimmed");
    expect(off.menu).not.toContain("dimmed");
    // off 态面包屑是完整物理链（kb -> d1），无截断。
    const crumb = JSON.parse(off.crumb) as { truncatedAbove: boolean; chain: Array<{ id: string }> };
    expect(crumb.truncatedAbove).toBe(false);
    expect(crumb.chain.map((n) => n.id)).toEqual([nodeId("kb", I().kb), d1Node]);
  });
});

describe("A-6 三通道：父 kb 无权、子 doc 直授（ACL）有权", () => {
  beforeAll(async () => {
    await insertShortcut(fx, nodeId("doc", I().d1), "s7_sc_d1", 1);
    await insertShortcut(fx, nodeId("table", I().table), "s7_sc_table", 2);
  });

  beforeEach(() => {
    process.env.GX_AUTHZ_ENGINE = "on";
  });

  it("通道1 权威树：d1 无位置（连透明路径不造伪父链），kb 也不可见", async () => {
    const res = await get(DIRECT, TREE);
    expect(res.status).toBe(200);
    const body = await json<TreeBody>(res);
    const ids = new Set(body.items.map((n) => n.id));
    expect(ids.has(nodeId("doc", I().d1))).toBe(false);
    expect(ids.has(nodeId("kb", I().kb))).toBe(false);
    // owner 对照组同窗口两个节点都在。
    const ownerBody = await json<TreeBody>(await get(OWNER, TREE));
    const ownerIds = new Set(ownerBody.items.map((n) => n.id));
    expect(ownerIds.has(nodeId("doc", I().d1))).toBe(true);
    expect(ownerIds.has(nodeId("kb", I().kb))).toBe(true);
  });

  it("通道2 菜单 shortcut：d1 shortcut 正常保留且摘要 alive；无来源 table shortcut 剔除", async () => {
    const body = await json<MenuBody>(await get(DIRECT, MENU));
    const d1Shortcut = body.items.find((m) => m.nodeId === nodeId("doc", I().d1));
    expect(d1Shortcut).toBeTruthy();
    expect(d1Shortcut!.node?.state).toBe("alive");
    const tableShortcut = body.items.find((m) => m.nodeId === nodeId("table", I().table));
    expect(tableShortcut).toBeUndefined();
    // owner 两个 shortcut 都在。
    const ownerBody = await json<MenuBody>(await get(OWNER, MENU));
    expect(ownerBody.items.some((m) => m.nodeId === nodeId("table", I().table))).toBe(true);
  });

  it("通道3 URL 直达：旧守卫按 doc ACL 放行 200（权限在、导航路径断）", async () => {
    const allowed = await fx.call("GET", `/api/kb/docs/${I().d1}`, DIRECT);
    expect(allowed.status).toBe(200);
    const denied = await fx.call("GET", `/api/kb/docs/${I().d1}`, NOBODY);
    expect(denied.status).toBe(403);
  });

  it("面包屑：chain 从有权最高祖先起（仅 d1），不返回无权 kb 的 id/name/path，truncatedAbove=true", async () => {
    const res = await get(DIRECT, `/api/v1/nodes/${nodeId("doc", I().d1)}/breadcrumb`);
    expect(res.status).toBe(200);
    const body = await json<{ chain: Array<{ id: string; name: string; path: string }>; truncatedAbove: boolean }>(res);
    expect(body.truncatedAbove).toBe(true);
    expect(body.chain.map((n) => n.id)).toEqual([nodeId("doc", I().d1)]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(I().kb);
    expect(raw).not.toContain("s7 知识库");
  });

  it("面包屑：节点自身无 r -> 403；缺失/软删 -> 404（不借端点探测）", async () => {
    const forbidden = await get(NOBODY, `/api/v1/nodes/${nodeId("doc", I().d1)}/breadcrumb`);
    expect(forbidden.status).toBe(403);
    const missing = await get(DIRECT, "/api/v1/nodes/nav_does_not_exist/breadcrumb");
    expect(missing.status).toBe(404);
    expect((await json<{ code: string }>(missing)).code).toBe("NODE_NOT_FOUND");
  });
});

describe("on 态剪枝：S6 缺口闭合 + 空容器 dimmed + 锚点 403 + all=1 不剪", () => {
  beforeEach(() => {
    process.env.GX_AUTHZ_ENGINE = "on";
  });

  it("S6 登记缺口闭合：无来源用户的 base/table/view/kb/doc 在树与菜单全部不可达", async () => {
    const body = await json<TreeBody>(await get(NOBODY, TREE));
    expect(body.items).toEqual([]); // 无任何资源可见 -> 所有 group 子树也无内容，普通成员全隐藏
    const menu = await json<MenuBody>(await get(NOBODY, MENU));
    expect(menu.items).toEqual([]);
  });

  it("空容器：普通成员（DIRECT）不可见；管理能力者（ADMIN）保留且 dimmed:true；资源节点不带 dimmed", async () => {
    const plain = await json<TreeBody>(await get(DIRECT, TREE));
    expect(plain.items.some((n) => n.id === I().gEmpty)).toBe(false);

    const admin = await json<TreeBody>(await get(ADMIN, TREE));
    const empty = admin.items.find((n) => n.id === I().gEmpty);
    expect(empty).toBeTruthy();
    expect(empty!.dimmed).toBe(true);
    // 有内容的 group 对管理者不 dimmed。
    const gA = admin.items.find((n) => n.id === I().gA);
    expect(gA?.dimmed).toBeUndefined();
    // 资源节点在任意响应里都不带 dimmed 键。
    for (const n of admin.items) {
      if (n.kind !== "group") expect(n.dimmed).toBeUndefined();
    }
  });

  it("子树读锚点自身不可见 -> 403（含子有 direct 的断链场景），不返回空壳 200", async () => {
    const kbTree = `/api/v1/workspaces/current/tree?parentId=${nodeId("kb", I().kb)}&maxDepth=2`;
    expect((await get(NOBODY, kbTree)).status).toBe(403);
    // DIRECT 对 kb 无 r：即便其下 d1 有 direct，锚点不可见仍 403。
    expect((await get(DIRECT, kbTree)).status).toBe(403);
  });

  it("all=1 管理通道完全不剪枝（含无权资源、软删、无 dimmed 键）", async () => {
    const res = await get(ADMIN, "/api/v1/workspaces/current/tree?all=1");
    expect(res.status).toBe(200);
    const body = await json<TreeBody>(res);
    const ids = new Set(body.items.map((n) => n.id));
    expect(ids.has(nodeId("doc", I().d1))).toBe(true);
    expect(ids.has(nodeId("kb", I().kb))).toBe(true);
    expect(body.items.some((n) => "dimmed" in n)).toBe(false);
  });

  it("非管理员 all=1 -> 403", async () => {
    const res = await get(NOBODY, "/api/v1/workspaces/current/tree?all=1");
    expect(res.status).toBe(403);
  });
});
