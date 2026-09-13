// M1/S7 keyset 分页端到端（真迁移临时库 + 真 Prisma + sync 写 sidecar）：
//   - T1 原生 createdAt keyset / T2 物理排序 keyset / T3 宽口径 keyset：
//     逐页用 nextCursor 翻完整表，拼接 recordId 序列 == S5 旧路径（noPaging）最终有序集合，
//     无重复、无遗漏；hasMore/nextCursor 边界正确。
//   - offset 窗口内快进 == 旧 slice；超窗 OffsetWindowError；坏游标 InvalidCursorError。
//   - 宽口径 groups/aggregations 与旧路径一致；超阈值 degraded=["computedInMem"]。
//   - 两级 flag：keyset=on 响应 additive 三键；off 无三键；shadow 返回旧形态且不抛；写停回退。
//
// 同 S6：牵 db.js 的模块一律在 globalThis.__gx_prisma 设置后动态 import。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import type { ViewConfig } from "@gx/shared-types";
import { createSidecarQuerier } from "../sidecarQuery.js";
import { InvalidCursorError, OffsetWindowError, encodeCursor } from "../cursor.js";

type FieldMetaList = Awaited<ReturnType<typeof import("../../recordService.js")["loadTableFields"]>>;
const N = 160;
const PAGE = 17; // 160/17 → 10 页（9 满 + 7），强制走满翻页循环
let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let tableId: string;
let fields: FieldMetaList;
let F: Record<string, string>;

let mod: {
  runKeysetPaging: typeof import("../paginate.js")["runKeysetPaging"];
  queryRecords: typeof import("../../recordService.js")["queryRecords"];
  queryRecordsLegacy: typeof import("../../recordService.js")["queryRecordsLegacy"];
  parseViewConfig: typeof import("../../recordService.js")["parseViewConfig"];
  loadTableFields: typeof import("../../recordService.js")["loadTableFields"];
  syncRecordsTx: typeof import("../../fieldIndex/sync.js")["syncRecordsTx"];
};

const baseConfig = (): ViewConfig => mod.parseViewConfig(null);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-keyset-"));
  dbFile = path.join(tmpDir, "p.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  process.env.GX_M1_SIDECAR_READ = "on";
  process.env.GX_M1_KEYSET = "on";
  delete process.env.GX_M1_OFFSET_WINDOW;
  delete process.env.GX_M1_INMEM_LIMIT;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [paginate, rec, sync] = await Promise.all([
    import("../paginate.js"),
    import("../../recordService.js"),
    import("../../fieldIndex/sync.js"),
  ]);
  mod = {
    runKeysetPaging: paginate.runKeysetPaging,
    queryRecords: rec.queryRecords,
    queryRecordsLegacy: rec.queryRecordsLegacy,
    parseViewConfig: rec.parseViewConfig,
    loadTableFields: rec.loadTableFields,
    syncRecordsTx: sync.syncRecordsTx,
  };
}, 120000);

afterAll(async () => {
  raw?.close();
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.GX_M1_KEYSET;
  delete process.env.GX_M1_SIDECAR_READ;
  delete process.env.GX_M1_SIDECAR;
});

beforeEach(async () => {
  // 复位到 on/on 基线（各用例可自行下调）；窗口/阈值清掉用默认。
  process.env.GX_M1_SIDECAR = "on";
  process.env.GX_M1_SIDECAR_READ = "on";
  process.env.GX_M1_KEYSET = "on";
  delete process.env.GX_M1_OFFSET_WINDOW;
  delete process.env.GX_M1_INMEM_LIMIT;
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
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: F.name } });

  const data = [];
  const pad = (i: number) => String((i % 28) + 1).padStart(2, "0");
  const baseMs = Date.parse("2026-02-01T00:00:00.000Z");
  for (let i = 0; i < N; i++) {
    const o: Record<string, unknown> = { [F.name]: `记录${String(i).padStart(3, "0")}` };
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

/** 直调 paginate：从首页起用 nextCursor 翻到底，返回拼接 id 序列与各页信息。 */
async function walkAll(config: ViewConfig, search = "", limit = PAGE) {
  const q = createSidecarQuerier(raw);
  const seen: string[] = [];
  const modes = new Set<string>();
  const degradedSeen: string[][] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const r = await mod.runKeysetPaging(q, {
      tableId, fields, config, search, limit, offset: 0, cursor,
    });
    modes.add(r.mode);
    degradedSeen.push(r.degraded);
    seen.push(...r.records.map((x) => x.id));
    pages++;
    if (!r.hasMore) {
      expect(r.nextCursor).toBeNull();
      break;
    }
    expect(r.nextCursor).not.toBeNull();
    expect(r.records).toHaveLength(limit);
    cursor = r.nextCursor;
    if (pages > 100) throw new Error("翻页不收敛（hasMore 恒真，可能死循环）");
  }
  return { seen, pages, modes, degradedSeen };
}

