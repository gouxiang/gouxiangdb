// M3/S3 路由层写点同步测试（records.ts 回收站：#14 恢复 table / #15 物理删 table）。
//
// 三证明（裁决 9）：正向 reconcile 0 阻断；方向① nav 失败实体回滚；
// 方向②/真实 RESTRICT：物理删遇菜单引用 409 且实体/节点都保留。

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  json,
  failNavWrites,
  stopFailing,
  assertNoBlockingDiffs,
  type CharHarness,
} from "./navRouteHarness.js";
import { nodeId, WS_ID } from "../backfill.js";

let h: CharHarness;
const OWNER = "owner";

beforeAll(async () => {
  h = await makeNavHarness("gx-m3-s3-records-");
  await h.createUser(OWNER, { email: "owner@rec.com", displayName: "Owner" });
});
afterAll(async () => { await h.cleanup(); });
afterEach(async () => { await stopFailing(h); });

const post = async (url: string, body: unknown) =>
  h.app.request(url, { method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = async (url: string) =>
  h.app.request(url, { method: "DELETE", headers: await h.auth(OWNER) });

let seq = 0;
async function freshBaseTable(name = `R${++seq}`) {
  const res = await post("/api/bases", { name });
  expect(res.status).toBe(201);
  const { base } = await json<{ base: { id: string } }>(res);
  const table = await h.prisma.table.findFirstOrThrow({ where: { baseId: base.id } });
  const view = await h.prisma.view.findFirstOrThrow({ where: { tableId: table.id } });
  return { base, table, view };
}

describe("#14 回收站恢复 table（连带字段/记录/视图序）", () => {
  it("正向：软删后节点软删，恢复后 table/view 节点复活、view order>=0、0 阻断", async () => {
    const { table, view } = await freshBaseTable("R14");
    expect((await del(`/api/tables/${table.id}`)).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", table.id) } })).deletedAt).not.toBeNull();
    const restore = await post(`/api/records/trash/${table.id}/restore`, { kind: "table" });
    expect(restore.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", table.id) } })).deletedAt).toBeNull();
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } })).deletedAt).toBeNull();
    expect((await h.prisma.view.findUniqueOrThrow({ where: { id: view.id } })).order).toBeGreaterThanOrEqual(0);
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 恢复整体回滚，table 仍软删、view 仍 order=-1", async () => {
    const { table, view } = await freshBaseTable("R14rb");
    await del(`/api/tables/${table.id}`);
    await failNavWrites(h);
    const bad = await post(`/api/records/trash/${table.id}/restore`, { kind: "table" });
    expect(bad.status).toBe(500);
    expect((await h.prisma.table.findUniqueOrThrow({ where: { id: table.id } })).deletedAt).not.toBeNull();
    expect((await h.prisma.view.findUniqueOrThrow({ where: { id: view.id } })).order).toBe(-1);
  });
});

describe("#15 回收站物理删 table", () => {
  it("table 节点有 shortcut -> 409 实体不删；清引用后物理删成功、table/view 节点连删、0 阻断", async () => {
    const { table, view } = await freshBaseTable("R15");
    await del(`/api/tables/${table.id}`); // 进回收站
    await h.prisma.menuItem.create({
      data: { id: `menu_probe_${table.id}`, workspaceId: WS_ID, type: "shortcut", nodeId: nodeId("table", table.id), ord: 0 },
    });
    const blocked = await del(`/api/records/trash/${table.id}?kind=table`);
    expect(blocked.status).toBe(409);
    expect(await h.prisma.table.count({ where: { id: table.id } })).toBe(1);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("table", table.id) } })).toBe(1);
    await h.prisma.menuItem.delete({ where: { id: `menu_probe_${table.id}` } });

    const ok = await del(`/api/records/trash/${table.id}?kind=table`);
    expect(ok.status).toBe(200);
    expect(await h.prisma.table.count({ where: { id: table.id } })).toBe(0);
    expect(await h.prisma.navNode.count({
      where: { id: { in: [nodeId("table", table.id), nodeId("view", view.id)] } },
    })).toBe(0);
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 物理删回滚，table 实体仍在回收站", async () => {
    const { table } = await freshBaseTable("R15rb");
    await del(`/api/tables/${table.id}`);
    await failNavWrites(h);
    const bad = await del(`/api/records/trash/${table.id}?kind=table`);
    expect(bad.status).toBe(500);
    expect(await h.prisma.table.count({ where: { id: table.id } })).toBe(1);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("table", table.id) } })).toBe(1);
  });
});
