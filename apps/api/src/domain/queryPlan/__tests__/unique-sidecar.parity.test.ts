// M1/S6 assertUnique 走 sidecar 等值通道真库对拍（真迁移临时库 + 真交互事务 + sync 写 sidecar）：
//  GX_M1_SIDECAR_READ=on（sidecar 索引）与 =off（S5 全表严格校验）在同一数据上，对
//  文本/邮箱/单选/日期唯一约束的【冲突判定与 409 文案】逐格一致；并锁：
//   - 严格相等（数字 123 vs 字符串 "123" 不冲突）——数值/checkbox 类型 S6 回退全表，仍严格；
//   - 空值跳过；exclude 自身/批内；软删行不冲突；
//   - shadow 也回退全表（unique 下推仅在 on）。
// 任何牵 db.js 的模块在设置 globalThis.__gx_prisma 后动态 import。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let tableId: string;
let mod: {
  assertUnique: typeof import("../../../routes/records.js")["assertUnique"];
  syncRecordsTx: typeof import("../../fieldIndex/sync.js")["syncRecordsTx"];
  loadTableFields: typeof import("../../recordService.js")["loadTableFields"];
};
let F: Record<string, string>;
let recIds: Record<string, string>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-uniq-"));
  dbFile = path.join(tmpDir, "u.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  delete process.env.GX_M1_SIDECAR_READ;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [rec, sync, fieldsMod] = await Promise.all([
    import("../../../routes/records.js"),
    import("../../fieldIndex/sync.js"),
    import("../../recordService.js"),
  ]);
  mod = {
    assertUnique: rec.assertUnique,
    syncRecordsTx: sync.syncRecordsTx,
    loadTableFields: fieldsMod.loadTableFields,
  };
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.base.deleteMany({});
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "u" },
  });
  tableId = table.id;
  const mk = async (name: string, type: string, order: number, unique: boolean) =>
    (await prisma.field.create({ data: { tableId, name, type, order, unique } })).id;
  F = {
    code: await mk("编码", "singleLineText", 0, true),
    mail: await mk("邮箱", "email", 1, true),
    status: await mk("状态", "singleSelect", 2, true),
    born: await mk("生日", "date", 3, true),
    age: await mk("年龄", "number", 4, true),
    ok: await mk("勾选", "checkbox", 5, true),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: F.code } });

  const mkRec = async (o: Record<string, unknown>) => {
    const r = await prisma.record.create({ data: { tableId, fields: JSON.stringify(o), createdBy: "u", updatedBy: "u" } });
    return r.id;
  };
  recIds = {
    dup: await mkRec({ [F.code]: "A-1", [F.mail]: "a@x.io", [F.status]: "o1", [F.born]: "2026-03-01", [F.age]: 123, [F.ok]: true }),
    other: await mkRec({ [F.code]: "B-2", [F.mail]: "b@x.io", [F.status]: "o2", [F.born]: "2026-04-01", [F.age]: 456, [F.ok]: false }),
    numstr: await mkRec({ [F.age]: "123" }), // 数字列存字符串（脏数据）
  };
  await prisma.$transaction((tx) =>
    mod.syncRecordsTx(tx, tableId, [recIds.dup, recIds.other, recIds.numstr]),
  );
});

/** 在给定读 flag 下跑一次 assertUnique，返回 "conflict:<字段名>" | "ok"。 */
async function outcome(readFlag: "on" | "off", values: Record<string, unknown>, exclude?: string[]): Promise<string> {
  process.env.GX_M1_SIDECAR_READ = readFlag;
  try {
    const fields = await mod.loadTableFields(tableId);
    await prisma.$transaction((tx) =>
      mod.assertUnique(tableId, fields, values, undefined, exclude, tx),
    );
    return "ok";
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (err.status === 409) {
      const m = /字段「(.+?)」要求唯一/.exec(err.message ?? "");
      return `conflict:${m?.[1] ?? "?"}`;
    }
    throw e;
  } finally {
    delete process.env.GX_M1_SIDECAR_READ;
  }
}

