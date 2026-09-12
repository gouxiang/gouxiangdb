// apps/api/src/domain/fieldIndex/__tests__/parity.test.ts
// M1/S4 真库对拍：临时 SQLite（经全部 12 迁移）+ 真实 Prisma 事务客户端。
// 锁：syncRecordsTx 落库行 == policy.buildExpectedRows 期望（逐行值对拍）；
// 软删撤 sidecar、恢复重建、物理删 FK 级联、GX_M1_SIDECAR=off 旁路、幂等重跑。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { buildExpectedRows, type ExpectedSidecarRow } from "../policy.js";
import { syncRecordsTx, deleteRecordsTx, restoreRecordsTx, rebuildTableTx } from "../sync.js";

let tmpDir: string;
let dbFile: string;
let raw: Database.Database;
let prisma: PrismaClient;
let tableId: string;
let fieldIds: Record<string, string>;

// 最小化建表：复用真实迁移保证 sidecar 表与索引存在。
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-sidecar-"));
  dbFile = path.join(tmpDir, "s.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  prisma = new PrismaClient();
  raw = new Database(dbFile);
});

afterAll(async () => {
  await prisma?.$disconnect();
  raw?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sidecarRows(): Array<Record<string, unknown>> {
  return raw
    .prepare(
      `SELECT "recordId", "fieldId", "valueText", "valueNum", "isNull", ord
       FROM record_field_index ORDER BY "recordId", "fieldId", ord`,
    )
    .all() as Array<Record<string, unknown>>;
}

function expectMatchesExpected(actual: Array<Record<string, unknown>>, expected: ExpectedSidecarRow[]) {
  expect(actual.length).toBe(expected.length);
  const key = (r: Record<string, unknown>) => `${r.recordId}|${r.fieldId}|${r.ord}`;
  const byKey = new Map(actual.map((r) => [key(r), r]));
  for (const e of expected) {
    const a = byKey.get(`${e.recordId}|${e.fieldId}|${e.ord}`);
    expect(a, `missing expected ${e.recordId}/${e.fieldId}/${e.ord}`).toBeTruthy();
    expect(a!.valueText ?? null).toBe(e.valueText ?? null);
    expect(a!.isNull).toBe(e.isNull);
    if (e.valueNum === null) expect(a!.valueNum).toBeNull();
    else expect(Math.abs(Number(a!.valueNum) - e.valueNum)).toBeLessThan(1e-9);
  }
}

beforeEach(async () => {
  // 每用例独立 base/table/字段
  raw.exec("DELETE FROM record_field_index");
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.base.deleteMany({});

  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "u" },
  });
  tableId = table.id;
  const mk = async (name: string, type: string, extra: Record<string, unknown> = {}) => {
    const f = await prisma.field.create({
      data: { tableId, name, type, order: 0, ...extra },
    });
    return f.id;
  };
  fieldIds = {
    name: await mk("名称", "singleLineText"),
    age: await mk("年龄", "number"),
    born: await mk("生日", "date"),
    ok: await mk("勾选", "checkbox"),
    status: await mk("状态", "singleSelect"),
    tags: await mk("标签", "multiSelect"),
    stars: await mk("评分", "rating"),
    body: await mk("正文", "longText"),
    formula: await mk("计算", "formula"),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: fieldIds.name } });
});

const opt = (id: string) => id;

async function makeRecord(fields: Record<string, unknown>): Promise<string> {
  const r = await prisma.record.create({
    data: { tableId, fields: JSON.stringify(fields), createdBy: "u", updatedBy: "u" },
  });
  return r.id;
}

async function fieldsMeta() {
  const rows = await prisma.field.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true, type: true },
  });
  const table = await prisma.table.findUniqueOrThrow({
    where: { id: tableId },
    select: { primaryFieldId: true },
  });
  return { rows, primaryFieldId: table.primaryFieldId };
}

