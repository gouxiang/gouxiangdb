// 缺陷 F-04 回归：查阅/聚合/计数的「关联字段（linkFieldId）」必须是本表的 links 字段。
//
// 现象：前端下拉只列 links（FieldEditorSheet.tsx linkFields），但服务端从不校验 linkFieldId，
//       于是 API 可以建出「以 subtable 为关联源」的 rollup/lookup/count —— 201 成功、无任何提示，
//       而取值链路 resolveLookup / resolveCount（hydrate.ts）显式只认 type === "links"，
//       结果 rollup 恒 null、count 恒 0，用户看到一个永远为空的列却不知道为什么。
//
// 本文件锁住服务端口径与前端口径一致：
//   - subtable / 普通标量字段作关联源 → 拒绝（返回中文原因）
//   - 本表的 links 字段 → 放行
//   - 别表的 links 字段 → 拒绝（跨表取不到值，且前端也只列本表字段）
// 同时锁定「不误伤」：links 字段自身的 linkFieldId（反向配对指针）不得被这条规则牵连。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

type Validate = typeof import("../fieldValidation.js").validateFieldConfig;

let tmpDir: string;
let prisma: PrismaClient;
let validateFieldConfig: Validate;

let tableA: string;
let tableB: string;
let linksId: string;
let subtableId: string;
let textId: string;
let numId: string;
let otherTableLinksId: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-f04-linksrc-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_M1_SIDECAR = "off";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  ({ validateFieldConfig } = await import("../fieldValidation.js"));
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mkField(tableId: string, name: string, type: string, extra: Record<string, unknown> = {}) {
  const count = await prisma.field.count({ where: { tableId } });
  return prisma.field.create({
    data: { tableId, name, type, order: count, ...extra },
    select: { id: true },
  });
}

beforeEach(async () => {
  await prisma.linkRow.deleteMany({});
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.base.deleteMany({});

  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const a = await prisma.table.create({ data: { baseId: base.id, name: "A", primaryFieldId: "", createdBy: "u" } });
  const b = await prisma.table.create({ data: { baseId: base.id, name: "B", primaryFieldId: "", createdBy: "u" } });
  const c = await prisma.table.create({ data: { baseId: base.id, name: "C", primaryFieldId: "", createdBy: "u" } });
  tableA = a.id;
  tableB = b.id;

  textId = (await mkField(tableB, "名称", "singleLineText")).id;
  numId = (await mkField(tableB, "账期", "number")).id;
  linksId = (await mkField(tableA, "客户", "links", { relatedTableId: tableB, relationKind: "mm" })).id;
  subtableId = (await mkField(tableA, "明细", "subtable", { relatedTableId: tableB, relationKind: "hm" })).id;
  otherTableLinksId = (await mkField(c.id, "别表关联", "links", { relatedTableId: tableB, relationKind: "mm" })).id;
});

describe("F-04 · rollup/lookup/count 的关联源必须是本表 links 字段", () => {
  it("subtable 作关联源：rollup 被拒绝", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "rollup",
      linkFieldId: subtableId,
      lookupFieldId: numId,
      rollupFunction: "sum",
    });
    expect(err).not.toBeNull();
    expect(err).toContain("关联");
  });

  it("subtable 作关联源：count 被拒绝（count 无取值字段）", async () => {
    const err = await validateFieldConfig(tableA, { type: "count", linkFieldId: subtableId });
    expect(err).not.toBeNull();
  });

  it("subtable 作关联源：lookup 被拒绝", async () => {
    const err = await validateFieldConfig(tableA, { type: "lookup", linkFieldId: subtableId, lookupFieldId: textId });
    expect(err).not.toBeNull();
  });

  it("普通标量字段作关联源同样被拒绝", async () => {
    const err = await validateFieldConfig(tableA, { type: "count", linkFieldId: textId });
    expect(err).not.toBeNull();
  });

  it("本表的 links 字段：三种类型全部放行", async () => {
    expect(await validateFieldConfig(tableA, { type: "rollup", linkFieldId: linksId, lookupFieldId: numId, rollupFunction: "sum" })).toBeNull();
    expect(await validateFieldConfig(tableA, { type: "lookup", linkFieldId: linksId, lookupFieldId: textId })).toBeNull();
    expect(await validateFieldConfig(tableA, { type: "count", linkFieldId: linksId })).toBeNull();
  });

  it("别表的 links 字段被拒绝（前端只列本表字段）", async () => {
    const err = await validateFieldConfig(tableA, { type: "count", linkFieldId: otherTableLinksId });
    expect(err).not.toBeNull();
    expect(err).toContain("当前数据表");
  });

  it("关联字段不存在时给出明确原因", async () => {
    const err = await validateFieldConfig(tableA, { type: "count", linkFieldId: "fld_not_exist" });
    expect(err).toContain("不存在");
  });

  it("不误伤：links 字段自身的 linkFieldId（反向配对指针）不受此规则约束", async () => {
    // links 字段的 linkFieldId 指向反向字段，语义不同；校验不得因此报错
    expect(await validateFieldConfig(tableA, { type: "links", linkFieldId: otherTableLinksId, relatedTableId: tableB })).toBeNull();
  });

  it("不误伤：未指定关联源时不拦截（前端允许先建后配）", async () => {
    expect(await validateFieldConfig(tableA, { type: "count", linkFieldId: null })).toBeNull();
  });
});
