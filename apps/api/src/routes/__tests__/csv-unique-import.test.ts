// CSV 导入唯一校验（真 app HTTP + 真迁移临时库）。
// 语义：CSV 某行的 unique 字段与存量记录（含本次导入此前各行）冲突 → 该行事务回滚、
// 记一条 409 错误、继续后续行（部分导入）；不产生重复记录。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let tableId: string;
let fieldId: string;

beforeAll(async () => {
  h = await setupHarness("gx-csv-unique-");
  const baseId = await h.makeBase();
  const t = await h.makeTable(baseId, "t");
  tableId = t.id;
  const res = await h.request("POST", `/fields?tableId=${tableId}`, {
    name: "工号",
    type: "singleLineText",
    unique: true,
  });
  expect(res.status).toBe(201);
  fieldId = (await res.json()).field.id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(async () => {
  await h.prisma.linkRow.deleteMany({});
  await h.prisma.record.deleteMany({});
});

describe("CSV 导入 unique 校验", () => {
  it("两行同 unique 值：第二行报 409、整行回滚，库里只有 1 条无重复", async () => {
    const csv = ["工号", "A001", "A001"].join("\n");
    const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
      csv,
      hasHeader: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.result.createdRecords).toBe(1);
    expect(body.result.errors.length).toBeGreaterThanOrEqual(1);
    expect(body.result.errors.join("\n")).toContain("要求唯一");

    const rows = await h.prisma.record.findMany({ where: { tableId, deletedAt: null } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.fields)[fieldId]).toBe("A001");
  });

  it("与导入前已存在的活记录冲突：该行报错、不产生重复", async () => {
    // 先直接落一条 A002（绕路由，模拟存量）
    await h.prisma.record.create({
      data: {
        tableId,
        fields: JSON.stringify({ [fieldId]: "A002" }),
        createdBy: OWNER_ID,
        updatedBy: OWNER_ID,
      },
    });
    const csv = ["工号", "A002", "A003"].join("\n");
    const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
      csv,
      hasHeader: true,
    });
    const body = await res.json();
    expect(body.result.createdRecords).toBe(1); // 只有 A003 成功
    expect(body.result.errors.length).toBeGreaterThanOrEqual(1);

    const rows = await h.prisma.record.findMany({ where: { tableId, deletedAt: null } });
    expect(rows).toHaveLength(2);
    const vals = rows.map((r) => JSON.parse(r.fields)[fieldId]).sort();
    expect(vals).toEqual(["A002", "A003"]);
  });

  it("两行不同 unique 值：全部成功、0 错误", async () => {
    const csv = ["工号", "B001", "B002"].join("\n");
    const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
      csv,
      hasHeader: true,
    });
    const body = await res.json();
    expect(body.result.createdRecords).toBe(2);
    expect(body.result.errors).toHaveLength(0);
    expect(await h.prisma.record.count({ where: { tableId, deletedAt: null } })).toBe(2);
  });
});
