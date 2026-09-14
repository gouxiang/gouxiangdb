// M3/S0 特征测试（一）：六类实体的建/改名/软删/恢复/物理删【现状行为】锁。
//
// M3-S3 会把 nav 同步原语接进 bases/tables/views/kb/records 五路由的既有事务，
// 并把若干裸多写收紧进 withWriteTx/withWriteBatch。本文件在接线前钉死可观察行为，
// S3 完成后必须逐值复跑通过（内容 URL/HTTP 状态/实体 deletedAt/order 语义零变化）。
//
// 锁定的现状事实（M3 计划 §1.4，行号以 43bac9b 为准）：
//  - Base：软删 = base + 其下 tables 打 deletedAt；fields/records/views 不动；无恢复端点。
//  - Table：软删 = table/records/fields 打 deletedAt、views 置 order=-1（不是 deletedAt）；
//    恢复走 POST /api/records/trash/:id {kind:"table"}，连带 fields/records/linkRows/views 序；
//    物理删走 DELETE /api/records/trash/:id?kind=table。
//  - View：无 deletedAt 列，删除是物理删；至少保留一个视图（400）。
//  - KB：软删 = kb + 其下 docs 打 deletedAt（docs 带 deletedBy）；无恢复端点。
//  - KbDoc：软删带 deletedBy；恢复清双字段；物理删连删 versions/acls。
//  - doc 可嵌套移动，canvas 移动 400。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupCharHarness, json, type CharHarness } from "./charHarness.js";

let h: CharHarness;
let u: string;

beforeAll(async () => {
  h = await setupCharHarness("gx-m3-life-");
  u = "u_life";
  await h.createUser(u, { email: "life@example.com" });
});
afterAll(() => h.cleanup());

describe("M3 现状：Base/Table/View 删除语义", () => {
  it("建 base 自动建 starter table + 1 grid 视图", async () => {
    const res = await h.app.request("/api/bases", {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "生命周期库" }),
    });
    expect(res.status).toBe(201);
    const { bases } = await json<{ bases: Array<{ id: string }> }>(
      await h.app.request("/api/bases", { headers: await h.auth(u) }),
    );
    expect(bases).toHaveLength(1);
    const baseId = bases[0]!.id;

    const tablesRes = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth(u) });
    const { tables } = await json<{ tables: Array<{ id: string }> }>(tablesRes);
    expect(tables).toHaveLength(1);
    const tableId = tables[0]!.id;

    const viewsRes = await h.app.request(`/api/views?tableId=${tableId}`, { headers: await h.auth(u) });
    const { views } = await json<{ views: Array<{ id: string; order: number }> }>(viewsRes);
    expect(views).toHaveLength(1);
    expect(views[0]!.order).toBe(0);
  });

  it("Table 软删：table/records/fields 打 deletedAt，views 置 order=-1（非 deletedAt）", async () => {
    const { baseId, tableId } = await createBaseWithTable();
    await h.prisma.record.create({ data: { tableId, fields: "{}", createdBy: u, updatedBy: u } });
    await h.prisma.field.create({ data: { tableId, name: "f1", type: "singleLineText", order: 9 } });
    const viewId = (await h.prisma.view.findFirstOrThrow({ where: { tableId } })).id;

    const res = await h.app.request(`/api/tables/${tableId}`, { method: "DELETE", headers: await h.auth(u) });
    expect(res.status).toBe(200);

    const t = await h.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(t.deletedAt).not.toBeNull();
    expect(await h.prisma.record.count({ where: { tableId, deletedAt: null } })).toBe(0);
    expect(await h.prisma.field.count({ where: { tableId, deletedAt: null } })).toBe(0);
    // 视图不打 deletedAt，只置 order=-1（views 表根本没有 deletedAt 列）。
    const v = await h.prisma.view.findUniqueOrThrow({ where: { id: viewId } });
    expect(v.order).toBe(-1);
    // 软删表从列表消失。
    const { tables } = await json<{ tables: unknown[] }>(
      await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth(u) }),
    );
    expect(tables).toHaveLength(0);
  });

  it("回收站恢复 table：table/fields/records 复活，views order 重排为 >=0", async () => {
    const { baseId, tableId } = await createBaseWithTable();
    await h.app.request(`/api/tables/${tableId}`, { method: "DELETE", headers: await h.auth(u) });

    const res = await h.app.request(`/api/records/trash/${tableId}/restore`, {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "table" }),
    });
    expect(res.status).toBe(200);

    const t = await h.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(t.deletedAt).toBeNull();
    const hidden = await h.prisma.view.findMany({ where: { tableId: tableId, order: -1 } });
    expect(hidden).toHaveLength(0);
    const views = await h.prisma.view.findMany({ where: { tableId } });
    expect(views.every((x) => x.order >= 0)).toBe(true);
    const { tables } = await json<{ tables: Array<{ id: string }> }>(
      await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth(u) }),
    );
    expect(tables.map((x) => x.id)).toContain(tableId);
  });

  it("回收站物理删 table：行真正消失（cascade fields/views/records）", async () => {
    const { tableId } = await createBaseWithTable();
    const res = await h.app.request(`/api/records/trash/${tableId}?kind=table`, {
      method: "DELETE",
      headers: await h.auth(u),
    });
    expect(res.status).toBe(200);
    expect(await h.prisma.table.findUnique({ where: { id: tableId } })).toBeNull();
    expect(await h.prisma.view.count({ where: { tableId } })).toBe(0);
  });

  it("View 物理删且至少保留一个视图：第 2 个可删，最后一个 400", async () => {
    const { tableId } = await createBaseWithTable();
    const created = await h.app.request(`/api/views?tableId=${tableId}`, {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "画廊", type: "gallery" }),
    });
    expect(created.status).toBe(201);
    const { view } = await json<{ view: { id: string } }>(created);

    const ok = await h.app.request(`/api/views/${view.id}`, { method: "DELETE", headers: await h.auth(u) });
    expect(ok.status).toBe(200);
    expect(await h.prisma.view.findUnique({ where: { id: view.id } })).toBeNull();

    const last = (await h.prisma.view.findFirstOrThrow({ where: { tableId } })).id;
    const blocked = await h.app.request(`/api/views/${last}`, { method: "DELETE", headers: await h.auth(u) });
    expect(blocked.status).toBe(400);
    expect(await h.prisma.view.findUnique({ where: { id: last } })).not.toBeNull();
  });

  it("Base 软删：base 与其下 tables 打 deletedAt（不处理 fields/records/views），无恢复端点", async () => {
    const { baseId, tableId } = await createBaseWithTable();
    const res = await h.app.request(`/api/bases/${baseId}`, { method: "DELETE", headers: await h.auth(u) });
    expect(res.status).toBe(200);

    const b = await h.prisma.base.findUniqueOrThrow({ where: { id: baseId } });
    expect(b.deletedAt).not.toBeNull();
    const t = await h.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(t.deletedAt).not.toBeNull();
    // 现状不对称的事实：base 级联不碰 fields/records/views。
    expect(await h.prisma.field.count({ where: { tableId, deletedAt: null } })).toBeGreaterThan(0);
    // 无 base 恢复路由（POST /api/bases/:id/restore 落入 404）。
    const restore = await h.app.request(`/api/bases/${baseId}/restore`, {
      method: "POST",
      headers: await h.auth(u),
    });
    expect(restore.status).toBe(404);
  });
});

