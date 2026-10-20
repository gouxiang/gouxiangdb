// beta.2 S4b：失权擦除只读取数层 readReplicaInventoryTx 单测（真临时库 + 真迁移，不 mock DB，不碰 dev.db）。
// 设计权威：DESIGN-OFFLINE-SYNC §9.3/D2——读层只投影「本地副本有什么」，零写；产出形状直接喂 S4a
// buildReplicaPurgePlan。
//
// 加载纪律（同 replicaPull.test.ts）：beforeAll 先 delete GX_OFFLINE_REPLICA 再 setupOrgHarness
// （它注入临时 DATABASE_URL 并 prisma migrate deploy）。本模块运行时零 import（DbTx 是 import type），
// replicaPurgePlan 是纯函数，故二者可在顶层【静态】import 而不会在 DATABASE_URL 注入前 new client。
// 纯读库、不起 HTTP、不起假 transport。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import { readReplicaInventoryTx } from "../replicaInventory.js";
import { buildReplicaPurgePlan } from "../replicaPurgePlan.js";
import type { VisibilityReport } from "../visibility.js";
import type { LocalReplicaInventory } from "../replicaPurgePlan.js";

let h: OrgHarness;
const NODE = "invnode";
const BASE = "b_inv";

function read(nodeId: string = NODE): Promise<LocalReplicaInventory> {
  return h.prisma.$transaction((tx) => readReplicaInventoryTx(tx, { nodeId, localBaseId: BASE }));
}

beforeAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  h = await setupOrgHarness();

  // ── base + 两张活表 + 一张软删表 ──
  await h.prisma.base.create({ data: { id: BASE, name: "inv", createdBy: "t" } });
  await h.prisma.table.createMany({
    data: [
      { id: "ta", baseId: BASE, name: "A", primaryFieldId: "fa1", createdBy: "t" },
      { id: "tb", baseId: BASE, name: "B", primaryFieldId: "fb1", createdBy: "t" },
      { id: "td", baseId: BASE, name: "D", primaryFieldId: "fd1", createdBy: "t", deletedAt: new Date() },
    ],
  });
  // 只建 primaryFieldId 指向的最小字段行；record.fields 是自由 JSON，其余 key 不必有 field 行。
  await h.prisma.field.createMany({
    data: [
      { id: "fa1", tableId: "ta", name: "标题", type: "text", order: 0 },
      { id: "fb1", tableId: "tb", name: "标题", type: "text", order: 0 },
    ],
  });

  // ── 活记录 / 软删记录（fields 为 JSON 字符串） ──
  await h.prisma.record.createMany({
    data: [
      { id: "r1", tableId: "ta", fields: JSON.stringify({ fa1: "x", fa2: 1 }), createdBy: "t", updatedBy: "t" },
      { id: "r2", tableId: "ta", fields: JSON.stringify({ fa1: "y" }), createdBy: "t", updatedBy: "t" },
      { id: "r3", tableId: "tb", fields: JSON.stringify({ fb1: "z", fb2: 7 }), createdBy: "t", updatedBy: "t" },
      { id: "rTomb", tableId: "ta", fields: JSON.stringify({ fa1: "dead" }), createdBy: "t", updatedBy: "t", deletedAt: new Date() },
    ],
  });

  // ── link_rows：跨表正/反向、软删、孤儿（parent 为软删记录；link 有 FK 不能指真不存在的行） ──
  await h.prisma.linkRow.createMany({
    data: [
      { id: "L1", linkFieldId: "faLink", parentRowId: "r1", childRowId: "r3" }, // 归 ta（parent 在 ta）
      { id: "L2", linkFieldId: "fbLink", parentRowId: "r3", childRowId: "r1" }, // 归 tb（parent 在 tb）
      // 唯一约束 [linkFieldId,parentRowId,childRowId] 不区分软删，故 Ldead 用独立三元组。
      { id: "Ldead", linkFieldId: "faLink", parentRowId: "r2", childRowId: "r3", deletedAt: new Date() },
      { id: "Lorphan", linkFieldId: "faOrphan", parentRowId: "rTomb", childRowId: "r3" }, // parent 非活记录 → 丢弃
    ],
  });
}, 120_000);

afterAll(async () => {
  delete process.env.GX_OFFLINE_REPLICA;
  await h.cleanup();
});

