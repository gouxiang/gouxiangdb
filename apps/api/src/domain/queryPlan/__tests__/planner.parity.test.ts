// M1/S6 读计划器端到端对拍（真迁移临时库 + 真 Prisma + sync 写 sidecar）：
//  mod.runQueryPlan(on 计划器) 的 QueryResult 与 mod.queryRecordsLegacy(S5 旧路径) 逐值 deep-equal，
//  覆盖：物理快速档（数值过滤+数值排序+物理聚合）、分页、宽口径（notContains/搜索/分组/计算字段过滤）。
//  另验 flag 分派：默认 off 走旧路径；on 走计划器（结果一致）；GX_M1_SIDECAR=off 强制回退。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import type { ViewConfig } from "@gx/shared-types";
import { createSidecarQuerier } from "../sidecarQuery.js";

// 注意：任何牵出 db.js（prisma 单例）的模块都必须在设置 globalThis.__gx_prisma 之后
// 动态 import，否则 db.js 会在测试库 DATABASE_URL/单例就绪前自带一个连默认库的 client。
type FieldMetaList = Awaited<ReturnType<typeof import("../../recordService.js")["loadTableFields"]>>;
const N = 160;
let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let tableId: string;
let fields: FieldMetaList;
let F: Record<string, string>;

let mod: {
  runQueryPlan: typeof import("../planner.js")["runQueryPlan"];
  syncRecordsTx: typeof import("../../fieldIndex/sync.js")["syncRecordsTx"];
  queryRecords: typeof import("../../recordService.js")["queryRecords"];
  queryRecordsLegacy: typeof import("../../recordService.js")["queryRecordsLegacy"];
  parseViewConfig: typeof import("../../recordService.js")["parseViewConfig"];
  loadTableFields: typeof import("../../recordService.js")["loadTableFields"];
};

const baseConfig = (): ViewConfig => mod.parseViewConfig(null);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-plan-"));
  dbFile = path.join(tmpDir, "p.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  delete process.env.GX_M1_SIDECAR_READ;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  // 此刻才加载牵 db.js 的模块，确保 prisma 单例就是本测试库 client。
  const [planner, sync, rec] = await Promise.all([
    import("../planner.js"),
    import("../../fieldIndex/sync.js"),
    import("../../recordService.js"),
  ]);
  mod = {
    runQueryPlan: planner.runQueryPlan,
    syncRecordsTx: sync.syncRecordsTx,
    queryRecords: rec.queryRecords,
    queryRecordsLegacy: rec.queryRecordsLegacy,
    parseViewConfig: rec.parseViewConfig,
    loadTableFields: rec.loadTableFields,
  };
}, 120000);

afterAll(async () => {
  raw?.close();
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  raw?.close();
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.base.deleteMany({});
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "u" },
  });
  tableId = table.id;
  const mk = async (name: string, type: string, order: number) =>
    (await prisma.field.create({ data: { tableId, name, type, order } })).id;
  F = {
    name: await mk("名称", "singleLineText", 0),
    email: await mk("邮箱", "email", 1),
    age: await mk("年龄", "number", 2),
    stars: await mk("评分", "rating", 3),
    born: await mk("生日", "date", 4),
    ok: await mk("勾选", "checkbox", 5),
    status: await mk("状态", "singleSelect", 6),
    calc: await mk("公式", "formula", 7),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: F.name } });

  const data = [];
  const pad = (i: number) => String((i % 28) + 1).padStart(2, "0");
  const baseMs = Date.parse("2026-02-01T00:00:00.000Z");
  for (let i = 0; i < N; i++) {
    const o: Record<string, unknown> = { [F.name]: `记录${i}` };
    if (i % 2 === 0) o[F.email] = `u${i}@example.com`;
    if (i % 4 !== 0) o[F.age] = i;
    if (i % 5 !== 0) o[F.stars] = i % 6;
    if (i % 5 !== 0) o[F.born] = `2026-02-${pad(i)}`;
    if (i % 3 === 0) o[F.ok] = true;
    else if (i % 3 === 1) o[F.ok] = false;
    const sm = i % 6;
    if (sm >= 1 && sm <= 3) o[F.status] = `o${sm}`;
    data.push({
      tableId, fields: JSON.stringify(o), createdBy: "u", updatedBy: "u",
      createdAt: new Date(baseMs + i), updatedAt: new Date(baseMs + i),
    });
  }
  await prisma.record.createMany({ data });
  const ids = (await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  })).map((r) => r.id);
  await prisma.$transaction((tx) => mod.syncRecordsTx(tx, tableId, ids));

  fields = await mod.loadTableFields(tableId);
  raw = new Database(dbFile, { readonly: true });
});

