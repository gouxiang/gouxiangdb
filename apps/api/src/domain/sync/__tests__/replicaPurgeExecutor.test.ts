// beta.2 S4c：失权擦除执行器 applyReplicaPurgeTx 真临时库测试（不 mock DB、不碰 dev.db、不起 HTTP）。
// 设计权威：DESIGN-OFFLINE-SYNC §9.3/D2——第一刀真写：软删可逆、结构永不擦、纯本地硬拒回滚、默认关不接线。
//
// 加载纪律（同 replicaInventory.test.ts）：beforeAll 先 delete GX_OFFLINE_REPLICA 再 setupOrgHarness
// （注入临时 DATABASE_URL + migrate deploy）。执行器运行时依赖链 fieldIndex/sync→policy 仅 import type，
// 不 new PrismaClient，故 read/build/apply 三模块均可在顶层【静态】import。
//
// 真写会污染共享夹具：每个 it 用【独立 base id（tag 后缀）+ 独立 seed】隔离；每次 apply 包独立
// $transaction、注入固定 now，断言一律在事务外用 h.prisma 查。不依赖/断言 record_field_index
// sidecar 表（开关可能关、deleteRecordsTx 自跳过），只断言 records/link_rows/table/field 可见状态。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import { readReplicaInventoryTx } from "../replicaInventory.js";
import { buildReplicaPurgePlan, type PurgePlan, type LocalReplicaInventory } from "../replicaPurgePlan.js";
import type { VisibilityReport } from "../visibility.js";
import {
  applyReplicaPurgeTx,
  PURGE_LOCAL_ONLY_REFUSED,
  ReplicaPurgeRefusedError,
} from "../replicaPurgeExecutor.js";

let h: OrgHarness;
const NODE = "execnode";
const FIXED_NOW = new Date("2026-10-20T00:00:00.000Z");

// ───────────────────────── 独立 seed（每个用例一个 base） ─────────────────────────

interface SeedResult {
  base: string;
  ta: string;
  tb: string;
  tk: string | null;
}

/**
 * 种一份三表（ta 行级降权 / tb 整表失权 / tc 不在 report＝ghost）+ 跨表 link 的标准形。
 * record.fields 的物理列 key 用带 tag 的活字段 id（fa1_tag…），另混一个无 field 行的自由 key
 * （fa2/fb2/fkExtra），验字段收敛按真实 JSON key 而非 field 表。
 */
async function seedScenario(tag: string, opts: { remote?: boolean; withRescopeSurvivor?: boolean } = {}): Promise<SeedResult> {
  const base = `b_${tag}`;
  const ta = `ta_${tag}`;
  const tb = `tb_${tag}`;
  const tc = `tc_${tag}`;
  const id = (p: string) => `${p}_${tag}`;

  await h.prisma.base.create({ data: { id: base, name: tag, createdBy: "t" } });
  const tables: object[] = [
    { id: ta, baseId: base, name: "A", primaryFieldId: id("fa1"), createdBy: "t" },
    { id: tb, baseId: base, name: "B", primaryFieldId: id("fb1"), createdBy: "t" },
    { id: tc, baseId: base, name: "C", primaryFieldId: id("fc1"), createdBy: "t" }, // ghost（report 不含）
  ];
  let tk: string | null = null;
  if (opts.withRescopeSurvivor) {
    tk = `tk_${tag}`;
    tables.push({ id: tk, baseId: base, name: "K", primaryFieldId: id("fk1"), createdBy: "t" });
  }
  await h.prisma.table.createMany({ data: tables as never });

  const fields: object[] = [
    { id: id("fa1"), tableId: ta, name: "标题", type: "text", order: 0 },
    { id: id("fb1"), tableId: tb, name: "标题", type: "text", order: 0 },
    { id: id("fc1"), tableId: tc, name: "标题", type: "text", order: 0 },
  ];
  if (tk) fields.push({ id: id("fk1"), tableId: tk, name: "标题", type: "text", order: 0 });
  await h.prisma.field.createMany({ data: fields as never });

  const records: object[] = [
    { id: id("r1"), tableId: ta, fields: JSON.stringify({ [id("fa1")]: "x", fa2: 1 }), createdBy: "t", updatedBy: "t" },
    { id: id("r2"), tableId: ta, fields: JSON.stringify({ [id("fa1")]: "y" }), createdBy: "t", updatedBy: "t" },
    { id: id("r3"), tableId: tb, fields: JSON.stringify({ [id("fb1")]: "z", fb2: 7 }), createdBy: "t", updatedBy: "t" },
    { id: id("k1"), tableId: tc, fields: JSON.stringify({ [id("fc1")]: "kc1" }), createdBy: "t", updatedBy: "t" },
    { id: id("k2"), tableId: tc, fields: JSON.stringify({ [id("fc1")]: "kc2" }), createdBy: "t", updatedBy: "t" },
  ];
  if (tk) {
    records.push({
      id: id("sk1"), tableId: tk,
      fields: JSON.stringify({ [id("fk1")]: 1, fkExtra: 2 }), createdBy: "t", updatedBy: "t",
    });
  }
  await h.prisma.record.createMany({ data: records as never });

  await h.prisma.linkRow.createMany({
    data: [
      { id: id("L1"), linkFieldId: "faLink", parentRowId: id("r1"), childRowId: id("r3") }, // 归 ta
      { id: id("L2"), linkFieldId: "fbLink", parentRowId: id("r3"), childRowId: id("r1") }, // 归 tb
      { id: id("Lkeep"), linkFieldId: "fcLink", parentRowId: id("k1"), childRowId: id("k2") }, // ghost 内部、不牵连
    ] as never,
  });

  if (opts.remote) {
    await h.prisma.replicaState.create({ data: { nodeId: NODE, remoteBaseId: base, localBaseId: base } });
  }
  return { base, ta, tb, tk };
}