/** S5 旧路径全量最终有序序列（noPaging），作为对拍基准。 */
async function legacyIds(config: ViewConfig, search = "") {
  const r = await mod.queryRecordsLegacy({
    tableId, fields, config, search, noPaging: true,
  });
  return r.records.map((x) => x.id);
}

describe("T1 keyset-created（无排序，原生 createdAt 游标）", () => {
  it("翻 10 页拼接 == 全量 (createdAt,id) 有序集合，无重无漏", async () => {
    const config = baseConfig();
    const { seen, pages, modes } = await walkAll(config);
    expect(pages).toBe(10);
    expect(modes).toEqual(new Set(["keyset-created"]));
    expect(seen).toEqual(await legacyIds(config));
    expect(new Set(seen).size).toBe(N); // 无重复
  });

  it("物理过滤（age>=20）后翻页拼接 == 过滤后有序集合；total/filteredTotal 口径不变", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.age, op: "gte", value: "20" } as ViewConfig["filters"],
    };
    const q = createSidecarQuerier(raw);
    const first = await mod.runKeysetPaging(q, {
      tableId, fields, config, search: "", limit: PAGE, offset: 0, cursor: null,
    });
    expect(first.mode).toBe("keyset-created");
    expect(first.total).toBe(N);
    const expected = await legacyIds(config);
    expect(first.filteredTotal).toBe(expected.length);

    const { seen } = await walkAll(config);
    expect(seen).toEqual(expected);
  });

  it("同字段 range(age gte+lte) 走 rfi JOIN 取页，翻页拼接 == 过滤后有序集合且不重不漏", async () => {
    // S10：有 countPlan 时 T1 keyset 改走 rfi JOIN（非相关 EXISTS），双边界 range 拼接必须
    // 与旧路径逐 id 相等，验证 JOIN 取页无重复（标量字段 1 行/记录）、无遗漏、序正确。
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "and", children: [
        { kind: "condition", fieldId: F.age, op: "gte", value: "18" },
        { kind: "condition", fieldId: F.age, op: "lte", value: "70" },
      ] } as ViewConfig["filters"],
    };
    const q = createSidecarQuerier(raw);
    const first = await mod.runKeysetPaging(q, {
      tableId, fields, config, search: "", limit: PAGE, offset: 0, cursor: null,
    });
    expect(first.mode).toBe("keyset-created");
    const expected = await legacyIds(config);
    expect(first.filteredTotal).toBe(expected.length);
    const { seen, modes } = await walkAll(config);
    expect(modes).toEqual(new Set(["keyset-created"]));
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("首页 hasMore/nextCursor 正确；末页 hasMore=false", async () => {
    const q = createSidecarQuerier(raw);
    const first = await mod.runKeysetPaging(q, {
      tableId, fields, config: baseConfig(), search: "", limit: PAGE, offset: 0, cursor: null,
    });
    expect(first.records).toHaveLength(PAGE);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.degraded).toEqual([]);
  });
});