/** 计划器（注入临时库 querier）vs S5 旧路径，逐字段对拍 QueryResult。 */
async function expectParity(config: ViewConfig, opts: { limit?: number; offset?: number; search?: string; noPaging?: boolean } = {}) {
  const q = createSidecarQuerier(raw);
  const common = {
    tableId, fields, config,
    limit: opts.limit ?? 200, offset: opts.offset ?? 0, noPaging: opts.noPaging ?? false,
    search: opts.search ?? "",
  };
  const planned = await mod.runQueryPlan(q, common);
  const legacy = await mod.queryRecordsLegacy(common);

  expect(planned.total, "total").toBe(legacy.total);
  expect(planned.filteredTotal, "filteredTotal").toBe(legacy.filteredTotal);
  expect(planned.records.map((r) => r.id), "recordId 序列").toEqual(legacy.records.map((r) => r.id));
  // 逐记录 fields deep-equal
  const lby = new Map(legacy.records.map((r) => [r.id, r]));
  for (const r of planned.records) {
    expect(r.fields, `fields ${r.id}`).toEqual(lby.get(r.id)!.fields);
  }
  // 表尾聚合
  if (legacy.aggregations) {
    expect(planned.aggregations, "aggregations keys").not.toBeNull();
    for (const [fid, v] of Object.entries(legacy.aggregations)) {
      const pv = planned.aggregations![fid];
      if (v === null) expect(pv, `agg ${fid}`).toBeNull();
      else expect(pv, `agg ${fid}`).toBeCloseTo(v, 6);
    }
  }
  // 分组：逐桶 key/成员/label/color 对拍
  if (legacy.groups) {
    expect(planned.groups, "groups").not.toBeNull();
    expect(planned.groups!.map((g) => g.key), "group keys/order").toEqual(legacy.groups.map((g) => g.key));
    const pg = new Map(planned.groups!.map((g) => [g.key, g]));
    for (const g of legacy.groups) {
      const p = pg.get(g.key)!;
      expect(p.label, `group ${g.key} label`).toBe(g.label);
      expect(p.color, `group ${g.key} color`).toBe(g.color);
      expect(p.recordIds, `group ${g.key} recordIds`).toEqual(g.recordIds);
    }
  }
  return { planned, legacy };
}

describe("mod.runQueryPlan(计划器) vs mod.queryRecordsLegacy(S5) 逐值对拍", () => {
  it("物理快速档：数值过滤 + 数值排序 + 物理聚合（mode=physical）", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "and", children: [
        { kind: "condition", fieldId: F.age, op: "gte", value: "20" },
      ] } as ViewConfig["filters"],
      sorts: [{ fieldId: F.age, direction: "desc" }],
      aggregations: { [F.age]: "sum", [F.stars]: "avg" },
    };
    const { planned } = await expectParity(config);
    expect(planned.mode).toBe("physical");
    expect(planned.groups).toBeNull();
  });

  it("物理快速档 + offset/limit 分页：当页序列与旧路径一致", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      sorts: [{ fieldId: F.stars, direction: "asc" }],
    };
    const { planned } = await expectParity(config, { limit: 25, offset: 30 });
    expect(planned.mode).toBe("physical");
    expect(planned.records).toHaveLength(25);
  });

  it("同字段数值 range(gte+lte)：rfi JOIN 计数与旧路径 filteredTotal/当页逐值一致", async () => {
    // S10：range 计数走 compileCount 的 rfi JOIN 快速路径，必须与内存口径完全相等。
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "and", children: [
        { kind: "condition", fieldId: F.age, op: "gte", value: "18" },
        { kind: "condition", fieldId: F.age, op: "lte", value: "60" },
      ] } as ViewConfig["filters"],
    };
    const { planned, legacy } = await expectParity(config, { limit: 30, offset: 0 });
    expect(planned.mode).toBe("physical");
    expect(planned.filteredTotal, "filteredTotal").toBe(legacy.filteredTotal);
  });

  it("同字段数值 OR（>90 或 <10）：rfi JOIN 计数与旧路径一致", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "or", children: [
        { kind: "condition", fieldId: F.age, op: "gt", value: "90" },
        { kind: "condition", fieldId: F.age, op: "lt", value: "10" },
      ] } as ViewConfig["filters"],
    };
    const { planned, legacy } = await expectParity(config);
    expect(planned.mode).toBe("physical");
    expect(planned.filteredTotal, "filteredTotal").toBe(legacy.filteredTotal);
  });

  it("无过滤无排序默认 createdAt,id 升序：物理档全量当页", async () => {
    const { planned } = await expectParity(baseConfig(), { limit: 50, offset: 0 });
    expect(planned.mode).toBe("physical");
  });

  it("宽口径：notContains 残余过滤 → 内存精修后一致", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.email, op: "notContains", value: "example" } as ViewConfig["filters"],
    };
    const { planned } = await expectParity(config);
    expect(planned.mode).toBe("wide");
  });

  it("宽口径：跨字段搜索 → 一致", async () => {
    const { planned } = await expectParity(configWithSearch(), { search: "记录1" });
    expect(planned.mode).toBe("wide");
  });

  it("宽口径：singleSelect 分组（选项顺序/颜色/空白桶最后）逐桶一致", async () => {
    const config: ViewConfig = { ...baseConfig(), groupByFieldId: F.status };
    const { planned } = await expectParity(config);
    expect(planned.mode).toBe("wide");
  });

  it("宽口径：checkbox 分组 + 物理 age 过滤", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      groupByFieldId: F.ok,
      filters: { kind: "condition", fieldId: F.age, op: "gt", value: "10" } as ViewConfig["filters"],
    };
    const { planned } = await expectParity(config);
    expect(planned.mode).toBe("wide");
  });

  it("宽口径：计算字段(formula)过滤残余 → 一致（formula 无值时旧路径口径）", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.calc, op: "gt", value: "1" } as ViewConfig["filters"],
    };
    const { planned } = await expectParity(config);
    expect(planned.mode).toBe("wide");
  });

  it("宽口径 + 分页：宽候选精修后 slice 与旧路径一致", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      groupByFieldId: F.status,
      sorts: [{ fieldId: F.name, direction: "asc" }], // 文本排序→内存
    };
    const { planned } = await expectParity(config, { limit: 20, offset: 5 });
    expect(planned.mode).toBe("wide");
  });
});

