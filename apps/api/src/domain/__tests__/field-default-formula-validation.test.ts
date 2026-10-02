// apps/api/src/domain/__tests__/field-default-formula-validation.test.ts
// 保存字段配置时（validateFieldConfig）的「默认内容 - 公式」卡控端到端回归。
//
// 两条口径：
//   1. 成员字段：公式结果必须是成员 ID，写姓名文本必须被拒（前端按 userId 查名册，
//      存姓名会显示成一串 id —— 脏数据）；
//   2. datetime 字段：默认内容公式不再被误报「类型不匹配」（inferAST 应收到字段
//      分组 group 而非字段类型 type；datetime 的 type ≠ group，修前会落到兜底 str）。

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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-default-formula-"));
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

async function mkField(tableId: string, name: string, type: string) {
  const count = await prisma.field.count({ where: { tableId } });
  return prisma.field.create({
    data: { tableId, name, type, order: count },
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
  tableA = a.id;
  await mkField(tableA, "负责人", "member");
  await mkField(tableA, "审核人", "member");
  await mkField(tableA, "状态", "singleSelect");
  await mkField(tableA, "姓名", "singleLineText");
  await mkField(tableA, "下单时间", "datetime");
  await mkField(tableA, "数量", "number");
});

const formulaDefault = (formula: string) => ({ mode: "formula", formula });

describe("成员字段默认内容公式 · 保存时卡控", () => {
  it("引用成员字段 → 放行", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "member",
      defaultConfig: formulaDefault("{负责人}"),
    });
    expect(err).toBeNull();
  });

  it("IF 各分支都是成员字段 → 放行", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "member",
      defaultConfig: formulaDefault('IF({状态} = "完成", {负责人}, {审核人})'),
    });
    expect(err).toBeNull();
  });

  it("IF 分支写姓名文本 → 拒绝，错误消息说明原因与正确写法", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "member",
      defaultConfig: formulaDefault('IF({状态} = "完成", "张三", "李四")'),
    });
    expect(err).not.toBeNull();
    expect(err).toContain("默认内容公式校验失败");
    expect(err).toContain("成员");
    expect(err).toContain("{负责人}");
  });

  it("引用文本字段 → 拒绝", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "member",
      defaultConfig: formulaDefault("{姓名}"),
    });
    expect(err).toContain("成员");
  });

  it("BLANK() 留空 → 放行", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "member",
      defaultConfig: formulaDefault("BLANK()"),
    });
    expect(err).toBeNull();
  });
});

describe("datetime 字段默认内容公式 · 不再误报类型不匹配", () => {
  it("引用 datetime 字段 → 放行（修前被误报）", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "datetime",
      defaultConfig: formulaDefault("{下单时间}"),
    });
    expect(err).toBeNull();
  });

  it("日期函数 → 放行", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "datetime",
      defaultConfig: formulaDefault("DATEADD({下单时间}, 3)"),
    });
    expect(err).toBeNull();
  });

  it("真正的类型错误仍然被拦（未放宽）", async () => {
    const err = await validateFieldConfig(tableA, {
      type: "datetime",
      defaultConfig: formulaDefault("{数量} + 1"),
    });
    expect(err).toContain("日期");
  });
});