// ───────────────────────── ① 纯本地：无 replica_state 行 ─────────────────────────

describe("① 纯本地 base（无 replica_state）：isLocalOnly=true，只数活表/活记录/活 link 并归表", () => {
  it("tables 仅 ta/tb（td 墓碑排除）按 id 序；活记录/字段 key/link 归表正确；Ldead/Lorphan 不出现", async () => {
    const inv = await read();
    expect(inv.baseId).toBe(BASE);
    expect(inv.isLocalOnly).toBe(true);
    expect(inv.tables.map((t) => t.tableId)).toEqual(["ta", "tb"]);

    const ta = inv.tables.find((t) => t.tableId === "ta")!;
    expect(ta.liveRecordIds).toEqual(["r1", "r2"]); // rTomb 排除
    expect(ta.recordFieldKeys).toEqual({
      r1: ["fa1", "fa2"], // fa2 无 field 行，仍按 record.fields 实际 key 报出 + 字典序
      r2: ["fa1"],
    });
    expect(ta.links.map((l) => l.id)).toEqual(["L1"]);
    expect(ta.links[0]).toEqual({ id: "L1", linkFieldId: "faLink", parentRowId: "r1", childRowId: "r3" });

    const tb = inv.tables.find((t) => t.tableId === "tb")!;
    expect(tb.liveRecordIds).toEqual(["r3"]);
    expect(tb.recordFieldKeys).toEqual({ r3: ["fb1", "fb2"] });
    expect(tb.links.map((l) => l.id)).toEqual(["L2"]); // 反向跨表 link 归 parent 所在的 tb
  });
});

// ───────────────────────── ② 远端副本：建 replica_state 后 isLocalOnly=false，按 node 隔离 ─────────────────────────

describe("② replica_state 有行 → isLocalOnly=false，清单不变；其它 nodeId 仍判纯本地", () => {
  it("本 node 翻转、内容与①一致；未知 node 仍 true", async () => {
    await h.prisma.replicaState.create({
      data: { nodeId: NODE, remoteBaseId: BASE, localBaseId: BASE },
    });
    const inv = await read();
    expect(inv.isLocalOnly).toBe(false);
    expect(inv.tables.map((t) => t.tableId)).toEqual(["ta", "tb"]);
    expect(inv.tables.find((t) => t.tableId === "ta")!.liveRecordIds).toEqual(["r1", "r2"]);
    expect(inv.tables.find((t) => t.tableId === "tb")!.links.map((l) => l.id)).toEqual(["L2"]);

    const other = await read("some-other-node");
    expect(other.isLocalOnly).toBe(true);
  });
});

// ───────────────────────── ③ 坏 fields 防御 ─────────────────────────

describe("③ 坏 fields（非法 JSON）不中断清单，该记录 key 集为空，其余正常", () => {
  it("recordFieldKeys.rBad=[]，不抛错", async () => {
    // 用独立活表隔离坏记录，避免污染 ⑤ 的行级差集（该表不在 ⑤ report 中会落 ghost 跳过）。
    await h.prisma.table.create({
      data: { id: "tz", baseId: BASE, name: "Z", primaryFieldId: "fz1", createdBy: "t" },
    });
    await h.prisma.record.create({
      data: { id: "rBad", tableId: "tz", fields: "not-json", createdBy: "t", updatedBy: "t" },
    });
    const inv = await read(NODE);
    const tz = inv.tables.find((t) => t.tableId === "tz")!;
    expect(tz.liveRecordIds).toEqual(["rBad"]);
    expect(tz.recordFieldKeys.rBad).toEqual([]);
    // 好表/好记录不受影响。
    expect(inv.tables.find((t) => t.tableId === "ta")!.recordFieldKeys.r1).toEqual(["fa1", "fa2"]);
  });
});

// ───────────────────────── ④ 确定性 / 可序列化 ─────────────────────────

