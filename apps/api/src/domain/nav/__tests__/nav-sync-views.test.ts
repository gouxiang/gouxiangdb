// M3/S3 路由层写点同步测试（views.ts：#8 建 / #9 改名换序 / #10 物理删 / 补点 视图复制）。
//
// 每写点三条真库真 HTTP 证明（裁决 9）：
//  - 正向：reconcile 阻断差异 A+B+C=0，节点符合实体；
//  - 方向①：trigger 让 nav_nodes 写失败 -> 500，实体写整体回滚；
//  - 方向②：trigger 让实体表写失败 -> 500，nav 无残留/未变（同事务回滚）。
// #10 物理删顺序是「先 purgeViewNodeTx 删节点、后 tx.view.delete 删实体」，方向②注入
// views DELETE 失败，专门证明：nav 已删但实体删除失败时节点必须随事务整体复活（不留无主节点）。
// trigger 不随事务回滚，afterEach 必清。

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  json,
  failNavWrites,
  failEntityWrite,
  stopFailing,
  assertNoBlockingDiffs,
  type CharHarness,
} from "./navRouteHarness.js";
import { nodeId, WS_ID } from "../backfill.js";

let h: CharHarness;
const OWNER = "owner";

beforeAll(async () => {
  h = await makeNavHarness("gx-m3-s3-views-");
  await h.createUser(OWNER, { email: "owner-v@x.com", displayName: "Owner" });
  // 权限核心模型（二）：库放行只看「角色 × 库」，脚手架 owner 挂超级管理员才动得了库。
  await h.grantRole(OWNER);
});
afterAll(async () => h.cleanup());
afterEach(async () => stopFailing(h));

const H = async (): Promise<Record<string, string>> =>
  ({ ...(await h.auth(OWNER)), "Content-Type": "application/json" });

let seq = 0;
/** 建 base（自带 starter table+grid view），再额外建一个可删的第二视图。 */
async function setupTableWithExtraView(baseName: string, extraViewName = "V2") {
  const baseRes = await h.app.request("/api/bases", {
    method: "POST", headers: await H(), body: JSON.stringify({ name: baseName }),
  });
  const { base } = await json<{ base: { id: string } }>(baseRes);
  const table = await h.prisma.table.findFirstOrThrow({ where: { baseId: base.id } });
  const made = await h.app.request(`/api/views?tableId=${table.id}`, {
    method: "POST", headers: await H(), body: JSON.stringify({ name: extraViewName, type: "grid" }),
  });
  expect(made.status, `setup extra view ${made.status}`).toBe(201);
  const { view } = await json<{ view: { id: string } }>(made);
  return { table, view };
}

describe("#8 建视图", () => {
  it("正向：新 view 节点挂 table、0 阻断", async () => {
    const { table, view } = await setupTableWithExtraView(`VW8-${++seq}`);
    const n = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } });
    expect(n.parentId).toBe(nodeId("table", table.id));
    expect(n.ord).toBe(1);
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 500，视图回滚不存在", async () => {
    const { table } = await setupTableWithExtraView(`VW8r1-${++seq}`);
    await failNavWrites(h);
    const res = await h.app.request(`/api/views?tableId=${table.id}`, {
      method: "POST", headers: await H(), body: JSON.stringify({ name: "回滚视图", type: "grid" }),
    });
    expect(res.status).toBe(500);
    expect(await h.prisma.view.count({ where: { tableId: table.id, name: "回滚视图" } })).toBe(0);
  });

  it("方向②：views INSERT 失败 -> 500，无 view 节点残留", async () => {
    const { table } = await setupTableWithExtraView(`VW8r2-${++seq}`);
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "views", "INSERT");
    const res = await h.app.request(`/api/views?tableId=${table.id}`, {
      method: "POST", headers: await H(), body: JSON.stringify({ name: "实体失败视图", type: "grid" }),
    });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});

describe("#9 视图改名/换序", () => {
  it("正向：节点 name/ord 同步，0 阻断", async () => {
    const { view } = await setupTableWithExtraView(`VW9-${++seq}`);
    const res = await h.app.request(`/api/views/${view.id}`, {
      method: "PATCH", headers: await H(), body: JSON.stringify({ name: "V2-new", order: 5 }),
    });
    expect(res.status).toBe(200);
    const n = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } });
    expect(n.name).toBe("V2-new");
    expect(n.ord).toBe(5);
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 500，视图 name 未变", async () => {
    const { view } = await setupTableWithExtraView(`VW9r1-${++seq}`);
    await failNavWrites(h);
    const res = await h.app.request(`/api/views/${view.id}`, {
      method: "PATCH", headers: await H(), body: JSON.stringify({ name: "不该落" }),
    });
    expect(res.status).toBe(500);
    expect((await h.prisma.view.findUniqueOrThrow({ where: { id: view.id } })).name).not.toBe("不该落");
  });

  it("方向②：views UPDATE 失败 -> 500，节点 name/ord 未变", async () => {
    const { view } = await setupTableWithExtraView(`VW9r2-${++seq}`);
    const before = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } });
    await failEntityWrite(h, "views", "UPDATE");
    const res = await h.app.request(`/api/views/${view.id}`, {
      method: "PATCH", headers: await H(), body: JSON.stringify({ name: "实体失败", order: 9 }),
    });
    expect(res.status).toBe(500);
    const after = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } });
    expect(after.name).toBe(before.name);
    expect(after.ord).toBe(before.ord);
  });

  it("config-only 保存不触 nav（navVersion 不增长）", async () => {
    const { view } = await setupTableWithExtraView(`VW9cfg-${++seq}`);
    const v0 = (await h.prisma.workspace.findUniqueOrThrow({ where: { id: WS_ID } })).navVersion;
    const res = await h.app.request(`/api/views/${view.id}`, {
      method: "PATCH", headers: await H(), body: JSON.stringify({ config: { search: "x" } }),
    });
    expect(res.status).toBe(200);
    const v1 = (await h.prisma.workspace.findUniqueOrThrow({ where: { id: WS_ID } })).navVersion;
    expect(v1).toBe(v0);
  });
});