describe("syncRecordsTx 与期望值对拍", () => {
  it("宽类型记录：sync 落库 == buildExpectedRows，非索引字段不进", async () => {
    const r1 = await makeRecord({
      [fieldIds.name]: "张三",
      [fieldIds.age]: 30,
      [fieldIds.born]: "2026-01-15",
      [fieldIds.ok]: true,
      [fieldIds.status]: opt("opt_run"),
      [fieldIds.tags]: [opt("t1"), opt("t2")],
      [fieldIds.stars]: 4,
      [fieldIds.body]: "一段长正文不应入索引",
      [fieldIds.formula]: 999,
    });
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r1]));

    const { rows, primaryFieldId } = await fieldsMeta();
    const rec = await prisma.record.findUniqueOrThrow({ where: { id: r1 } });
    const expected = buildExpectedRows({
      fieldsMeta: rows,
      primaryFieldId,
      records: [{ id: rec.id, tableId: rec.tableId, fields: rec.fields }],
    });
    const actual = sidecarRows();
    expectMatchesExpected(actual, expected);
    // name/age/born/ok/status(1行)/tags(2行)/stars = 8 行；body/formula 不入
    expect(actual.length).toBe(8);
    const byField = new Map(actual.map((a) => [`${a.fieldId}|${a.ord}`, a]));
    expect(byField.get(`${fieldIds.name}|0`)!.valueText).toBe("张三");
    expect(byField.get(`${fieldIds.age}|0`)!.valueNum).toBe(30);
    expect(byField.get(`${fieldIds.born}|0`)!.valueNum).toBe(Date.parse("2026-01-15"));
    expect(byField.get(`${fieldIds.ok}|0`)!.valueNum).toBe(1);
    expect(byField.get(`${fieldIds.status}|0`)!.valueText).toBe("opt_run");
    expect(byField.get(`${fieldIds.tags}|1`)!.valueText).toBe("t2");
    // rating 必须走 valueNum（S6 评分 gt/lt 下推依赖），valueText 留 "4" 供文本 eq 回退
    const stars = byField.get(`${fieldIds.stars}|0`)!;
    expect(stars.valueNum).toBe(4);
    expect(stars.valueText).toBe("4");
  });

  it("空值/草稿（RC-29）：未给值字段 isNull=1", async () => {
    const r = await makeRecord({ [fieldIds.name]: "" });
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
    const actual = sidecarRows();
    // 所有 7 个索引字段各 1 行（多选空数组→1 null 行），全 isNull=1
    const indexed = [fieldIds.name, fieldIds.age, fieldIds.born, fieldIds.ok, fieldIds.status, fieldIds.tags, fieldIds.stars];
    expect(actual.length).toBe(indexed.length);
    expect(actual.every((a) => a.isNull === 1)).toBe(true);
  });

  it("更新后重 sync 幂等：旧值清除不残留，行数/值与最新 fields 一致", async () => {
    const r = await makeRecord({ [fieldIds.tags]: ["a", "b", "c"], [fieldIds.age]: 10 });
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
    expect(sidecarRows().filter((a) => a.fieldId === fieldIds.tags).length).toBe(3);

    await prisma.record.update({
      where: { id: r },
      data: { fields: JSON.stringify({ [fieldIds.tags]: ["x"], [fieldIds.age]: 11 }) },
    });
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
    const tagRows = sidecarRows().filter((a) => a.fieldId === fieldIds.tags);
    expect(tagRows.length).toBe(1);
    expect(tagRows[0]!.valueText).toBe("x");
    // 重跑一次仍收敛（幂等删插）
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
    const again = sidecarRows();
    expect(again.filter((a) => a.fieldId === fieldIds.tags).length).toBe(1);
  });

  it("软删撤 sidecar（deleteRecordsTx），恢复重建（restoreRecordsTx）", async () => {
    const r = await makeRecord({ [fieldIds.name]: "李四", [fieldIds.tags]: ["a", "b"] });
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
    expect(sidecarRows().length).toBeGreaterThan(0);

    await prisma.$transaction((tx) => deleteRecordsTx(tx, [r]));
    expect(sidecarRows().length).toBe(0);

    await prisma.record.update({ where: { id: r }, data: { deletedAt: null } });
    await prisma.$transaction((tx) => restoreRecordsTx(tx, tableId, [r]));
    const restored = sidecarRows();
    expect(restored.find((a) => a.fieldId === fieldIds.name)!.valueText).toBe("李四");
    expect(restored.filter((a) => a.fieldId === fieldIds.tags).length).toBe(2);
  });

  it("物理删记录 → FK CASCADE 自动清 sidecar", async () => {
    const r = await makeRecord({ [fieldIds.name]: "王五" });
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
    expect(sidecarRows().length).toBeGreaterThan(0);
    await prisma.record.delete({ where: { id: r } });
    expect(sidecarRows().length).toBe(0);
  });

  it("rebuildTableTx 全表重建与期望一致", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await makeRecord({ [fieldIds.name]: `n${i}`, [fieldIds.age]: i }));
    }
    // 先弄脏：只 sync 一条
    await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [ids[0]!]));
    await prisma.$transaction((tx) => rebuildTableTx(tx, tableId));
    const { rows, primaryFieldId } = await fieldsMeta();
    const recs = await prisma.record.findMany({ where: { tableId, deletedAt: null } });
    const expected = buildExpectedRows({
      fieldsMeta: rows,
      primaryFieldId,
      records: recs.map((r) => ({ id: r.id, tableId: r.tableId, fields: r.fields })),
    });
    expectMatchesExpected(sidecarRows(), expected);
  });
});

describe("GX_M1_SIDECAR=off 旁路", () => {
  it("off 时 sync/delete 均不写 sidecar", async () => {
    const prev = process.env.GX_M1_SIDECAR;
    process.env.GX_M1_SIDECAR = "off";
    try {
      const r = await makeRecord({ [fieldIds.name]: "旁路" });
      // 动态重新加载开关不可行（模块缓存），直接测函数读 env：
      // resolveSidecarEnabled 在调用时读 process.env，故 syncRecordsTx 内判断即时生效。
      await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, [r]));
      expect(sidecarRows().length).toBe(0);
    } finally {
      process.env.GX_M1_SIDECAR = prev;
    }
  });
});