/** 端到端造计划：readReplicaInventoryTx + buildReplicaPurgePlan（localAuthzVersion=null）。 */
async function planFor(base: string, report: VisibilityReport): Promise<PurgePlan> {
  const inventory: LocalReplicaInventory = await h.prisma.$transaction((tx) =>
    readReplicaInventoryTx(tx, { nodeId: NODE, localBaseId: base }));
  return buildReplicaPurgePlan({ report, inventory, localAuthzVersion: null });
}

function apply(plan: PurgePlan, actorUserId?: string) {
  return h.prisma.$transaction((tx) => applyReplicaPurgeTx(tx, plan, { now: FIXED_NOW, actorUserId }));
}

/** ②/⑥ report：ta 行级仅 r2 可见（字段仅 fa1_tag）、tb 整表失权；tc 不返回（ghost）；可选 tk。 */
function rowPurgeReport(tag: string, extraTk: boolean): VisibilityReport {
  const id = (p: string) => `${p}_${tag}`;
  const tables: VisibilityReport["tables"] = [
    { tableId: `ta_${tag}`, readable: true, visibleEntityIds: [id("r2")], visibleFieldIds: [id("fa1")] },
    { tableId: `tb_${tag}`, readable: false, visibleEntityIds: [], visibleFieldIds: [] },
  ];
  if (extraTk) {
    tables.push({ tableId: `tk_${tag}`, readable: true, visibleEntityIds: [id("sk1")], visibleFieldIds: [id("fk1")] });
  }
  return { baseId: `b_${tag}`, authzVersion: 5, serverTime: "2026-10-20T00:00:00.000Z", tables };
}

beforeAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  h = await setupOrgHarness();
}, 120_000);

afterAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  await h.cleanup();
});

// ① 纯本地硬拒回滚
describe("① 纯本地 base：apply 抛 ReplicaPurgeRefusedError，事务回滚、数据原文不变", () => {
  it("code===PURGE_LOCAL_ONLY_REFUSED；记录仍活/fields 原文/link 仍活", async () => {
    const s = await seedScenario("c1", { remote: false });
    const plan = await planFor(s.base, rowPurgeReport("c1", false));
    expect(plan.reason).toBe("skipped_local_only");

    await expect(apply(plan)).rejects.toBeInstanceOf(ReplicaPurgeRefusedError);
    let caughtCode = "";
    try {
      await apply(plan);
    } catch (e) {
      caughtCode = (e as ReplicaPurgeRefusedError).code;
    }
    expect(caughtCode).toBe(PURGE_LOCAL_ONLY_REFUSED);

    const r1 = await h.prisma.record.findUnique({ where: { id: "r1_c1" } });
    expect(r1?.deletedAt).toBeNull();
    expect(r1?.fields).toBe(JSON.stringify({ fa1_c1: "x", fa2: 1 }));
    const l1 = await h.prisma.linkRow.findUnique({ where: { id: "L1_c1" } });
    expect(l1?.deletedAt).toBeNull();
  });
});

