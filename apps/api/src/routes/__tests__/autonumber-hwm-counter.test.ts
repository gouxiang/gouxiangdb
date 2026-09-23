// autoNumber 持久化高水位计数器（真 app HTTP + 真迁移临时库）。
// 覆盖：连续建号递增；软删后新号不复用；年/月重置分桶各自计数（含回填脚本幂等）；
// field 重置按字段值分桶。
//
// 隔离：每个用例独立建 Base/Table——一条 HTTP 记录会被表上所有 autoNumber 字段同时编号，
// 回填也按全表记录分桶，共用一张表会互相污染计数。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

let h: Harness;
let tableId: string;

beforeAll(async () => {
  h = await setupHarness("gx-autonumber-hwm-");
}, 120000);

afterAll(async () => {
  await h.teardown();
});

beforeEach(async () => {
  // base 名须唯一（A4 全局部分唯一索引）：用随机名。
  const baseId = await h.makeBase(`autobase_${Math.random().toString(36).slice(2, 8)}`);
  tableId = (await h.makeTable(baseId, "t")).id;
});

/** 新建 autoNumber 字段（counter reset 可配），返回字段 id。 */
async function makeAutoNumber(name: string, reset: string, resetFieldId?: string): Promise<string> {
  const res = await h.request("POST", `/fields?tableId=${tableId}`, {
    name,
    type: "autoNumber",
    numberRule: {
      segments: [{ type: "counter", digits: 3, reset, ...(resetFieldId ? { resetFieldId } : {}) }],
    },
  });
  expect(res.status).toBe(201);
  return (await res.json()).field.id;
}

/** 经 HTTP 建记录，返回该 autoNumber 字段的编号。 */
async function createWithNumber(fid: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await h.request("POST", `/records?tableId=${tableId}`, { fields: extra });
  expect(res.status).toBe(201);
  const { record } = await res.json();
  return record.fields[fid] as string;
}

/** 执行回填脚本（真实子进程），返回 stdout。 */
function runBackfill(): string {
  return execSync("node scripts/backfill-auto-number-counters.mjs", {
    cwd: process.cwd(),
    env: process.env,
  }).toString();
}

/** 直接落一条带 createdAt 的活记录（模拟存量，编号字符串随意）。 */
async function seedRecordAt(fid: string, when: Date, num: string): Promise<void> {
  await h.prisma.record.create({
    data: {
      tableId,
      fields: JSON.stringify({ [fid]: num }),
      createdAt: when,
      createdBy: OWNER_ID,
      updatedBy: OWNER_ID,
    },
  });
}

/** 找到 fields[fid] 等于 num 的活记录 id。 */
async function recordIdByNumber(fid: string, num: string): Promise<string> {
  const rows = await h.prisma.record.findMany({ where: { tableId, deletedAt: null } });
  const hit = rows.find((r) => JSON.parse(r.fields)[fid] === num);
  if (!hit) throw new Error(`未找到编号 ${num} 的记录`);
  return hit.id;
}

describe("autoNumber 高水位计数器", () => {
  it("reset=never：连续建号 001/002/003 递增", async () => {
    const fid = await makeAutoNumber("编号never", "never");
    expect(await createWithNumber(fid)).toBe("001");
    expect(await createWithNumber(fid)).toBe("002");
    expect(await createWithNumber(fid)).toBe("003");
  });

  it("软删一条后新号不复用：001/002，删 001，再建为 003", async () => {
    const fid = await makeAutoNumber("编号soft", "never");
    expect(await createWithNumber(fid)).toBe("001");
    expect(await createWithNumber(fid)).toBe("002");
    const rid = await recordIdByNumber(fid, "001");
    expect((await h.request("DELETE", `/records/${rid}`)).status).toBe(200);
    expect(await createWithNumber(fid)).toBe("003");
  });

  it("reset=year：回填后今年桶 2 条→新号 003，去年桶独立为 1；脚本幂等", async () => {
    const fid = await makeAutoNumber("编号year", "year");
    await seedRecordAt(fid, new Date(2026, 0, 10), "LEG-Y-A");
    await seedRecordAt(fid, new Date(2026, 1, 10), "LEG-Y-B");
    await seedRecordAt(fid, new Date(2025, 5, 10), "LEG-Y-LAST");

    const out1 = runBackfill();
    expect(out1).toContain("回填完成");
    // 再跑一次：已存在的 key 全部跳过，计数不变
    const countersBefore = await h.prisma.autoNumberCounter.count({ where: { tableId } });
    runBackfill();
    expect(await h.prisma.autoNumberCounter.count({ where: { tableId } })).toBe(countersBefore);

    // 当前（2026）年桶高水位 2 → 新号 003
    expect(await createWithNumber(fid)).toBe("003");
    // 去年桶计数器仍为 1（未被本次发号影响）
    const lastYear = await h.prisma.autoNumberCounter.findFirst({
      where: { tableId, key: `${fid}:0:year:2025` },
      select: { value: true },
    });
    expect(lastYear?.value).toBe(1);
  });

  it("reset=month：回填后本月桶 2 条→新号 003，历史月份桶独立", async () => {
    const fid = await makeAutoNumber("编号month", "month");
    await seedRecordAt(fid, new Date(2026, 8, 2), "LEG-M-A");
    await seedRecordAt(fid, new Date(2026, 8, 10), "LEG-M-B");
    await seedRecordAt(fid, new Date(2026, 6, 10), "LEG-M-OLD");

    runBackfill();
    expect(await createWithNumber(fid)).toBe("003");
    const old = await h.prisma.autoNumberCounter.findFirst({
      where: { tableId, key: `${fid}:0:month:202607` },
      select: { value: true },
    });
    expect(old?.value).toBe(1);
  });

  it("reset=field：按重置字段值分桶，两值各自 001/002 计数", async () => {
    const catRes = await h.request("POST", `/fields?tableId=${tableId}`, {
      name: "类别",
      type: "singleLineText",
    });
    const catId = (await catRes.json()).field.id;
    const fid = await makeAutoNumber("编号field", "field", catId);

    expect(await createWithNumber(fid, { [catId]: "X" })).toBe("001");
    expect(await createWithNumber(fid, { [catId]: "X" })).toBe("002");
    expect(await createWithNumber(fid, { [catId]: "Y" })).toBe("001");
    expect(await createWithNumber(fid, { [catId]: "Y" })).toBe("002");
    expect(await createWithNumber(fid, { [catId]: "X" })).toBe("003");
  });
});