describe("④ 确定性：连读两次逐字节相等，JSON 往返深等（无 BigInt/Map/Set/Date）", () => {
  it("两次 stringify 相等且 JSON.parse(JSON.stringify()) 深等自身", async () => {
    const a = await read(NODE);
    const b = await read(NODE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

// ───────────────────────── ⑤ 端到端接缝：inventory 直接喂 buildReplicaPurgePlan ─────────────────────────

describe("⑤ 取数层→计划层端到端：纯本地空动作；远端收缩触发行擦/表数据擦/跨表 link 聚合", () => {
  function serverReport(): VisibilityReport {
    return {
      baseId: BASE,
      authzVersion: 5,
      serverTime: "2026-10-20T00:00:00.000Z",
      tables: [
        // ta 行级降权：仅 r2 可见；字段仅 fa1 可见。
        { tableId: "ta", readable: true, visibleEntityIds: ["r2"], visibleFieldIds: ["fa1"] },
        // tb 整表失权。
        { tableId: "tb", readable: false, visibleEntityIds: [], visibleFieldIds: [] },
      ],
    };
  }

  it("纯本地副本（其它 node）→ skipped_local_only 空动作", async () => {
    const localInv = await read("some-other-node"); // ② 已证它无 state → isLocalOnly=true
    const plan = buildReplicaPurgePlan({ report: serverReport(), inventory: localInv, localAuthzVersion: null });
    expect(plan.reason).toBe("skipped_local_only");
    expect(plan.triggered).toBe(false);
    expect(plan.removedRecordIds).toEqual([]);
    expect(plan.affectedLinkRowIds).toEqual([]);
  });

  it("远端副本 → r1(行擦)/r3(整表数据擦) removed、r2 保留；跨表 L1/L2 全受牵连", async () => {
    const inv = await read(NODE);
    expect(inv.isLocalOnly).toBe(false);
    const plan = buildReplicaPurgePlan({ report: serverReport(), inventory: inv, localAuthzVersion: null });

    expect(plan.triggered).toBe(true);
    expect(plan.reason).toBe("ok");
    expect(plan.removedRecordIds).toEqual(["r1", "r3"]);
    expect(plan.removedRecordIds).not.toContain("r2");
    const ta = plan.tables.find((t) => t.tableId === "ta")!;
    const tb = plan.tables.find((t) => t.tableId === "tb")!;
    expect(ta.mode).toBe("rows");
    expect(ta.removedRecordIds).toEqual(["r1"]);
    expect(tb.mode).toBe("table_data");
    expect(tb.removedRecordIds).toEqual(["r3"]);
    // 关键：r1 既已被行级擦除，按 S4a 规则不再为其生成字段收敛（整行将不存在），故 ta 无 rescoped。
    expect(ta.rescopedFields).toEqual([]);
    // r1(L1 的 parent) 在 ta、r3(L2 的 parent) 在 tb；两端任一被擦 → 两条跨表 link 都列出。
    expect(plan.affectedLinkRowIds).toEqual(["L1", "L2"]);
    expect(ta.affectedLinkRowIds).toEqual(["L1"]);
    expect(tb.affectedLinkRowIds).toEqual(["L2"]);
    expect(plan.stats).toMatchObject({ tablesScanned: 2, recordsRemoved: 2, linksRemoved: 2 });
  });

  it("字段接缝：保留记录失字段才出 rescopedFields（行不擦、只收敛 fa2）", async () => {
    const inv = await read(NODE);
    // 让 r1/r2 行都仍可见，仅字段收到 fa1；tb 整表失权（r3 擦→其 link 仍须列出）。
    const report: VisibilityReport = {
      baseId: BASE, authzVersion: 6, serverTime: "2026-10-20T00:00:00.000Z",
      tables: [
        { tableId: "ta", readable: true, visibleEntityIds: ["r1", "r2"], visibleFieldIds: ["fa1"] },
        { tableId: "tb", readable: false, visibleEntityIds: [], visibleFieldIds: [] },
      ],
    };
    const plan = buildReplicaPurgePlan({ report, inventory: inv, localAuthzVersion: null });
    expect(plan.removedRecordIds).toEqual(["r3"]); // ta 无行擦
    const ta = plan.tables.find((t) => t.tableId === "ta")!;
    expect(ta.rescopedFields).toEqual([{ tableId: "ta", recordId: "r1", fieldIds: ["fa2"] }]);
    expect(plan.stats.fieldKeysRemoved).toBe(1);
    // r3 被擦 → L1(child=r3)/L2(parent=r3) 仍受牵连。
    expect(plan.affectedLinkRowIds).toEqual(["L1", "L2"]);
  });
});