// ② 远端行擦 + 整表数据擦 + 跨表 link；结构保留
describe("② 远端：行擦 r1 + 整表数据擦 r3 + 跨表 L1/L2，结构与无关 link 不动", () => {
  it("r1/r3 墓碑、r2 活；L1/L2 墓碑、Lkeep 活；table/field 未擦；计数 2/2/0/sidecar2", async () => {
    const s = await seedScenario("c2", { remote: true });
    const plan = await planFor(s.base, rowPurgeReport("c2", false));
    expect(plan.triggered).toBe(true);

    const result = await apply(plan); // 不传 actor → updatedBy 必须保持原值
    expect(result).toMatchObject({
      triggered: true, reason: "ok",
      recordsSoftDeleted: 2, linksSoftDeleted: 2, recordsRescoped: 0,
      fieldKeysStripped: 0, sidecarRecordsWithdrawn: 2, recordsSkippedMalformedFields: [],
    });

    const recDeleted = async (id: string) => (await h.prisma.record.findUnique({ where: { id } }))?.deletedAt;
    expect(await recDeleted("r1_c2")).toBeInstanceOf(Date);
    expect(await recDeleted("r3_c2")).toBeInstanceOf(Date);
    expect(await recDeleted("r2_c2")).toBeNull();

    const linkDeleted = async (id: string) => (await h.prisma.linkRow.findUnique({ where: { id } }))?.deletedAt;
    expect(await linkDeleted("L1_c2")).toBeInstanceOf(Date);
    expect(await linkDeleted("L2_c2")).toBeInstanceOf(Date);
    expect(await linkDeleted("Lkeep_c2")).toBeNull();

    // 结构永不擦：两张表与其最小字段仍活。
    expect((await h.prisma.table.findUnique({ where: { id: s.ta } }))?.deletedAt).toBeNull();
    expect((await h.prisma.table.findUnique({ where: { id: s.tb } }))?.deletedAt).toBeNull();
    expect((await h.prisma.field.findUnique({ where: { id: "fa1_c2" } }))?.deletedAt).toBeNull();
    expect((await h.prisma.field.findUnique({ where: { id: "fb1_c2" } }))?.deletedAt).toBeNull();
    // 未传 actor：updatedBy 保持原值，不捏造用户。
    expect((await h.prisma.record.findUnique({ where: { id: "r1_c2" } }))?.updatedBy).toBe("t");
  });
});

// ③ 字段抹 key（保留记录）
describe("③ 字段收敛：r1/r2 行可见仅 fa1，抹掉保留记录 r1 的 fa2，tb 仍整表擦", () => {
  it("r1.fields 去 fa2 留 fa1；r2 不变；recordsRescoped=1/stripped=1；传 actor 写 updatedBy；r3 与 L1/L2 被擦", async () => {
    const s = await seedScenario("c3", { remote: true });
    const id = (p: string) => `${p}_c3`;
    const report: VisibilityReport = {
      baseId: s.base, authzVersion: 6, serverTime: "2026-10-20T00:00:00.000Z",
      tables: [
        { tableId: s.ta, readable: true, visibleEntityIds: [id("r1"), id("r2")], visibleFieldIds: [id("fa1")] },
        { tableId: s.tb, readable: false, visibleEntityIds: [], visibleFieldIds: [] },
      ],
    };
    const result = await apply(await planFor(s.base, report), "purger");
    expect(result.recordsSoftDeleted).toBe(1); // 仅 r3
    expect(result.recordsRescoped).toBe(1);
    expect(result.fieldKeysStripped).toBe(1);
    expect(result.linksSoftDeleted).toBe(2);

    const r1 = await h.prisma.record.findUnique({ where: { id: id("r1") } });
    expect(JSON.parse(r1!.fields as string)).toEqual({ [id("fa1")]: "x" }); // fa2 已抹、fa1 留
    expect(r1?.updatedBy).toBe("purger"); // 给了 actor：字段重写带 updatedBy
    const r2 = await h.prisma.record.findUnique({ where: { id: id("r2") } });
    expect(r2?.fields).toBe(JSON.stringify({ [id("fa1")]: "y" })); // 本来就无隐藏键，不重写
    expect(r2?.updatedBy).toBe("t"); // 未被写，updatedBy 不变
    expect((await h.prisma.record.findUnique({ where: { id: id("r3") } }))?.deletedAt).toBeInstanceOf(Date);
  });
});

