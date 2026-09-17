// RC-12 软删 / 硬删级联（真 app HTTP + 真迁移临时库）。
//  - 软删 DELETE /records/:id：softDeleteRecordTx 同事务把 record 与双向 linkRow 都打 deletedAt
//    （可恢复）；POST /records/trash/:id/restore 把两端都存活的 linkRow 重新置有效。
//  - 硬删 DELETE /records/trash/:id?kind=record：purge 同事务物理清 linkRow / comments 再删实体，
//    不留孤儿行。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let prisma: PrismaClient;
let tableA: string;
let tableB: string;
let forwardLinkId: string;

beforeAll(async () => {
  h = await setupHarness("gx-rc12-cascade-");
  prisma = h.prisma;
  const baseId = await h.makeBase();
  const a = await h.makeTable(baseId, "A");
  const b = await h.makeTable(baseId, "B");
  tableA = a.id;
  tableB = b.id;
  // 双向 links 字段结构贯穿两例（beforeEach 只清数据行，不重建字段，避免重名 409）。
  const res = await h.request("POST", `/fields?tableId=${tableA}`, {
    name: "关联B",
    type: "links",
    relatedTableId: tableB,
    relationKind: "hm",
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  forwardLinkId = body.field.id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(async () => {
  await prisma.comment.deleteMany({});
  await prisma.linkRow.deleteMany({});
  await prisma.record.deleteMany({});
  await prisma.changeEvent.deleteMany({});
});

async function makeRecord(tableId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const r = await prisma.record.create({
    data: { tableId, fields: JSON.stringify(fields), createdBy: OWNER_ID, updatedBy: OWNER_ID },
  });
  return r.id;
}

describe("RC-12 软删可恢复级联", () => {
  it("软删：record 与双向 linkRow 同步打 deletedAt；restore 后关联恢复", async () => {
    const forwardId = forwardLinkId;
    const parent = await makeRecord(tableA);
    const child = await makeRecord(tableB);
    await prisma.linkRow.create({
      data: { linkFieldId: forwardId, parentRowId: parent, childRowId: child, ord: 0 },
    });

    // 软删父记录
    const del = await h.request("DELETE", `/records/${parent}`);
    expect(del.status).toBe(200);

    const parentRow = await prisma.record.findUnique({ where: { id: parent } });
    expect(parentRow?.deletedAt).not.toBeNull();
    // 该记录相关 linkRow（作为 parent）同步软删
    const linksAfter = await prisma.linkRow.findMany({
      where: { OR: [{ parentRowId: parent }, { childRowId: parent }] },
    });
    expect(linksAfter).toHaveLength(1);
    expect(linksAfter[0]!.deletedAt).not.toBeNull();

    // 恢复（子记录仍存活 → 关联应回填有效）
    const rest = await h.request("POST", `/records/trash/${parent}/restore`, { kind: "record" });
    expect(rest.status).toBe(200);
    const restoredRow = await prisma.record.findUnique({ where: { id: parent } });
    expect(restoredRow?.deletedAt).toBeNull();
    const linksRestored = await prisma.linkRow.findMany({
      where: { linkFieldId: forwardId, parentRowId: parent, childRowId: child },
    });
    expect(linksRestored).toHaveLength(1);
    expect(linksRestored[0]!.deletedAt).toBeNull();
  });
});

describe("RC-12 硬删 purge 无孤儿", () => {
  it("purge：物理删除 record 的 linkRow 与 comment，实体行消失，无孤儿", async () => {
    const forwardId = forwardLinkId;
    const parent = await makeRecord(tableA);
    const child = await makeRecord(tableB);
    await prisma.linkRow.create({
      data: { linkFieldId: forwardId, parentRowId: parent, childRowId: child, ord: 0 },
    });
    // 给该记录挂一条评论
    await prisma.comment.create({ data: { recordId: parent, userId: OWNER_ID, body: "note" } });

    // 先软删（purge 面向回收站记录，且路由不强制 deletedAt，但保持真实流程）
    await h.request("DELETE", `/records/${parent}`);
    expect(await prisma.linkRow.count({ where: { parentRowId: parent, deletedAt: null } })).toBe(0);
    // 软删只打标记，物理行仍在
    expect(await prisma.linkRow.count({ where: { parentRowId: parent } })).toBe(1);

    // 硬删
    const purge = await h.request("DELETE", `/records/trash/${parent}?kind=record`);
    expect(purge.status).toBe(200);

    expect(await prisma.record.findUnique({ where: { id: parent } })).toBeNull();
    // linkRow 物理清空（含软删行）
    expect(
      await prisma.linkRow.count({ where: { OR: [{ parentRowId: parent }, { childRowId: parent }] } }),
    ).toBe(0);
    // 评论物理清空，无孤儿
    expect(await prisma.comment.count({ where: { recordId: parent } })).toBe(0);
    // 对端子记录仍在
    expect(await prisma.record.findUnique({ where: { id: child } })).not.toBeNull();
  });
});
