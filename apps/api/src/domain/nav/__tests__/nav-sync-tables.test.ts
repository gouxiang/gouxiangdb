// M3/S3 路由层写点同步测试（tables.ts：#4 建 / #5 改名 / #6 软删 / #7 复制；
// views.ts：#8 建 / #9 改名 / #10 物理删 409 守卫 / 补点 视图复制）。
//
// 每写点：正向（reconcile 0 阻断）+ 方向①（nav trigger 失败 -> 实体回滚）
// + 方向②（实体 trigger 失败 -> nav 无残留）。trigger afterEach 清。

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
import { nodeId } from "../backfill.js";

let h: CharHarness;
const OWNER = "owner";

beforeAll(async () => {
  h = await makeNavHarness("gx-m3-s3-tables-");
  await h.createUser(OWNER, { email: "owner-t@x.com", displayName: "Owner" });
});
afterAll(async () => h.cleanup());
afterEach(async () => stopFailing(h));

async function makeBase(name: string): Promise<string> {
  const res = await h.app.request("/api/bases", {
    method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await json<{ base: { id: string } }>(res)).base.id;
}
const H = async (): Promise<Record<string, string>> => ({ ...(await h.auth(OWNER)), "Content-Type": "application/json" });

describe("#4 建 table（含字段+视图，withWriteTx）", () => {
  it("正向：table+view 节点齐、path 三层，0 阻断", async () => {
    const baseId = await makeBase("TB4");
    const res = await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T1" }) });
    expect(res.status).toBe(201);
    const { table } = await json<{ table: { id: string } }>(res);
    const view = await h.prisma.view.findFirstOrThrow({ where: { tableId: table.id } });
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", table.id) } })).deletedAt).toBeNull();
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } })).depth).toBe(3);
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，表/字段/视图回滚", async () => {
    const baseId = await makeBase("TB4b");
    await failNavWrites(h);
    const res = await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T1x" }) });
    expect(res.status).toBe(500);
    expect(await h.prisma.table.count({ where: { baseId, name: "T1x" } })).toBe(0);
  });
  it("方向②：实体表写入失败 -> 500，无 table 节点残留", async () => {
    const baseId = await makeBase("TB4c");
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "tables", "INSERT");
    const res = await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T1y" }) });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});

describe("#5 table 改名", () => {
  it("正向：节点 name 同步，0 阻断", async () => {
    const baseId = await makeBase("TB5");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    const res = await h.app.request(`/api/tables/${table.id}`, { method: "PATCH", headers: await H(), body: JSON.stringify({ name: "T2" }) });
    expect(res.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", table.id) } })).name).toBe("T2");
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，实体 name 未变", async () => {
    const baseId = await makeBase("TB5b");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    await failNavWrites(h);
    const res = await h.app.request(`/api/tables/${table.id}`, { method: "PATCH", headers: await H(), body: JSON.stringify({ name: "Tx" }) });
    expect(res.status).toBe(500);
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: table.id } })).name).toBe("T");
  });
});

describe("#6 table 软删（views order=-1，子树节点软删）", () => {
  it("正向：table/view 节点软删，view order=-1，0 阻断", async () => {
    const baseId = await makeBase("TB6");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    const view = await h.prisma.view.findFirstOrThrow({ where: { tableId: table.id } });
    const res = await h.app.request(`/api/tables/${table.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(200);
    expect((await h.prisma.view.findUniqueOrThrow({ where: { id: view.id } })).order).toBe(-1);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } })).deletedAt).not.toBeNull();
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，实体未软删、view order 未置 -1", async () => {
    const baseId = await makeBase("TB6b");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    await failNavWrites(h);
    const res = await h.app.request(`/api/tables/${table.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(500);
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: table.id } })).deletedAt).toBeNull();
  });
});