describe("T2 keyset-sorted（valueNum 物理排序 + 物理过滤）", () => {
  it("stars asc 翻页拼接 == 旧路径排序序列", async () => {
    const config: ViewConfig = { ...baseConfig(), sorts: [{ fieldId: F.stars, direction: "asc" }] };
    const { seen, modes } = await walkAll(config);
    expect(modes).toEqual(new Set(["keyset-sorted"]));
    expect(seen).toEqual(await legacyIds(config));
  });

  it("stars desc + age 过滤组合翻页一致", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      sorts: [{ fieldId: F.stars, direction: "desc" }],
      filters: { kind: "condition", fieldId: F.age, op: "gt", value: "10" } as ViewConfig["filters"],
    };
    const { seen } = await walkAll(config);
    expect(seen).toEqual(await legacyIds(config));
  });

  it("边界行已不在物理集合（伪造游标 id）→ InvalidCursorError", async () => {
    const q = createSidecarQuerier(raw);
    const config: ViewConfig = { ...baseConfig(), sorts: [{ fieldId: F.stars, direction: "asc" }] };
    const fake = encodeCursor({ c: Date.parse("2026-02-01T00:00:00.000Z"), id: "not-in-set-xyz" })!;
    await expect(
      mod.runKeysetPaging(q, { tableId, fields, config, search: "", limit: PAGE, offset: 0, cursor: fake }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe("T3 keyset-wide（残余过滤/搜索/文本排序/分组）", () => {
  it("notContains 残余过滤翻页拼接 == 旧路径", async () => {
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.email, op: "notContains", value: "example" } as ViewConfig["filters"],
    };
    const { seen, modes } = await walkAll(config);
    expect(modes).toEqual(new Set(["keyset-wide"]));
    expect(seen).toEqual(await legacyIds(config));
  });

  it("跨字段搜索翻页拼接 == 旧路径", async () => {
    const { seen } = await walkAll(baseConfig(), "记录01");
    const expected = await legacyIds(baseConfig(), "记录01");
    expect(seen).toEqual(expected);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("文本排序（valueText 不下推）翻页拼接 == 旧路径 zh-CN 序", async () => {
    const config: ViewConfig = { ...baseConfig(), sorts: [{ fieldId: F.name, direction: "asc" }] };
    const { seen, modes } = await walkAll(config);
    expect(modes).toEqual(new Set(["keyset-wide"]));
    expect(seen).toEqual(await legacyIds(config));
  });

  it("分组 + 物理过滤：每页 records 拼接一致，groups/aggregations 为分页前全量且与旧路径相等", async () => {
    const q = createSidecarQuerier(raw);
    const config: ViewConfig = {
      ...baseConfig(),
      groupByFieldId: F.status,
      filters: { kind: "condition", fieldId: F.age, op: "gt", value: "10" } as ViewConfig["filters"],
      aggregations: { [F.age]: "sum" },
    };
    const first = await mod.runKeysetPaging(q, {
      tableId, fields, config, search: "", limit: PAGE, offset: 0, cursor: null,
    });
    expect(first.mode).toBe("keyset-wide");
    const legacy = await mod.queryRecordsLegacy({
      tableId, fields, config, noPaging: true,
    });
    expect(first.groups).not.toBeNull();
    expect(first.groups!.map((g) => g.key)).toEqual(legacy.groups!.map((g) => g.key));
    const pg = new Map(first.groups!.map((g) => [g.key, g]));
    for (const g of legacy.groups!) {
      expect(pg.get(g.key)!.recordIds).toEqual(g.recordIds);
    }
    expect(first.aggregations).toEqual(legacy.aggregations);
    expect(first.filteredTotal).toBe(legacy.filteredTotal);

    const { seen } = await walkAll(config);
    expect(seen).toEqual(legacy.records.map((x) => x.id));
  });

  it("候选超 GX_M1_INMEM_LIMIT 且含残余 → degraded=[computedInMem]", async () => {
    process.env.GX_M1_INMEM_LIMIT = "10";
    try {
      const q = createSidecarQuerier(raw);
      const config: ViewConfig = {
        ...baseConfig(),
        filters: { kind: "condition", fieldId: F.email, op: "notContains", value: "example" } as ViewConfig["filters"],
      };
      const first = await mod.runKeysetPaging(q, {
        tableId, fields, config, search: "", limit: PAGE, offset: 0, cursor: null,
      });
      expect(first.degraded).toEqual(["computedInMem"]);
    } finally {
      delete process.env.GX_M1_INMEM_LIMIT;
    }
  });
});

describe("offset 兼容窗口与坏游标", () => {
  it("T1 窗口内 offset 快进：首页等价旧路径 slice(offset, offset+limit)", async () => {
    const q = createSidecarQuerier(raw);
    const config = baseConfig();
    const r = await mod.runKeysetPaging(q, {
      tableId, fields, config, search: "", limit: 20, offset: 60, cursor: null,
    });
    const legacy = await legacyIds(config);
    expect(r.records.map((x) => x.id)).toEqual(legacy.slice(60, 80));
    expect(r.hasMore).toBe(true);
  });

  it("offset >= limit×5（默认窗口）→ OffsetWindowError（T1）", async () => {
    const q = createSidecarQuerier(raw);
    await expect(
      mod.runKeysetPaging(q, {
        tableId, fields, config: baseConfig(), search: "", limit: 20, offset: 100, cursor: null,
      }),
    ).rejects.toBeInstanceOf(OffsetWindowError);
  });

  it("T3 窗口外 offset 同样 OffsetWindowError", async () => {
    const q = createSidecarQuerier(raw);
    const config: ViewConfig = {
      ...baseConfig(),
      filters: { kind: "condition", fieldId: F.email, op: "notContains", value: "example" } as ViewConfig["filters"],
    };
    await expect(
      mod.runKeysetPaging(q, { tableId, fields, config, search: "", limit: 20, offset: 999, cursor: null }),
    ).rejects.toBeInstanceOf(OffsetWindowError);
  });

  it("坏游标（非 base64/结构错）→ InvalidCursorError", async () => {
    const q = createSidecarQuerier(raw);
    for (const bad of ["!!!", encodeCursor({ c: 1, id: "a" })!.slice(0, -2), "a.b/c"]) {
      await expect(
        mod.runKeysetPaging(q, {
          tableId, fields, config: baseConfig(), search: "", limit: PAGE, offset: 0, cursor: bad,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });
});

describe("两级 flag 生命周期（经 queryRecords 分派器）", () => {
  const opts = () => ({
    tableId, fields, config: baseConfig(), limit: PAGE, offset: 0, search: "",
  });

  it("keyset=on：响应含 additive 三键且首页序列与旧路径一致", async () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "on";
    const r = await mod.queryRecords(opts());
    expect(Object.keys(r).sort()).toEqual(
      ["aggregations", "degraded", "filteredTotal", "groups", "hasMore", "nextCursor", "records", "total"],
    );
    expect(r.hasMore).toBe(true);
    expect(typeof r.nextCursor).toBe("string");
    expect(r.degraded).toEqual([]);
    const legacy = await mod.queryRecordsLegacy({ ...opts(), limit: PAGE });
    expect(r.records.map((x) => x.id)).toEqual(legacy.records.map((x) => x.id));
  });

  it("keyset=off（read 仍 on）：无 additive 三键，走 S6 planner offset 形态", async () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "off";
    const r = await mod.queryRecords(opts());
    expect(Object.keys(r).sort()).toEqual(
      ["aggregations", "filteredTotal", "groups", "records", "total"],
    );
    expect("nextCursor" in r).toBe(false);
  });

  it("keyset=shadow：返回旧形态（无三键、不抛），keyset 仅双跑记日志", async () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "shadow";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await mod.queryRecords(opts());
      expect(Object.keys(r).sort()).toEqual(
        ["aggregations", "filteredTotal", "groups", "records", "total"],
      );
      const diffs = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("[keyset-shadow]") && m.includes("差异"));
      expect(diffs).toEqual([]); // 基准集 drift=0
    } finally {
      spy.mockRestore();
    }
  });

  it("read=off：即便 keyset=on 也完全回退 S5 旧路径（五字段）", async () => {
    process.env.GX_M1_SIDECAR_READ = "off";
    process.env.GX_M1_KEYSET = "on";
    const r = await mod.queryRecords(opts());
    expect(Object.keys(r).sort()).toEqual(
      ["aggregations", "filteredTotal", "groups", "records", "total"],
    );
  });

  it("写侧 GX_M1_SIDECAR=off：keyset=on 也回退", async () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "on";
    process.env.GX_M1_SIDECAR = "off";
    try {
      const r = await mod.queryRecords(opts());
      expect("nextCursor" in r).toBe(false);
    } finally {
      process.env.GX_M1_SIDECAR = "on";
    }
  });

  it("noPaging 恒走非游标路径（无三键），导出全量不受 keyset 影响", async () => {
    process.env.GX_M1_SIDECAR_READ = "on";
    process.env.GX_M1_KEYSET = "on";
    const r = await mod.queryRecords({ ...opts(), noPaging: true });
    expect("nextCursor" in r).toBe(false);
    expect(r.records).toHaveLength(N);
  });
});
