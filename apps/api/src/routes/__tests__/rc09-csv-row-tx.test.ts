// RC-09 CSV 导入行级事务（真 app HTTP + 真迁移临时库）。
// 语义是【部分导入】：单行在其 withWriteTx("record.csvImportRow") 内失败（record.create +
// applyFieldWrites + outbox 任一失败）→ 整行回滚（不留 fields 为空的裸记录），catch 记 error 后
// 继续后续好行；接口仍 201，返回 {result:{createdFields,createdRecords,errors}}。
//
// 触发：预置一个 maxLength=3 的单行文本列，三行中第二行超长，applyFieldWrites 在 record.create
// 之后抛 400，最能证明「已建裸记录被回滚」而非「建前校验拦截」。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

// 必须在任何静态 import 记录路由链之前 hoist（_realApp 内是动态 import，此 mock 仍全局生效）。
vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let prisma: PrismaClient;
let tableId: string;
let fieldId: string;

beforeAll(async () => {
  h = await setupHarness("gx-rc09-csv-");
  prisma = h.prisma;
  const baseId = await h.makeBase();
  const t = await h.makeTable(baseId, "t");
  tableId = t.id;
  // 预置 maxLength=3 的「编码」文本列（替换默认主字段），用于制造单行写入失败。
  fieldId = (await prisma.field.create({
    data: { tableId, name: "编码", type: "singleLineText", order: 1, maxLength: 3 },
  })).id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(async () => {
  // 每例只清数据行，保留 base/member/table/field（同一列结构贯穿两例）。
  await prisma.linkRow.deleteMany({});
  await prisma.record.deleteMany({});
  await prisma.changeEvent.deleteMany({});
});

describe("RC-09 POST /records/csv-import 行级事务 + 部分导入", () => {
  it("坏行回滚不留裸记录、好行照常创建，createdRecords/errors 计数准确", async () => {
    // 第 2 行 "ABCDEFG" 长度 7 > maxLength 3 → applyFieldWrites 在 record.create 后抛错整行回滚
    const csv = ["编码", "AB", "ABCDEFG", "C"].join("\n");

    const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
      csv,
      hasHeader: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.result.createdFields).toBe(0); // 列名命中已有字段，不新建
    expect(body.result.createdRecords).toBe(2); // 第 1、3 行成功
    expect(body.result.errors).toHaveLength(1); // 坏行记一条错误

    // 坏行没有留下 fields 为空的裸记录：总数恰好 2，且每条都真实写入了字段值
    const rows = await prisma.record.findMany({
      where: { tableId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const stored = rows.map((r) => JSON.parse(r.fields)[fieldId]);
    expect(stored.sort()).toEqual(["AB", "C"]);
    for (const r of rows) {
      expect(Object.keys(JSON.parse(r.fields)).length).toBeGreaterThan(0);
    }
  });

  it("全部合法时 0 错误、全部建；空 CSV 仍 400", async () => {
    const ok = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
      csv: ["编码", "X", "YZ"].join("\n"),
      hasHeader: true,
    });
    expect(ok.status).toBe(201);
    const ob = await ok.json();
    expect(ob.result.createdRecords).toBe(2);
    expect(ob.result.errors).toHaveLength(0);
    expect(await prisma.record.count({ where: { tableId } })).toBe(2);

    const empty = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
      csv: "",
      hasHeader: true,
    });
    expect(empty.status).toBe(400);
  });
});
