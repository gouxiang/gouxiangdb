// M1/S5 CSV 分批导出对拍（真迁移临时库 + 真 Prisma + S2 只读 raw 网关）：
//  - 1201 行（跨 3 个 keyset 批，每批 500）导出结果与「旧全表 queryRecords(noPaging) + recordsToCSV」
//    逐字节相等（只改取数编排，输出一个字节都不变）；
//  - rowCount/batches 证据；默认 (createdAt,id) 顺序；BOM 与表头；
//  - RC-04 公式注入防护在拼串层保持（= 开头被前导单引号）；
//  - 视图 sorts 后处理路径：分批 hydrate 后统一排序，与 applyViewQuery 口径一致。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { createRawReader } from "../../db/rawRead.js";


let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let tableId: string;
let fName: string;
let fNum: string;
let N: number;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-csv-"));
  dbFile = path.join(tmpDir, "c.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seed(rows: number): Promise<void> {
  N = rows;
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "csv-t", primaryFieldId: "", createdBy: "u" },
  });
  tableId = table.id;
  const n = await prisma.field.create({ data: { tableId, name: "名称", type: "singleLineText", order: 0 } });
  const q = await prisma.field.create({ data: { tableId, name: "数量", type: "number", order: 1 } });
  fName = n.id;
  fNum = q.id;
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: fName } });

  const data = [];
  for (let i = 0; i < rows; i++) {
    // 第一条放公式注入诱饵；其余正常；createdAt 显式递增保证确定顺序
    const name = i === 0 ? "=1+1" : `行${i}`;
    data.push({
      tableId,
      fields: JSON.stringify({ [fName]: name, [fNum]: i }),
      createdBy: "u",
      updatedBy: "u",
      createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i),
      updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i),
    });
  }
  await prisma.record.createMany({ data });
}

describe("CSV keyset 分批导出 vs 旧全表导出（逐字节一致）", () => {
  beforeAll(async () => {
    await seed(1201);
  });

  it("分批导出与 queryRecords(noPaging)+recordsToCSV 逐字节相等，跨 3 批", async () => {
    const { exportTableCsv } = await import("../csvExport.js");
    const { loadTableFields, queryRecords, parseViewConfig } = await import("../recordService.js");
    const { recordsToCSV } = await import("../csv.js");

    const reader = createRawReader(new Database(dbFile, { readonly: true }));
    const fields = await loadTableFields(tableId);

    // 旧实现：全表 queryRecords + recordsToCSV
    const old = await queryRecords({ tableId, fields, config: parseViewConfig(null), noPaging: true });
    const oldCsv = recordsToCSV(old.records, fields);

    // 新实现：keyset 分批
    const res = await exportTableCsv(tableId, null, undefined, reader);

    expect(res.rowCount).toBe(N);
    expect(res.batches).toBe(3); // 500 + 500 + 201
    expect(res.csv).toBe(oldCsv); // 逐字节相等

    // 表头带 BOM、列名正确
    expect(res.csv.startsWith("\uFEFF名称,数量\r\n")).toBe(true);
    // RC-04：公式诱饵单元格被前导单引号中和
    expect(res.csv).toContain("'=1+1");
    // 不含裸的危险开头（被引号包裹的安全文本除外）
    expect(/(^|\r\n)=1\+1/.test(res.csv)).toBe(false);
    // 顺序：默认 createdAt 升序（行0 在前）
    const firstDataLine = res.csv.split("\r\n")[1]!;
    expect(firstDataLine).toBe("'=1+1,0");
  });

  it("视图 sorts 后处理路径：分批 hydrate 后统一排序，结果等于全表 applyViewQuery", async () => {
    const { exportTableCsv } = await import("../csvExport.js");
    const { loadTableFields, applyViewQuery, parseViewConfig } = await import("../recordService.js");
    const { hydrateRecords } = await import("../hydrate.js");
    const { prismaDeps } = await import("../prismaDeps.js");
    const { recordsToCSV } = await import("../csv.js");

    const reader = createRawReader(new Database(dbFile, { readonly: true }));
    const fields = await loadTableFields(tableId);
    // 数量降序
    const config = { ...parseViewConfig(null), sorts: [{ fieldId: fNum, direction: "desc" as const }] };

    // 期望：全表 hydrate → applyViewQuery → recordsToCSV
    const rows = await prisma.record.findMany({
      where: { tableId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const { toRawRecord } = await import("../prismaDeps.js");
    const hydrated = await hydrateRecords(rows.map(toRawRecord), fields, prismaDeps);
    const sorted = await applyViewQuery(hydrated, fields, config, "");
    const expectedCsv = recordsToCSV(sorted, fields);

    const res = await exportTableCsv(tableId, JSON.stringify(config), undefined, reader);
    expect(res.rowCount).toBe(N);
    expect(res.csv).toBe(expectedCsv);
    // 降序首行数量 = N-1
    expect(res.csv.split("\r\n")[1]).toBe(`行${N - 1},${N - 1}`);
  });
});