describe("assertUnique sidecar(on) vs 全表(off) 逐格一致", () => {
  // F/recIds 在 beforeEach 才就绪，用例数据延迟到 it 运行时构造。
  function buildCases(): Array<[string, Record<string, unknown>, string[] | undefined]> {
    return [
      ["文本重复", { [F.code]: "A-1" }, undefined],
      ["文本不同", { [F.code]: "C-3" }, undefined],
      ["邮箱重复(大小写敏感)", { [F.mail]: "a@x.io" }, undefined],
      ["邮箱大小写不同不冲突", { [F.mail]: "A@X.io" }, undefined],
      ["单选 optionId 重复", { [F.status]: "o1" }, undefined],
      ["单选不同 optionId", { [F.status]: "o9" }, undefined],
      ["日期严格串重复", { [F.born]: "2026-03-01" }, undefined],
      ["空字符串跳过", { [F.code]: "" }, undefined],
      ["null 跳过", { [F.code]: null }, undefined],
      ["数字重复(number 回退全表仍严格)", { [F.age]: 456 }, undefined],
      ["数字 123 vs 库存字符串 '123' 不冲突(严格)", { [F.age]: 123 }, undefined],
      ["checkbox true 冲突(回退全表)", { [F.ok]: true }, undefined],
      ["exclude 自身后同值放行", { [F.code]: "A-1" }, [recIds.dup]],
      ["批外仍冲突(只排除 other)", { [F.code]: "A-1" }, [recIds.other]],
    ];
  }

  it("14 个矩阵格 on 与 off 判定一致（冲突字段/放行）", async () => {
    for (const [name, values, exclude] of buildCases()) {
      const on = await outcome("on", values, exclude);
      const off = await outcome("off", values, exclude);
      expect(on, `${name}: on=${on} off=${off}`).toBe(off);
    }
  });

  it("shadow 也走全表（与 off 一致），unique 下推仅在 on", async () => {
    process.env.GX_M1_SIDECAR_READ = "shadow";
    try {
      const fields = await mod.loadTableFields(tableId);
      await expect(
        prisma.$transaction((tx) => mod.assertUnique(tableId, fields, { [F.code]: "A-1" }, undefined, undefined, tx)),
      ).rejects.toMatchObject({ status: 409, message: "字段「编码」要求唯一，该值已存在" });
    } finally {
      delete process.env.GX_M1_SIDECAR_READ;
    }
  });

  it("409 文案逐字一致（字段名 + 固定中文）", async () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    try {
      const fields = await mod.loadTableFields(tableId);
      await expect(
        prisma.$transaction((tx) => mod.assertUnique(tableId, fields, { [F.status]: "o2" }, undefined, undefined, tx)),
      ).rejects.toMatchObject({ status: 409, message: "字段「状态」要求唯一，该值已存在" });
    } finally {
      delete process.env.GX_M1_SIDECAR_READ;
    }
  });

  it("软删行不参与冲突（on/off 一致放行）", async () => {
    // 软删 dup，再尝试同值
    await prisma.record.update({ where: { id: recIds.dup }, data: { deletedAt: new Date() } });
    // sidecar 行仍在（软删不撤，恢复复用），但 join records deletedAt IS NULL 排除
    expect(await outcome("on", { [F.code]: "A-1" })).toBe("ok");
    expect(await outcome("off", { [F.code]: "A-1" })).toBe("ok");
  });

  it("写侧 GX_M1_SIDECAR=off 时即便读=on 也回退全表（仍正确判冲突）", async () => {
    const prev = process.env.GX_M1_SIDECAR;
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_SIDECAR = "off";
    try {
      const fields = await mod.loadTableFields(tableId);
      await expect(
        prisma.$transaction((tx) => mod.assertUnique(tableId, fields, { [F.code]: "A-1" }, undefined, undefined, tx)),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      process.env.GX_M1_SIDECAR = prev;
      delete process.env.GX_M1_SIDECAR_READ;
    }
  });
});