// ④ 坏 JSON 宁残留
describe("④ 坏 fields JSON 宁残留：不抛错、坏行跳过进清单，正常行照常抹 key", () => {
  it("坏记录逐字节不变且入 skipped；正常记录 key 被抹", async () => {
    const base = "b_c4";
    await h.prisma.base.create({ data: { id: base, name: "c4", createdBy: "t" } });
    await h.prisma.table.createMany({ data: [
      { id: "tbad", baseId: base, name: "bad", primaryFieldId: "fbb", createdBy: "t" },
      { id: "tgood", baseId: base, name: "good", primaryFieldId: "fgg", createdBy: "t" },
    ] });
    await h.prisma.field.createMany({ data: [
      { id: "fbb", tableId: "tbad", name: "t", type: "text", order: 0 },
      { id: "fgg", tableId: "tgood", name: "t", type: "text", order: 0 },
    ] });
    await h.prisma.record.createMany({ data: [
      { id: "rb", tableId: "tbad", fields: "not-json", createdBy: "t", updatedBy: "t" },
      { id: "rg", tableId: "tgood", fields: JSON.stringify({ keep: "a", drop: "b" }), createdBy: "t", updatedBy: "t" },
    ] });
    // 手工 plan：顶层 TablePurge.tableId 不参与字段逻辑，执行器按每条 RescopedField.tableId 校验归表。
    const plan: PurgePlan = {
      baseId: base, triggered: true, reason: "ok", serverAuthzVersion: 1, localAuthzVersion: null,
      tables: [{
        tableId: "tmixed", mode: "rows", removedRecordIds: [], affectedLinkRowIds: [],
        rescopedFields: [
          { tableId: "tbad", recordId: "rb", fieldIds: ["x"] },
          { tableId: "tgood", recordId: "rg", fieldIds: ["drop"] },
        ],
      }],
      removedRecordIds: [], affectedLinkRowIds: [], skippedTablesNotOnServer: [],
      stats: { tablesScanned: 1, recordsRemoved: 0, fieldKeysRemoved: 2, linksRemoved: 0 },
    };

    const result = await apply(plan);
    expect(result.recordsRescoped).toBe(1);
    expect(result.fieldKeysStripped).toBe(1);
    expect(result.recordsSkippedMalformedFields).toEqual(["rb"]);

    expect((await h.prisma.record.findUnique({ where: { id: "rb" } }))?.fields).toBe("not-json");
    const rg = await h.prisma.record.findUnique({ where: { id: "rg" } });
    expect(JSON.parse(rg!.fields as string)).toEqual({ keep: "a" });
  });
});

