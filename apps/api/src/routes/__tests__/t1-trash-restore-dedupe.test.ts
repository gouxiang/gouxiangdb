// T-1 回收站恢复同名去歧义（真 app HTTP + 真迁移临时库）。
//
// 缺陷：删除字段/表 -> 新建同名的新字段/新表 -> 从回收站恢复旧的那个，
// 会在同一张表 / 同一个 Base 里落下两个同名活实体，全程无提示。
// 恢复路径不能像新建路径那样 409 拒绝（回收站里的东西必须拿得回来），故改为自动改名：
//   `<原名>（已恢复）` -> `<原名>（已恢复 2）` -> ……
// 成功响应多带 `renamed: boolean` 与 `name: string`（最终名字），供前端提示（前端另行派单）。
//
// 短路验证方式：把 domain/restoreName.ts 的 pickFirstFree 改成「永远返回原名」后，
// 本文件里 4 条改名相关用例（字段改名 / 表改名 / 序号递增 2 条）应转红，
// 无冲突与 403 用例仍绿。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

// 必须在任何静态 import 记录路由链之前 hoist（_realApp 内是动态 import，此 mock 仍全局生效）。
vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let prisma: PrismaClient;

beforeAll(async () => {
  h = await setupHarness("gx-t1-restore-");
  prisma = h.prisma;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

async function makeField(tableId: string, name: string): Promise<string> {
  const res = await h.request("POST", `/fields?tableId=${tableId}`, { name, type: "singleLineText" });
  expect(res.status).toBe(201);
  return (await res.json()).field.id as string;
}

async function softDeleteField(fieldId: string): Promise<void> {
  const res = await h.request("DELETE", `/fields/${fieldId}`);
  expect(res.status).toBe(200);
}

/** 复刻 DELETE /tables/:tableId 的实体级效果（tables 路由不在本夹具挂载的路由集里）。 */
async function softDeleteTable(tableId: string): Promise<void> {
  const now = new Date();
  await prisma.table.update({ where: { id: tableId }, data: { deletedAt: now } });
  await prisma.field.updateMany({ where: { tableId }, data: { deletedAt: now } });
  await prisma.record.updateMany({ where: { tableId }, data: { deletedAt: now } });
  await prisma.view.updateMany({ where: { tableId }, data: { order: -1 } });
}

async function restore(kind: "field" | "table", id: string): Promise<{ status: number; body: any }> {
  const res = await h.request("POST", `/records/trash/${id}/restore`, { kind });
  return { status: res.status, body: await res.json() };
}

async function liveFieldNames(tableId: string): Promise<string[]> {
  const rows = await prisma.field.findMany({
    where: { tableId, deletedAt: null },
    select: { name: true },
  });
  return rows.map((f) => f.name);
}

async function liveTableNames(baseId: string): Promise<string[]> {
  const rows = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { name: true },
  });
  return rows.map((t) => t.name);
}