describe("#10 视图物理删（RESTRICT 守卫 + 同事务共生死）", () => {
  it("正向：无引用删除成功，实体与节点都物理消失，0 阻断", async () => {
    const { view } = await setupTableWithExtraView(`VW10-${++seq}`);
    const res = await h.app.request(`/api/views/${view.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(200);
    expect(await h.prisma.view.count({ where: { id: view.id } })).toBe(0);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("view", view.id) } })).toBe(0);
    await assertNoBlockingDiffs(h);
  });

  it("有 shortcut 引用 -> 409 NAV_NODE_IN_USE，实体与节点都保留", async () => {
    const { view } = await setupTableWithExtraView(`VW10b-${++seq}`);
    await h.prisma.menuItem.create({
      data: { id: `menu_v_${view.id}`, workspaceId: WS_ID, type: "shortcut", nodeId: nodeId("view", view.id), ord: 0 },
    });
    const res = await h.app.request(`/api/views/${view.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(409);
    expect(await h.prisma.view.count({ where: { id: view.id } })).toBe(1);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("view", view.id) } })).toBe(1);
    await h.prisma.menuItem.delete({ where: { id: `menu_v_${view.id}` } });
  });

  it("方向①：nav 删除失败 -> 500，视图实体未被物理删", async () => {
    const { view } = await setupTableWithExtraView(`VW10r1-${++seq}`);
    await failNavWrites(h);
    const res = await h.app.request(`/api/views/${view.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(500);
    expect(await h.prisma.view.count({ where: { id: view.id } })).toBe(1);
  });

  it("方向②（强证）：nav 已删但 views DELETE 失败 -> 节点随事务复活、视图仍在", async () => {
    const { view } = await setupTableWithExtraView(`VW10r2-${++seq}`);
    const nid = nodeId("view", view.id);
    await failEntityWrite(h, "views", "DELETE");
    const res = await h.app.request(`/api/views/${view.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(500);
    // 实体删除失败 -> 视图仍在；同事务里先前已删的 nav 节点必须复活，不能留无主/缺节点态。
    expect(await h.prisma.view.count({ where: { id: view.id } })).toBe(1);
    expect(await h.prisma.navNode.count({ where: { id: nid } })).toBe(1);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nid } })).deletedAt).toBeNull();
    await assertNoBlockingDiffs(h);
  });
});

describe("补点 视图复制（第 19 写点）", () => {
  it("正向：新活 view 有节点、不生成 view shortcut、0 阻断", async () => {
    const { table, view } = await setupTableWithExtraView(`VWdup-${++seq}`);
    const res = await h.app.request(`/api/views/${view.id}/duplicate`, {
      method: "POST", headers: await h.auth(OWNER),
    });
    expect(res.status).toBe(201);
    const { view: copy } = await json<{ view: { id: string } }>(res);
    const n = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", copy.id) } });
    expect(n.parentId).toBe(nodeId("table", table.id));
    expect(await h.prisma.menuItem.count({ where: { nodeId: n.id } })).toBe(0);
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 500，复制视图回滚", async () => {
    const { table, view } = await setupTableWithExtraView(`VWdupr1-${++seq}`);
    await failNavWrites(h);
    const res = await h.app.request(`/api/views/${view.id}/duplicate`, {
      method: "POST", headers: await h.auth(OWNER),
    });
    expect(res.status).toBe(500);
    // 副本随事务回滚：限定本表（同库其它用例已提交的副本不计）。
    expect(await h.prisma.view.count({ where: { tableId: table.id, name: { contains: "副本" } } })).toBe(0);
  });

  it("方向②：views INSERT 失败 -> 500，无复制节点残留", async () => {
    const { view } = await setupTableWithExtraView(`VWdupr2-${++seq}`);
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "views", "INSERT");
    const res = await h.app.request(`/api/views/${view.id}/duplicate`, {
      method: "POST", headers: await h.auth(OWNER),
    });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});
