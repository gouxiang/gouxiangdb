// M1/S5 写后单行 hydration 对拍（真迁移临时库 + 真 Prisma）：
// 新 hydrateRecordById(tableId,id)（POST/PATCH/详情用它替代旧 queryRecords(noPaging) 全表回查）
// 返回的那一条，必须与旧路径 queryRecords(noPaging).records.find(id) 逐值 deep-equal，
// 覆盖 links(bt 正/hm 反) + lookup + rollup + count + 物理/链式/点引用公式 + 系统字段。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let tableId: string;
const ids: Record<string, string> = {};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-single-"));
  dbFile = path.join(tmpDir, "s.db");
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

beforeAll(async () => {
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u1" } });
  const deptTable = await prisma.table.create({
    data: { baseId: base.id, name: "dept", primaryFieldId: "", createdBy: "u1" },
  });
  const empTable = await prisma.table.create({
    data: { baseId: base.id, name: "emp", primaryFieldId: "", createdBy: "u1" },
  });
  tableId = empTable.id;

  const dName = await prisma.field.create({ data: { tableId: deptTable.id, name: "部门名", type: "singleLineText", order: 0 } });
  const dBudget = await prisma.field.create({ data: { tableId: deptTable.id, name: "预算", type: "number", order: 1 } });
  ids.dName = dName.id;
  ids.dBudget = dBudget.id;

  const eName = await prisma.field.create({ data: { tableId, name: "姓名", type: "singleLineText", order: 0 } });
  const eSal = await prisma.field.create({ data: { tableId, name: "薪资", type: "number", order: 1 } });
  const eDept = await prisma.field.create({
    data: { tableId, name: "部门", type: "links", order: 2, relatedTableId: deptTable.id, relationKind: "bt", linkDisplayFieldId: dName.id },
  });
  const eMgr = await prisma.field.create({
    data: { tableId, name: "下属", type: "links", order: 3, relatedTableId: tableId, relationKind: "hm", linkDisplayFieldId: eName.id },
  });
  const eReports = await prisma.field.create({
    data: { tableId, name: "上级", type: "links", order: 4, relatedTableId: tableId, relationKind: "hm", isReverse: true,
            reverseFieldId: eMgr.id, linkFieldId: eMgr.id, linkDisplayFieldId: eName.id },
  });
  const eDeptName = await prisma.field.create({
    data: { tableId, name: "部门名", type: "lookup", order: 5, linkFieldId: eDept.id, lookupFieldId: dName.id },
  });
  const eSum = await prisma.field.create({
    data: { tableId, name: "预算和", type: "rollup", order: 6, linkFieldId: eDept.id, lookupFieldId: dBudget.id, rollupFunction: "sum" },
  });
  const eCount = await prisma.field.create({
    data: { tableId, name: "部门数", type: "count", order: 7, linkFieldId: eDept.id },
  });
  const eT = await prisma.field.create({ data: { tableId, name: "合成", type: "formula", order: 8, formula: "CONCAT({姓名}, ':', {薪资})" } });
  const eT2 = await prisma.field.create({ data: { tableId, name: "合成链", type: "formula", order: 9, formula: "CONCAT({合成}, '!')" } });
  const eDot = await prisma.field.create({ data: { tableId, name: "预算点", type: "formula", order: 10, formula: "{部门.预算}" } });
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: eName.id } });

  Object.assign(ids, {
    eName: eName.id, eSal: eSal.id, eDept: eDept.id, eMgr: eMgr.id, eReports: eReports.id,
    eDeptName: eDeptName.id, eSum: eSum.id, eCount: eCount.id, eT: eT.id, eT2: eT2.id, eDot: eDot.id,
    deptTable: deptTable.id,
  });

  const dept1 = await prisma.record.create({
    data: { tableId: deptTable.id, fields: JSON.stringify({ [dName.id]: "研发部", [dBudget.id]: 1000 }), createdBy: "u1", updatedBy: "u1" },
  });
  const dept2 = await prisma.record.create({
    data: { tableId: deptTable.id, fields: JSON.stringify({ [dName.id]: "市场部", [dBudget.id]: 500 }), createdBy: "u1", updatedBy: "u1" },
  });
  const emp1 = await prisma.record.create({
    data: { tableId, fields: JSON.stringify({ [eName.id]: "张三", [eSal.id]: 200 }), createdBy: "u1", updatedBy: "u1" },
  });
  const emp2 = await prisma.record.create({
    data: { tableId, fields: JSON.stringify({ [eName.id]: "李四", [eSal.id]: 300 }), createdBy: "u1", updatedBy: "u1" },
  });
  ids.emp1 = emp1.id;
  ids.emp2 = emp2.id;
  ids.dept1 = dept1.id;
  ids.dept2 = dept2.id;

  await prisma.linkRow.create({ data: { linkFieldId: eDept.id, parentRowId: emp1.id, childRowId: dept1.id, ord: 0 } });
  await prisma.linkRow.create({ data: { linkFieldId: eDept.id, parentRowId: emp2.id, childRowId: dept1.id, ord: 0 } });
  await prisma.linkRow.create({ data: { linkFieldId: eMgr.id, parentRowId: emp1.id, childRowId: emp2.id, ord: 0 } });
}, 120000);

describe("hydrateRecordById vs queryRecords(noPaging).find 逐值一致", () => {
  it("两条员工记录：单行 hydration 与旧全表回查的那一条 deep-equal", async () => {
    const { hydrateRecordById, loadTableFields, queryRecords, parseViewConfig } = await import("../recordService.js");
    const fields = await loadTableFields(tableId);
    const full = await queryRecords({ tableId, fields, config: parseViewConfig(null), noPaging: true });

    for (const empId of [ids.emp1, ids.emp2]) {
      const single = await hydrateRecordById(tableId, empId);
      const old = full.records.find((r) => r.id === empId)!;
      expect(single).not.toBeNull();
      // 完整记录逐值 deep-equal（七键 + 全部计算字段）
      expect(single).toEqual(old);
      expect(single!.fields).toEqual(old.fields);
    }

    // 抽检单行关键值，确认 links/lookup/rollup/count/公式/点引用全算出
    const s1 = (await hydrateRecordById(tableId, ids.emp1))!.fields;
    expect(s1[ids.eName]).toBe("张三");
    expect(s1[ids.eDeptName]).toEqual(["研发部"]);
    expect(s1[ids.eSum]).toBe(1000);
    expect(s1[ids.eCount]).toBe(1);
    expect(s1[ids.eT]).toBe("张三:200");
    expect(s1[ids.eT2]).toBe("张三:200!");
    expect(s1[ids.eDot]).toBe(1000);
    expect(s1[ids.eMgr]).toEqual([{ tableId, recordId: ids.emp2, title: "李四" }]);
    // 反向：李四的上级是张三
    const s2 = (await hydrateRecordById(tableId, ids.emp2))!.fields;
    expect(s2[ids.eReports]).toEqual([{ tableId, recordId: ids.emp1, title: "张三" }]);
  });

  it("软删/不存在/跨表 id 返回 null（旧 .find 也取不到）", async () => {
    const { hydrateRecordById } = await import("../recordService.js");
    expect(await hydrateRecordById(tableId, "nonexistent-id")).toBeNull();
    // 属于 dept 表的记录用 emp tableId 取 → null（表不符）
    expect(await hydrateRecordById(tableId, ids.dept1)).toBeNull();
  });
});