describe("T-1 回收站恢复同名去歧义", () => {
  it("字段：删除后重建同名字段再恢复旧的 -> 旧的自动改名，表内无重名活字段", async () => {
    const baseId = await h.makeBase();
    const { id: tableId } = await h.makeTable(baseId, "t");
    const oldField = await makeField(tableId, "待删字段");
    await softDeleteField(oldField);
    const freshField = await makeField(tableId, "待删字段");

    const r = await restore("field", oldField);
    expect(r.status).toBe(200);
    expect(r.body.renamed).toBe(true);
    expect(r.body.name).toBe("待删字段（已恢复）");

    const old = await prisma.field.findUnique({ where: { id: oldField } });
    const fresh = await prisma.field.findUnique({ where: { id: freshField } });
    expect(old?.deletedAt).toBeNull();
    expect(old?.name).toBe("待删字段（已恢复）");
    expect(fresh?.deletedAt).toBeNull();
    expect(fresh?.name).toBe("待删字段");

    const names = await liveFieldNames(tableId);
    expect(new Set(names).size).toBe(names.length); // 同表内无重名
  });

  it("表：删除后重建同名表再恢复旧的 -> 旧的自动改名，库内无重名活表", async () => {
    const baseId = await h.makeBase();
    const oldTable = await h.makeTable(baseId, "回收走查");
    await softDeleteTable(oldTable.id);
    await h.makeTable(baseId, "回收走查");

    const r = await restore("table", oldTable.id);
    expect(r.status).toBe(200);
    expect(r.body.renamed).toBe(true);
    expect(r.body.name).toBe("回收走查（已恢复）");

    const t = await prisma.table.findUnique({ where: { id: oldTable.id } });
    expect(t?.deletedAt).toBeNull();
    expect(t?.name).toBe("回收走查（已恢复）");

    const names = await liveTableNames(baseId);
    expect(new Set(names).size).toBe(names.length); // 同库内无重名
  });

  it("无同名冲突 -> 字段与表的名字一字不动，renamed=false", async () => {
    const baseId = await h.makeBase();
    const { id: tableId } = await h.makeTable(baseId, "t");

    const f = await makeField(tableId, "唯一字段");
    await softDeleteField(f);
    const rf = await restore("field", f);
    expect(rf.status).toBe(200);
    expect(rf.body.renamed).toBe(false);
    expect(rf.body.name).toBe("唯一字段");
    expect((await prisma.field.findUnique({ where: { id: f } }))?.name).toBe("唯一字段");

    const t = await h.makeTable(baseId, "唯一表");
    await softDeleteTable(t.id);
    const rt = await restore("table", t.id);
    expect(rt.status).toBe(200);
    expect(rt.body.renamed).toBe(false);
    expect(rt.body.name).toBe("唯一表");
    expect((await prisma.table.findUnique({ where: { id: t.id } }))?.name).toBe("唯一表");
  });

  it("连续恢复多个同名字段 -> 序号递增不撞车", async () => {
    const baseId = await h.makeBase();
    const { id: tableId } = await h.makeTable(baseId, "t");

    const f1 = await makeField(tableId, "同名");
    await softDeleteField(f1);
    const f2 = await makeField(tableId, "同名");
    await softDeleteField(f2);
    await makeField(tableId, "同名"); // 当前活着的那个

    const r1 = await restore("field", f1);
    expect(r1.body.name).toBe("同名（已恢复）");
    const r2 = await restore("field", f2);
    expect(r2.body.name).toBe("同名（已恢复 2）");

    const names = await liveFieldNames(tableId);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("同名");
    expect(names).toContain("同名（已恢复）");
    expect(names).toContain("同名（已恢复 2）");
  });

  it("连续恢复多个同名表 -> 序号递增不撞车", async () => {
    const baseId = await h.makeBase();
    const t1 = await h.makeTable(baseId, "同名表");
    await softDeleteTable(t1.id);
    const t2 = await h.makeTable(baseId, "同名表");
    await softDeleteTable(t2.id);
    await h.makeTable(baseId, "同名表"); // 当前活着的那个

    const r1 = await restore("table", t1.id);
    expect(r1.body.name).toBe("同名表（已恢复）");
    const r2 = await restore("table", t2.id);
    expect(r2.body.name).toBe("同名表（已恢复 2）");

    const names = await liveTableNames(baseId);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["同名表", "同名表（已恢复）", "同名表（已恢复 2）"]));
  });

  it("软删的同名实体不算冲突 -> 不误改名", async () => {
    const baseId = await h.makeBase();
    const { id: tableId } = await h.makeTable(baseId, "t");
    const f1 = await makeField(tableId, "X");
    await softDeleteField(f1);
    const f2 = await makeField(tableId, "X");
    await softDeleteField(f2); // 两个都躺在回收站，表里没有活着的 X

    const r = await restore("field", f1);
    expect(r.body.renamed).toBe(false);
    expect(r.body.name).toBe("X");
    expect((await prisma.field.findUnique({ where: { id: f2 } }))?.deletedAt).not.toBeNull();
  });

  it("无 canManageSchema（editor）恢复字段/表仍 403，且不改名不复活", async () => {
    const baseId = await h.makeBase();
    await prisma.member.update({
      where: { baseId_userId: { baseId, userId: OWNER_ID } },
      data: { role: "editor" }, // editor: canManageSchema=false
    });
    const { id: tableId } = await h.makeTable(baseId, "t");
    const f = await prisma.field.create({
      data: { tableId, name: "待恢复", type: "singleLineText", order: 1, deletedAt: new Date() },
    });
    await softDeleteTable(tableId);

    const rf = await restore("field", f.id);
    expect(rf.status).toBe(403);
    const afterF = await prisma.field.findUnique({ where: { id: f.id } });
    expect(afterF?.deletedAt).not.toBeNull();
    expect(afterF?.name).toBe("待恢复");

    const rt = await restore("table", tableId);
    expect(rt.status).toBe(403);
    const afterT = await prisma.table.findUnique({ where: { id: tableId } });
    expect(afterT?.deletedAt).not.toBeNull();
    expect(afterT?.name).toBe("t");
  });
});