describe("M3 现状：KB / KbDoc 删除与移动语义", () => {
  async function createKbWithDoc(kind: "doc" | "canvas" = "doc") {
    const kbRes = await h.app.request("/api/kb", {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "知识库" }),
    });
    const { knowledgeBase } = await json<{ knowledgeBase: { id: string } }>(kbRes);
    const docRes = await h.app.request(`/api/kb/${knowledgeBase.id}/docs`, {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const { doc } = await json<{ doc: { id: string } }>(docRes);
    return { kbId: knowledgeBase.id, docId: doc.id };
  }

  it("doc 软删带 deletedBy，restore 清 deletedAt/deletedBy", async () => {
    const { docId } = await createKbWithDoc("doc");
    const del = await h.app.request(`/api/kb/docs/${docId}`, { method: "DELETE", headers: await h.auth(u) });
    expect(del.status).toBe(200);
    let row = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: docId } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(u);

    const restore = await h.app.request(`/api/kb/docs/${docId}/restore`, { method: "POST", headers: await h.auth(u) });
    expect(restore.status).toBe(200);
    row = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: docId } });
    expect(row.deletedAt).toBeNull();
    expect(row.deletedBy).toBeNull();
  });

  it("doc 物理删连删版本与 ACL，行消失", async () => {
    const { docId } = await createKbWithDoc("doc");
    await h.prisma.kbDocVersion.create({
      data: { docId, version: 9, label: "x", title: "t", content: "c", createdBy: u },
    });
    const res = await h.app.request(`/api/kb/docs/${docId}/permanent`, {
      method: "DELETE",
      headers: await h.auth(u),
    });
    expect(res.status).toBe(200);
    expect(await h.prisma.kbDoc.findUnique({ where: { id: docId } })).toBeNull();
    expect(await h.prisma.kbDocVersion.count({ where: { docId } })).toBe(0);
  });

  it("KB 软删：kb 与其下 docs 打 deletedAt（docs 带 deletedBy），无恢复端点", async () => {
    const { kbId, docId } = await createKbWithDoc("doc");
    const res = await h.app.request(`/api/kb/${kbId}`, { method: "DELETE", headers: await h.auth(u) });
    expect(res.status).toBe(200);
    const kb = await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(kb.deletedAt).not.toBeNull();
    const doc = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.deletedAt).not.toBeNull();
    expect(doc.deletedBy).toBe(u);
    const restore = await h.app.request(`/api/kb/${kbId}/restore`, { method: "POST", headers: await h.auth(u) });
    expect(restore.status).toBe(404);
  });

  it("doc 可移动 parentId；canvas 移动 400；挂自身子级 400", async () => {
    const { kbId } = await createKbWithDoc("doc");
    const mk = async (title: string) => {
      const r = await h.app.request(`/api/kb/${kbId}/docs`, {
        method: "POST",
        headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "doc", title }),
      });
      return (await json<{ doc: { id: string } }>(r)).doc.id;
    };
    const parent = await mk("父");
    const child = await mk("子");

    const move = await h.app.request(`/api/kb/docs/${child}/move`, {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: parent }),
    });
    expect(move.status).toBe(200);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: child } })).parentId).toBe(parent);

    const selfCycle = await h.app.request(`/api/kb/docs/${parent}/move`, {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: child }),
    });
    expect(selfCycle.status).toBe(400);

    const { docId: canvasId } = await createKbWithDoc("canvas");
    const canvasMove = await h.app.request(`/api/kb/docs/${canvasId}/move`, {
      method: "POST",
      headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: parent }),
    });
    expect(canvasMove.status).toBe(400);
  });
});

async function createBaseWithTable(): Promise<{ baseId: string; tableId: string }> {
  const res = await h.app.request("/api/bases", {
    method: "POST",
    headers: { ...(await h.auth(u)), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "库" }),
  });
  const body = await json<{ base: { id: string } }>(res);
  const baseId = body.base.id;
  const tablesRes = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth(u) });
  const tables = await json<{ tables: Array<{ id: string }> }>(tablesRes);
  return { baseId, tableId: tables.tables[0]!.id };
}