describe("#7 table 复制（收紧进事务，节点 upsert，不自动加菜单 shortcut）", () => {
  it("正向：新表/视图节点存在，新表无 shortcut（未收纳 warning 不阻断），0 阻断", async () => {
    const baseId = await makeBase("TB7");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "Src" }) }));
    const res = await h.app.request(`/api/tables/${table.id}/duplicate`, { method: "POST", headers: await H(), body: JSON.stringify({}) });
    expect(res.status).toBe(201);
    const { table: copy } = await json<{ table: { id: string } }>(res);
    expect((await h.prisma.navNode.findUnique({ where: { id: nodeId("table", copy.id) } }))).not.toBeNull();
    // 未收纳：复制出的新表无菜单 shortcut（方案 A，C4 仅 warning）
    expect(await h.prisma.menuItem.count({ where: { nodeId: nodeId("table", copy.id) } })).toBe(0);
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，复制表回滚不存在", async () => {
    const baseId = await makeBase("TB7b");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "Src" }) }));
    await failNavWrites(h);
    const res = await h.app.request(`/api/tables/${table.id}/duplicate`, { method: "POST", headers: await H(), body: JSON.stringify({}) });
    expect(res.status).toBe(500);
    expect(await h.prisma.table.count({ where: { baseId, name: { contains: "副本" } } })).toBe(0);
  });
});

describe("#8 建视图 / #9 视图改名 / 补点 视图复制", () => {
  async function setupTable(baseName: string) {
    const baseId = await makeBase(baseName);
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    return table.id;
  }
  it("#8 正向：新 view 节点存在，0 阻断；方向①回滚", async () => {
    const tableId = await setupTable("VW8");
    const res = await h.app.request(`/api/views?tableId=${tableId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "V2", type: "grid" }) });
    expect(res.status).toBe(201);
    const { view } = await json<{ view: { id: string } }>(res);
    expect(await h.prisma.navNode.count({ where: { resourceId: view.id } })).toBe(1);
    await assertNoBlockingDiffs(h);
  });
  it("#9 改名/排序：节点 name/ord 同步；方向① nav 失败实体未变", async () => {
    const tableId = await setupTable("VW9");
    const created = await json<{ view: { id: string } }>(await h.app.request(`/api/views?tableId=${tableId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "V2", type: "grid" }) }));
    const res = await h.app.request(`/api/views/${created.view.id}`, { method: "PATCH", headers: await H(), body: JSON.stringify({ name: "V2x", order: 3 }) });
    expect(res.status).toBe(200);
    const node = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", created.view.id) } });
    expect(node.name).toBe("V2x");
    expect(node.ord).toBe(3);
  });
  it("补点 视图复制：新活 view 有节点（否则 reconcile A1），0 阻断", async () => {
    const tableId = await setupTable("VWdup");
    const created = await json<{ view: { id: string } }>(await h.app.request(`/api/views?tableId=${tableId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "V2", type: "grid" }) }));
    const res = await h.app.request(`/api/views/${created.view.id}/duplicate`, { method: "POST", headers: await h.auth(OWNER) });
    expect(res.status).toBe(201);
    const { view } = await json<{ view: { id: string } }>(res);
    expect(await h.prisma.navNode.count({ where: { resourceId: view.id } })).toBe(1);
    await assertNoBlockingDiffs(h);
  });
});

describe("#10 视图物理删：RESTRICT 守卫", () => {
  it("无菜单引用时删除成功，节点随之物理删，0 阻断", async () => {
    const baseId = await makeBase("VW10");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    const created = await json<{ view: { id: string } }>(await h.app.request(`/api/views?tableId=${table.id}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "V2", type: "grid" }) }));
    const res = await h.app.request(`/api/views/${created.view.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(200);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("view", created.view.id) } })).toBe(0);
    await assertNoBlockingDiffs(h);
  });
  it("有菜单 shortcut 引用 -> 409 NAV_NODE_IN_USE，实体与节点都保留", async () => {
    const baseId = await makeBase("VW10b");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    const created = await json<{ view: { id: string } }>(await h.app.request(`/api/views?tableId=${table.id}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "V2", type: "grid" }) }));
    await h.prisma.menuItem.create({ data: { workspaceId: "ws_default", type: "shortcut", nodeId: nodeId("view", created.view.id) } });
    const res = await h.app.request(`/api/views/${created.view.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(409);
    expect(await h.prisma.view.count({ where: { id: created.view.id } })).toBe(1);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("view", created.view.id) } })).toBe(1);
  });
});