// ⑤ triggered:false no-op
describe("⑤ triggered=false（identical_authz_version）：零写、计数全 0、数据前后逐字节不变", () => {
  it("活记录仍 deletedAt:null、fields 字符串不变；返回 triggered:false", async () => {
    const base = "b_c5";
    await h.prisma.base.create({ data: { id: base, name: "c5", createdBy: "t" } });
    await h.prisma.table.create({ data: { id: "tn", baseId: base, name: "n", primaryFieldId: "fn1", createdBy: "t" } });
    await h.prisma.field.create({ data: { id: "fn1", tableId: "tn", name: "t", type: "text", order: 0 } });
    await h.prisma.record.create({
      data: { id: "rn", tableId: "tn", fields: JSON.stringify({ fn1: "z", gone: 9 }), createdBy: "t", updatedBy: "t" },
    });
    const plan: PurgePlan = {
      baseId: base, triggered: false, reason: "identical_authz_version",
      serverAuthzVersion: 3, localAuthzVersion: "3", tables: [], removedRecordIds: [],
      affectedLinkRowIds: [], skippedTablesNotOnServer: [],
      stats: { tablesScanned: 0, recordsRemoved: 0, fieldKeysRemoved: 0, linksRemoved: 0 },
    };

    const before = await h.prisma.record.findUnique({ where: { id: "rn" } });
    const result = await apply(plan);
    const after = await h.prisma.record.findUnique({ where: { id: "rn" } });
    expect(result).toMatchObject({ triggered: false, reason: "identical_authz_version" });
    expect(result.recordsSoftDeleted).toBe(0);
    expect(result.recordsRescoped).toBe(0);
    expect(result.fieldKeysStripped).toBe(0);
    expect(result.linksSoftDeleted).toBe(0);
    expect(result.sidecarRecordsWithdrawn).toBe(0);
    expect(result.recordsSkippedMalformedFields).toEqual([]);
    expect(after?.deletedAt).toBeNull();
    expect(after?.fields).toBe(before?.fields);
  });
});

// ⑥ 幂等：同一 plan 连续 apply 两次
describe("⑥ 幂等：同一计划两次独立事务，第二次零动作，终态墓碑/抹 key 持久", () => {
  it("第一次 2/2 + 抹 1 键；第二次全 0；r1/r3 仍墓碑、sk1 仍无 fkExtra", async () => {
    const s = await seedScenario("c6", { remote: true, withRescopeSurvivor: true });
    const plan = await planFor(s.base, rowPurgeReport("c6", true));
    const first = await apply(plan);
    expect(first.recordsSoftDeleted).toBe(2);
    expect(first.linksSoftDeleted).toBe(2);
    expect(first.recordsRescoped).toBe(1);
    expect(first.fieldKeysStripped).toBe(1);
    expect(first.sidecarRecordsWithdrawn).toBe(2);

    const second = await apply(plan);
    expect(second.recordsSoftDeleted).toBe(0);
    expect(second.linksSoftDeleted).toBe(0);
    expect(second.recordsRescoped).toBe(0);
    expect(second.fieldKeysStripped).toBe(0);
    expect(second.sidecarRecordsWithdrawn).toBe(0);
    expect(second.recordsSkippedMalformedFields).toEqual([]);

    expect((await h.prisma.record.findUnique({ where: { id: "r1_c6" } }))?.deletedAt).toBeInstanceOf(Date);
    expect((await h.prisma.record.findUnique({ where: { id: "r3_c6" } }))?.deletedAt).toBeInstanceOf(Date);
    const sk1 = await h.prisma.record.findUnique({ where: { id: "sk1_c6" } });
    expect(JSON.parse(sk1!.fields as string)).toEqual({ fk1_c6: 1 }); // fkExtra 两次后仍不在
  });
});

// ⑦ 软删可逆（非物理销毁）
describe("⑦ 软删可逆：apply 后在新事务手动复活记录即可重读，fields 与结构仍在", () => {
  it("r1 置 deletedAt:null 后 findUnique 可读、fields 原文保留、ta 表仍活", async () => {
    const s = await seedScenario("c7", { remote: true });
    await apply(await planFor(s.base, rowPurgeReport("c7", false)));
    expect((await h.prisma.record.findUnique({ where: { id: "r1_c7" } }))?.deletedAt).toBeInstanceOf(Date);

    // 代表【未来】重新授权后权威端重拉 restore；本执行器自身不做 restore。
    await h.prisma.$transaction((tx) => tx.record.update({ where: { id: "r1_c7" }, data: { deletedAt: null } }));

    const r1 = await h.prisma.record.findUnique({ where: { id: "r1_c7" } });
    expect(r1?.deletedAt).toBeNull();
    expect(r1?.fields).toBe(JSON.stringify({ fa1_c7: "x", fa2: 1 }));
    expect((await h.prisma.table.findUnique({ where: { id: s.ta } }))?.deletedAt).toBeNull();
  });
});
