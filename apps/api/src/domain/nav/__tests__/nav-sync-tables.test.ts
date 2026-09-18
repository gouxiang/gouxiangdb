// M3/S3 路由层写点同步测试（tables.ts：#4 建 / #5 改名 / #6 软删 / #7 复制）。
// views.ts 的 #8-#10/视图复制见 nav-sync-views.test.ts。
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

// makeNavHarness 每建一次就拉起 `prisma migrate deploy` 子进程（真建库 + 16 个迁移），
// 2C 低配机上单次 5~7s，超 vitest 默认 hookTimeout=10000ms 的风险实在；且 hook 超时必须
// 写在 beforeAll 的第二个参数上（写在 it 上无效），故显式给 30s 预算。
beforeAll(async () => {
  h = await makeNavHarness("gx-m3-s3-tables-");
  await h.createUser(OWNER, { email: "owner-t@x.com", displayName: "Owner" });
}, 30_000);
// 守卫而非兜 bug：beforeAll 一旦超时，h 仍是 undefined，直接 h.cleanup() 会再抛
// "Cannot read properties of undefined"，把一个超时掩盖成两个报错、干扰定位。
afterAll(async () => {
  if (h) await h.cleanup();
});
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

  it("方向②：tables UPDATE 失败 -> 500，节点 name 未变", async () => {
    const baseId = await makeBase("TB5c");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    await failEntityWrite(h, "tables", "UPDATE");
    const res = await h.app.request(`/api/tables/${table.id}`, { method: "PATCH", headers: await H(), body: JSON.stringify({ name: "T2-x" }) });
    expect(res.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", table.id) } })).name).toBe("T");
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

  it("方向②：nav 之前的 views 更新失败 -> 500，实体回滚未软删、nav 子树仍活", async () => {
    const baseId = await makeBase("TB6c");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "T" }) }));
    const view = await h.prisma.view.findFirstOrThrow({ where: { tableId: table.id } });
    // 事务顺序：table/record/field/view 更新后才 softDeleteSubtreeTx；让 view 更新炸，
    // 先前更新整体回滚，nav 一步未触。
    await failEntityWrite(h, "views", "UPDATE");
    const res = await h.app.request(`/api/tables/${table.id}`, { method: "DELETE", headers: await h.auth(OWNER) });
    expect(res.status).toBe(500);
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: table.id } })).deletedAt).toBeNull();
    expect((await h.prisma.view.findUniqueOrThrow({ where: { id: view.id } })).order).toBeGreaterThanOrEqual(0);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", table.id) } })).deletedAt).toBeNull();
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } })).deletedAt).toBeNull();
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

  it("方向②：nav 之前的 views INSERT 失败 -> 500，复制表回滚、无副本节点", async () => {
    const baseId = await makeBase("TB7c");
    const { table } = await json<{ table: { id: string } }>(await h.app.request(`/api/tables?baseId=${baseId}`, { method: "POST", headers: await H(), body: JSON.stringify({ name: "Src" }) }));
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "views", "INSERT");
    const res = await h.app.request(`/api/tables/${table.id}/duplicate`, { method: "POST", headers: await H(), body: JSON.stringify({}) });
    expect(res.status).toBe(500);
    expect(await h.prisma.table.count({ where: { baseId, name: { contains: "副本" } } })).toBe(0);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});