function configWithSearch(): ViewConfig {
  return baseConfig();
}

describe("GX_M1_SIDECAR_READ flag 分派", () => {
  it("默认（未设置）走旧路径；=on 走计划器且结果与旧路径一致", async () => {
    delete process.env.GX_M1_SIDECAR_READ;
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.age, op: "gte", value: "20" } as ViewConfig["filters"],
      sorts: [{ fieldId: F.age, direction: "desc" }],
    };
    const opts = { tableId, fields, config, limit: 200, offset: 0, noPaging: false, search: "" };
    const off = await mod.queryRecords(opts);
    expect(off.filteredTotal).toBe((await mod.queryRecordsLegacy(opts)).filteredTotal);

    process.env.GX_M1_SIDECAR_READ = "on";
    try {
      const on = await mod.queryRecords(opts);
      expect(on.total).toBe(off.total);
      expect(on.filteredTotal).toBe(off.filteredTotal);
      expect(on.records.map((r) => r.id)).toEqual(off.records.map((r) => r.id));
    } finally {
      delete process.env.GX_M1_SIDECAR_READ;
    }
  });

  it("shadow：返回旧路径结果（计划器双跑不影响响应），与 legacy 一致", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.age, op: "gt", value: "10" } as ViewConfig["filters"],
      sorts: [{ fieldId: F.stars, direction: "asc" }],
    };
    const opts = { tableId, fields, config, limit: 200, offset: 0, noPaging: false, search: "" };
    const legacy = await mod.queryRecordsLegacy(opts);
    process.env.GX_M1_SIDECAR_READ = "shadow";
    let shadowed: Awaited<ReturnType<typeof mod.queryRecords>>;
    try {
      shadowed = await mod.queryRecords(opts);
    } finally {
      delete process.env.GX_M1_SIDECAR_READ;
    }
    expect(shadowed.total).toBe(legacy.total);
    expect(shadowed.filteredTotal).toBe(legacy.filteredTotal);
    expect(shadowed.records.map((r) => r.id)).toEqual(legacy.records.map((r) => r.id));
  });

  it("写侧 GX_M1_SIDECAR=off 时即便读=on 也强制回退旧路径", async () => {
    const prev = process.env.GX_M1_SIDECAR;
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_SIDECAR = "off";
    try {
      const opts = {
        tableId, fields, config: baseConfig(), limit: 200, offset: 0, noPaging: false, search: "",
      };
      const a = await mod.queryRecords(opts);
      const b = await mod.queryRecordsLegacy(opts);
      expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
    } finally {
      process.env.GX_M1_SIDECAR = prev;
      delete process.env.GX_M1_SIDECAR_READ;
    }
  });
});
