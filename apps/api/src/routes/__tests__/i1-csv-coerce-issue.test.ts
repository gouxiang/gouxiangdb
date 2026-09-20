// I-1 CSV 导入非法值不再静默置空（真 app HTTP + 真迁移临时库）。
//
// 缺陷：`coerceCellValue` 对 number/currency/percent/rating/duration/autoNumber 的
// 非数字原文、对 json 的非法 JSON、对 checkbox 的非真值都是「静默降级」，
// 调用方无从知道发生过降级，结果页「问题行」恒为 0，但数据实际没导进去。
//
// 修法：`coerceCellValueWithIssue` 取值语义不变、额外返回 issue；导入入口把 issue
// 计入既有的 result.errors（沿用字符串数组格式），不中断导入——该行其余列照常落库。
//
// 短路验证方式：把 domain/csv.ts 的 `if (issue) errors.push(...)` 临时禁用后，
// 本文件里 4 条计错用例（数量/json/checkbox/部分列）应转红，
// 正向对照与空值用例仍绿。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

// 必须在任何静态 import 记录路由链之前 hoist（_realApp 内是动态 import，此 mock 仍全局生效）。
vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let prisma: PrismaClient;
let tableId: string;
let nameFieldId: string;
let numFieldId: string;
let jsonFieldId: string;
let boolFieldId: string;

beforeAll(async () => {
  h = await setupHarness("gx-i1-csv-");
  prisma = h.prisma;
  const baseId = await h.makeBase();
  const t = await h.makeTable(baseId, "t");
  tableId = t.id;
  nameFieldId = t.primaryFieldId;

  async function addField(name: string, type: string, order: number): Promise<string> {
    const res = await h.request("POST", `/fields?tableId=${tableId}`, { name, type, order });
    expect(res.status).toBe(201);
    return (await res.json()).field.id as string;
  }
  numFieldId = await addField("数量", "number", 1);
  jsonFieldId = await addField("数据", "json", 2);
  boolFieldId = await addField("完成", "checkbox", 3);
}, 120000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(async () => {
  await prisma.linkRow.deleteMany({});
  await prisma.record.deleteMany({});
  await prisma.changeEvent.deleteMany({});
});

const HEADER = "名称,数量,数据,完成";

async function importCsv(...dataRows: string[]): Promise<{
  status: number;
  createdRecords: number;
  createdFields: number;
  errors: string[];
}> {
  const res = await h.request("POST", `/records/csv-import?tableId=${tableId}`, {
    csv: [HEADER, ...dataRows].join("\n"),
    hasHeader: true,
  });
  const body = await res.json();
  return {
    status: res.status,
    createdRecords: body.result?.createdRecords ?? -1,
    createdFields: body.result?.createdFields ?? -1,
    errors: body.result?.errors ?? [],
  };
}

async function stored(rowIndex: number): Promise<Record<string, unknown>> {
  const rows = await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return JSON.parse(rows[rowIndex]!.fields) as Record<string, unknown>;
}

describe("I-1 POST /records/csv-import 非法值计入 errors 且不中断导入", () => {
  it("数量列填 abc -> 计 1 条 errors、导入仍成功、该列落库为空", async () => {
    const r = await importCsv("A,abc,[1],true");
    expect(r.status).toBe(201);
    expect(r.createdRecords).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("数量");
    expect(r.errors[0]).toContain("abc");
    expect(r.errors[0]).toContain("不是合法的数字");

    const s = await stored(0);
    expect(s[numFieldId]).toBeNull();
    expect(s[nameFieldId]).toBe("A"); // 同行其余列照常导入
  });

  it("json 列填非法 JSON -> 计 1 条 errors", async () => {
    const r = await importCsv("B,12,[1,true");
    expect(r.status).toBe(201);
    expect(r.createdRecords).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("数据");
    expect(r.errors[0]).toContain("不是合法的 JSON");
    expect((await stored(0))[jsonFieldId]).toBeNull();
    expect((await stored(0))[numFieldId]).toBe(12);
  });

  it("checkbox 列填 maybe -> 计 1 条 errors，按「否」导入", async () => {
    const r = await importCsv("C,12,[1],maybe");
    expect(r.status).toBe(201);
    expect(r.createdRecords).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("完成");
    expect(r.errors[0]).toContain("maybe");
    expect((await stored(0))[boolFieldId]).toBe(false);
  });

  it("多个非法列同行 -> 逐列各计 1 条，行仍导入成功", async () => {
    const r = await importCsv("D,xyz,[1,maybe");
    expect(r.status).toBe(201);
    expect(r.createdRecords).toBe(1);
    expect(r.errors).toHaveLength(3);
    const s = await stored(0);
    expect(s[nameFieldId]).toBe("D");
    expect(s[numFieldId]).toBeNull();
    expect(s[jsonFieldId]).toBeNull();
    expect(s[boolFieldId]).toBe(false);
  });

  it("多行：只坏行计错，好行 0 错，全部导入完成", async () => {
    const r = await importCsv("E,1,[1],true", "F,zzz,[2],false", "G,3,[3],true");
    expect(r.createdRecords).toBe(3);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("第 2 行");
    expect(r.errors[0]).toContain("数量");
    expect((await stored(1))[numFieldId]).toBeNull();
    expect((await stored(1))[nameFieldId]).toBe("F");
    expect((await stored(0))[numFieldId]).toBe(1);
    expect((await stored(2))[numFieldId]).toBe(3);
  });

  it("正向对照：合法值 0 errors（含 false / 0 / 否 / 是 / true）", async () => {
    const r = await importCsv(
      "H,12,[1],true",
      "I,-3.5,[2],false",
      "J,0,[3],是",
      "K,7,[4],否",
      "L,8,[5],0",
    );
    expect(r.createdRecords).toBe(5);
    expect(r.errors).toEqual([]);
    expect(r.createdFields).toBe(0);
    expect((await stored(0))[numFieldId]).toBe(12);
    expect((await stored(1))[numFieldId]).toBe(-3.5);
    expect((await stored(0))[boolFieldId]).toBe(true);
    expect((await stored(1))[boolFieldId]).toBe(false);
    expect((await stored(2))[boolFieldId]).toBe(true);
    expect((await stored(3))[boolFieldId]).toBe(false);
    expect((await stored(4))[boolFieldId]).toBe(false);
  });

  it("空单元格本来就是合法空值 -> 不计 issue", async () => {
    const r = await importCsv("M,,,");
    expect(r.createdRecords).toBe(1);
    expect(r.errors).toEqual([]);
  });
});
