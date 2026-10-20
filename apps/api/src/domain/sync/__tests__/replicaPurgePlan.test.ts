// beta.2 S4a：失权擦除纯计划层 replicaPurgePlan 单测。
// 被测是【纯函数】（零 prisma/网络/fs/env/随机），故不起临时库、不起 server、无动态 import。
// 设计权威：DESIGN-OFFLINE-SYNC §9.3/D2、§6.3——只算差集、不执行；结构永不擦、ghost 表不擦、
// 纯本地 base 不擦、link 跨表全局聚合。断言一律落到具体 id 与计数，不断言 truthy 了事。

import { describe, expect, it } from "vitest";
import {
  buildReplicaPurgePlan,
  shouldReconcileAuthz,
  uniqSorted,
  setDiffSorted,
  type LocalReplicaInventory,
  type LocalTableInventory,
  type LocalLinkInventory,
} from "../replicaPurgePlan.js";
import type { VisibilityReport, TableVisibilitySet } from "../visibility.js";

// ───────────────────────── fixtures ─────────────────────────

function vis(partial: Partial<TableVisibilitySet> & Pick<TableVisibilitySet, "tableId">): TableVisibilitySet {
  return {
    readable: true,
    visibleEntityIds: [],
    visibleFieldIds: null,
    ...partial,
  };
}

function report(baseId: string, authzVersion: number, tables: TableVisibilitySet[]): VisibilityReport {
  return { baseId, authzVersion, serverTime: "2026-10-20T00:00:00.000Z", tables };
}

function link(id: string, linkFieldId: string, parentRowId: string, childRowId: string): LocalLinkInventory {
  return { id, linkFieldId, parentRowId, childRowId };
}

function table(inv: LocalTableInventory): LocalTableInventory {
  return inv;
}

function inventory(baseId: string, tables: LocalTableInventory[], isLocalOnly = false): LocalReplicaInventory {
  return { baseId, isLocalOnly, tables };
}

const EMPTY_STATS = { tablesScanned: 0, recordsRemoved: 0, fieldKeysRemoved: 0, linksRemoved: 0 };

// ───────────────────────── 小纯函数 ─────────────────────────

describe("辅助纯函数 uniqSorted / setDiffSorted", () => {
  it("uniqSorted 去空、去重并按字典序", () => {
    expect(uniqSorted(["b", "", "a", "b", "a"])).toEqual(["a", "b"]);
    expect(uniqSorted([])).toEqual([]);
  });
  it("setDiffSorted 返回全集减去保留集（排序去重）", () => {
    expect(setDiffSorted(["a", "b", "c", "b"], new Set(["a"]))).toEqual(["b", "c"]);
    expect(setDiffSorted(["a"], new Set(["a", "x"]))).toEqual([]);
  });
});

describe("shouldReconcileAuthz 版本判定", () => {
  it("local null → 保守对账 true", () => {
    expect(shouldReconcileAuthz(null, 3)).toBe(true);
  });
  it("数字串相等 → false", () => {
    expect(shouldReconcileAuthz("3", 3)).toBe(false);
    expect(shouldReconcileAuthz(" 3 ", 3)).toBe(false);
  });
  it("数字串不同 → true", () => {
    expect(shouldReconcileAuthz("2", 3)).toBe(true);
    expect(shouldReconcileAuthz("10", 3)).toBe(true);
  });
  it("非数字脏串 → true（不因记账异常漏擦）", () => {
    expect(shouldReconcileAuthz("abc", 3)).toBe(true);
    expect(shouldReconcileAuthz("", 3)).toBe(true);
    expect(shouldReconcileAuthz("3x", 3)).toBe(true);
  });
});

// ───────────────────────── 12 类核心规则 ─────────────────────────

describe("① isLocalOnly=true：report 大面积收缩仍全空", () => {
  it("reason=skipped_local_only、triggered=false、零 removed/link/rescoped", () => {
    const inv = inventory("b1", [
      table({ tableId: "t1", liveRecordIds: ["r1", "r2"], recordFieldKeys: {}, links: [] }),
    ], true);
    const rep = report("b1", 9, [
      vis({ tableId: "t1", readable: false, visibleEntityIds: [], visibleFieldIds: [] }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });
    expect(plan.reason).toBe("skipped_local_only");
    expect(plan.triggered).toBe(false);
    expect(plan.removedRecordIds).toEqual([]);
    expect(plan.affectedLinkRowIds).toEqual([]);
    expect(plan.tables).toEqual([]);
    expect(plan.stats).toEqual(EMPTY_STATS);
  });
});

describe("② authzVersion 触发门", () => {
  const mkInv = () => inventory("b1", [
    table({ tableId: "t1", liveRecordIds: ["r1"], recordFieldKeys: { r1: ["f1"] }, links: [] }),
  ]);
  const mkReport = () => report("b1", 5, [
    vis({ tableId: "t1", readable: true, visibleEntityIds: [], visibleFieldIds: [] }),
  ]);

  it("相同版本 → identical_authz_version 空计划（即便实际有差集也不扫）", () => {
    const plan = buildReplicaPurgePlan({ report: mkReport(), inventory: mkInv(), localAuthzVersion: "5" });
    expect(plan.reason).toBe("identical_authz_version");
    expect(plan.triggered).toBe(false);
    expect(plan.removedRecordIds).toEqual([]);
    expect(plan.stats).toEqual(EMPTY_STATS);
  });
  it("local null / 数字串不同 / 非数字串 → 均触发", () => {
    for (const local of [null, "4", "weird"]) {
      const plan = buildReplicaPurgePlan({ report: mkReport(), inventory: mkInv(), localAuthzVersion: local });
      expect(plan.reason).toBe("ok");
      expect(plan.triggered).toBe(true);
      expect(plan.removedRecordIds).toEqual(["r1"]);
    }
  });
});

describe("③ readable:false 整表数据擦除但结构永不擦", () => {
  it("mode=table_data、全部活记录 removed、无 rescopedFields；计划中不含任何结构 id 位", () => {
    const inv = inventory("b1", [
      table({
        tableId: "t1",
        liveRecordIds: ["r1", "r2"],
        recordFieldKeys: { r1: ["f1"], r2: ["f1", "f2"] },
        links: [link("L1", "fLink", "r1", "r2")],
      }),
    ]);
    const rep = report("b1", 2, [
      vis({ tableId: "t1", readable: false, visibleEntityIds: [], visibleFieldIds: [] }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });

    expect(plan.triggered).toBe(true);
    expect(plan.tables).toHaveLength(1);
    const tp = plan.tables[0]!;
    expect(tp.mode).toBe("table_data");
    expect(tp.removedRecordIds).toEqual(["r1", "r2"]);
    expect(tp.rescopedFields).toEqual([]); // 整表数据没了，不单列字段
    expect(tp.affectedLinkRowIds).toEqual(["L1"]);
    expect(plan.removedRecordIds).toEqual(["r1", "r2"]);
    expect(plan.affectedLinkRowIds).toEqual(["L1"]);
    expect(plan.stats).toMatchObject({ tablesScanned: 1, recordsRemoved: 2, linksRemoved: 1 });
    // 结构永不擦：PurgePlan/TablePurge 上不存在 table/field/view 删除字段，只有数据 id。
    expect(Object.keys(plan).sort()).toEqual([
      "affectedLinkRowIds", "baseId", "localAuthzVersion", "reason", "removedRecordIds",
      "serverAuthzVersion", "skippedTablesNotOnServer", "stats", "tables", "triggered",
    ].sort());
    expect(Object.keys(tp).sort()).toEqual([
      "affectedLinkRowIds", "mode", "removedRecordIds", "rescopedFields", "tableId",
    ].sort());
  });
});

describe("④ readable:true 行级降权 + 墓碑不参与", () => {
  it("仅不可见的活记录 b removed；墓碑 id 不在 liveRecordIds 内故无影响", () => {
    // deleted record "rTomb" 刻意不进 liveRecordIds（它由 pull 墓碑通道管理）。
    const inv = inventory("b1", [
      table({
        tableId: "t1",
        liveRecordIds: ["a", "b", "c"],
        recordFieldKeys: { a: ["f1"], b: ["f1"], c: ["f1"], rTomb: ["f1"] },
        links: [],
      }),
    ]);
    const rep = report("b1", 2, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["a", "c"], visibleFieldIds: null }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });
    expect(plan.tables[0]!.mode).toBe("rows");
    expect(plan.removedRecordIds).toEqual(["b"]);
    expect(plan.stats.recordsRemoved).toBe(1);
    expect(plan.triggered).toBe(true);
  });
});

describe("⑤ 字段级降权精确到记录实际含有的 key", () => {
  it("record x 含 [f1,f2,f3] 仅留 f1 → RescopedField{x,[f2,f3]}；无该键记录不出条目；全可见零 rescoped", () => {
    const inv = inventory("b1", [
      table({
        tableId: "t1",
        liveRecordIds: ["x", "y", "z"],
        recordFieldKeys: {
          x: ["f1", "f2", "f3"],
          y: ["f1"], // 只含可见键 → 无差异
          z: ["f3", "f4"],
        },
        links: [],
      }),
    ]);
    const rep = report("b1", 2, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["x", "y", "z"], visibleFieldIds: ["f1"] }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });
    expect(plan.removedRecordIds).toEqual([]);
    expect(plan.tables[0]!.rescopedFields).toEqual([
      { tableId: "t1", recordId: "x", fieldIds: ["f2", "f3"] },
      { tableId: "t1", recordId: "z", fieldIds: ["f3", "f4"] },
    ]);
    expect(plan.stats.fieldKeysRemoved).toBe(4);
    expect(plan.triggered).toBe(true);

    // visibleFieldIds=null 全可见 → 零 rescoped、triggered=false。
    const repAll = report("b1", 3, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["x", "y", "z"], visibleFieldIds: null }),
    ]);
    const planAll = buildReplicaPurgePlan({ report: repAll, inventory: inv, localAuthzVersion: "2" });
    expect(planAll.tables[0]!.rescopedFields).toEqual([]);
    expect(planAll.triggered).toBe(false);
    expect(planAll.reason).toBe("ok");
  });
});

describe("⑥ 字段降权只作用于仍保留的记录", () => {
  it("被整表/行擦除的记录不出 rescopedFields，仅存活记录收敛字段", () => {
    const inv = inventory("b1", [
      table({
        // 行级降权：gone 不在可见行；survivor 保留但失 f2。
        tableId: "t1",
        liveRecordIds: ["gone", "survivor"],
        recordFieldKeys: { gone: ["f1", "f2", "f3"], survivor: ["f1", "f2"] },
        links: [],
      }),
    ]);
    const rep = report("b1", 2, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["survivor"], visibleFieldIds: ["f1"] }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });
    expect(plan.removedRecordIds).toEqual(["gone"]);
    expect(plan.tables[0]!.rescopedFields).toEqual([
      { tableId: "t1", recordId: "survivor", fieldIds: ["f2"] },
    ]);
    // gone 虽含 f2/f3，但已被擦，绝不重复计入字段收敛。
    expect(plan.stats).toMatchObject({ recordsRemoved: 1, fieldKeysRemoved: 1 });
  });
});

describe("⑦ fail-safe：ghost 表（本地有、report 无）绝不擦", () => {
  it("进 skippedTablesNotOnServer，其记录/字段/link 零擦除", () => {
    const inv = inventory("b1", [
      table({
        tableId: "tGhost",
        liveRecordIds: ["g1", "g2"],
        recordFieldKeys: { g1: ["f1"] },
        links: [link("Lg", "fLink", "g1", "g2")],
      }),
      table({ tableId: "tReal", liveRecordIds: ["k1"], recordFieldKeys: { k1: ["f1"] }, links: [] }),
    ]);
    const rep = report("b1", 2, [
      vis({ tableId: "tReal", readable: true, visibleEntityIds: ["k1"], visibleFieldIds: null }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });
    expect(plan.skippedTablesNotOnServer).toEqual(["tGhost"]);
    expect(plan.tables.map((t) => t.tableId)).toEqual(["tReal"]);
    expect(plan.removedRecordIds).toEqual([]);
    expect(plan.affectedLinkRowIds).toEqual([]); // ghost 表内部 link 两端都活，不受牵连
    expect(plan.triggered).toBe(false);
    expect(plan.reason).toBe("ok"); // 有交集表（tReal），只是零差异
    expect(plan.stats.tablesScanned).toBe(1); // ghost 不计扫描数
  });
});

describe("⑧ report 有表、本地无 → 无动作、不计数", () => {
  it("该表不产生 TablePurge，stats.tablesScanned=0、reason=empty", () => {
    const inv = inventory("b1", []);
    const rep = report("b1", 2, [
      vis({ tableId: "tRemote", readable: true, visibleEntityIds: ["x"], visibleFieldIds: null }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });
    expect(plan.tables).toEqual([]);
    expect(plan.skippedTablesNotOnServer).toEqual([]);
    expect(plan.stats).toEqual(EMPTY_STATS);
    expect(plan.reason).toBe("empty");
    expect(plan.triggered).toBe(false);
  });
});

describe("⑨ link 跨表全局聚合（含 ghost 表 link 连被擦端）", () => {
  it("t1 记录被擦且 link 连 t2 活记录 → 列入；两端都活 → 不列；ghost 表 link 连被擦记录 → 列入但 ghost 数据不动", () => {
    const inv = inventory("b1", [
      table({
        // t1 行级降权：p1 被擦，p2 保留。
        tableId: "t1",
        liveRecordIds: ["p1", "p2"],
        recordFieldKeys: { p1: ["f1"], p2: ["f1"] },
        links: [
          link("Lcross", "fLink", "p1", "c1"), // 跨表连 t2 活记录 c1 → 受牵连
          link("Llive", "fLink", "p2", "c2"),  // 两端都活 → 不列
        ],
      }),
      table({
        tableId: "t2",
        liveRecordIds: ["c1", "c2"],
        recordFieldKeys: { c1: ["f1"], c2: ["f1"] },
        links: [],
      }),
      table({
        // ghost 表本身不擦，但它的 link 连到 t1 将被擦的 p1 → 必须列出。
        tableId: "tGhost",
        liveRecordIds: ["gh1"],
        recordFieldKeys: { gh1: ["f1"] },
        links: [link("Lghost", "fG", "gh1", "p1")],
      }),
    ]);
    const rep = report("b1", 2, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["p2"], visibleFieldIds: null }),
      vis({ tableId: "t2", readable: true, visibleEntityIds: ["c1", "c2"], visibleFieldIds: null }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "1" });

    expect(plan.removedRecordIds).toEqual(["p1"]);
    expect(plan.affectedLinkRowIds).toEqual(["Lcross", "Lghost"]);
    expect(plan.stats).toMatchObject({ tablesScanned: 2, recordsRemoved: 1, linksRemoved: 2 });
    // ghost 表数据零动作。
    expect(plan.skippedTablesNotOnServer).toEqual(["tGhost"]);
    const ghostPurge = plan.tables.find((t) => t.tableId === "tGhost");
    expect(ghostPurge).toBeUndefined();
    // Lcross 的 per-table 视图落在持有它的 t1 上；Lghost 不属于任何 TablePurge（其主表是 ghost）。
    expect(plan.tables.find((t) => t.tableId === "t1")!.affectedLinkRowIds).toEqual(["Lcross"]);
  });
});

describe("⑩ 确定性/幂等/可序列化", () => {
  it("同输入两次 deepEqual；id 数组排序去重；JSON 往返无 BigInt", () => {
    const inv = inventory("b1", [
      table({
        tableId: "t1",
        liveRecordIds: ["z", "a", "m", "a"],
        recordFieldKeys: { z: ["f2", "f1"], a: ["f9"], m: ["f1"] },
        // L2/L1 都连到被擦记录（z/m）；L2 重复一次验证去重，输出须排序为 [L1,L2]。
        links: [link("L2", "f", "z", "x"), link("L1", "f", "m", "y"), link("L2", "f", "z", "x")],
      }),
    ]);
    const rep = report("b1", 7, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["a"], visibleFieldIds: ["f1"] }),
    ]);
    const p1 = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "6" });
    const p2 = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "6" });
    expect(p1).toEqual(p2);
    expect(p1.removedRecordIds).toEqual(["m", "z"]); // 去重 + 字典序
    expect(p1.affectedLinkRowIds).toEqual(["L1", "L2"]);
    // 全计划可 JSON 往返且逐字节一致（无 BigInt/Set/Map/undefined）。
    expect(JSON.parse(JSON.stringify(p1))).toEqual(p1);
  });
});

describe("⑪ 收敛性：按计划执行后再算一次 → 空计划", () => {
  it("删除 removed 记录、抹掉 rescoped keys、移除 links 后，对同一 report 零差集", () => {
    const inv = inventory("b1", [
      table({
        tableId: "t1",
        liveRecordIds: ["keep", "gone1", "gone2"],
        recordFieldKeys: { keep: ["f1", "f2"], gone1: ["f1"], gone2: ["f1", "f3"] },
        links: [link("Lgone", "f", "gone1", "keep")],
      }),
      table({
        tableId: "t2",
        liveRecordIds: ["c1"],
        recordFieldKeys: { c1: ["f1"] },
        links: [link("Lok", "f", "c1", "keep")],
      }),
    ]);
    const rep = report("b1", 3, [
      vis({ tableId: "t1", readable: true, visibleEntityIds: ["keep"], visibleFieldIds: ["f1"] }),
      vis({ tableId: "t2", readable: true, visibleEntityIds: ["c1"], visibleFieldIds: null }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "2" });
    expect(plan.triggered).toBe(true);

    // 模拟「执行器按计划作用后」的新本地清单：
    const removed = new Set(plan.removedRecordIds);
    const removedLinks = new Set(plan.affectedLinkRowIds);
    const fieldScrub = new Map(plan.tables.flatMap((t) =>
      t.rescopedFields.map((r) => [`${r.tableId}/${r.recordId}`, new Set(r.fieldIds)] as const)));

    const afterTables: LocalTableInventory[] = inv.tables.map((t) => {
      const survivors = t.liveRecordIds.filter((id) => !removed.has(id));
      const nextKeys: Record<string, string[]> = {};
      for (const id of survivors) {
        const drop = fieldScrub.get(`${t.tableId}/${id}`);
        const keys = (t.recordFieldKeys[id] ?? []).filter((k) => !drop?.has(k));
        if (keys.length > 0) nextKeys[id] = keys;
      }
      return {
        tableId: t.tableId,
        liveRecordIds: survivors,
        recordFieldKeys: nextKeys,
        links: t.links.filter((l) => !removedLinks.has(l.id)),
      };
    });
    const afterInv = inventory("b1", afterTables);
    // 执行后本地已对齐 report：版本是否相同不影响——这里用「仍不同」版本证明差集本身为空，
    // 而非被 authz 门短路；故临时给一个可触发的版本对。
    const plan2 = buildReplicaPurgePlan({ report: rep, inventory: afterInv, localAuthzVersion: "2" });
    expect(plan2.triggered).toBe(false);
    expect(plan2.removedRecordIds).toEqual([]);
    expect(plan2.affectedLinkRowIds).toEqual([]);
    expect(plan2.tables.every((t) => t.rescopedFields.length === 0)).toBe(true);
    expect(plan2.reason).toBe("ok");
  });
});

describe("⑫ 空 inventory / 空 report / 多表混合综合", () => {
  it("空 inventory+空 report → empty；多表混合 stats 与顶层数组精确", () => {
    // 空 inventory + 空 report
    const emptyPlan = buildReplicaPurgePlan({
      report: report("b1", 1, []),
      inventory: inventory("b1", []),
      localAuthzVersion: null,
    });
    expect(emptyPlan.reason).toBe("empty");
    expect(emptyPlan.triggered).toBe(false);
    expect(emptyPlan.stats).toEqual(EMPTY_STATS);

    // 混合：tData=table_data(2 行)、tRows=rows(擦 1 行 + 1 条字段收敛)、tAll=全可见零差异、tGhost=ghost
    const inv = inventory("b1", [
      table({
        tableId: "tData",
        liveRecordIds: ["d1", "d2"],
        recordFieldKeys: { d1: ["f1"], d2: ["f1"] },
        links: [link("Ld", "f", "d1", "x1")], // 连到 tRows 将被擦的 x1 → 也列入
      }),
      table({
        tableId: "tRows",
        liveRecordIds: ["x1", "x2"],
        recordFieldKeys: { x1: ["f1"], x2: ["f1", "f2"] },
        links: [link("Lx", "f", "x1", "x2")],
      }),
      table({
        tableId: "tAll",
        liveRecordIds: ["a1"],
        recordFieldKeys: { a1: ["f1"] },
        links: [],
      }),
      table({
        tableId: "tGhost",
        liveRecordIds: ["gh1"],
        recordFieldKeys: { gh1: ["f1"] },
        links: [],
      }),
    ]);
    const rep = report("b1", 4, [
      vis({ tableId: "tData", readable: false, visibleEntityIds: [], visibleFieldIds: [] }),
      vis({ tableId: "tRows", readable: true, visibleEntityIds: ["x2"], visibleFieldIds: ["f1"] }),
      vis({ tableId: "tAll", readable: true, visibleEntityIds: ["a1"], visibleFieldIds: null }),
    ]);
    const plan = buildReplicaPurgePlan({ report: rep, inventory: inv, localAuthzVersion: "3" });

    expect(plan.skippedTablesNotOnServer).toEqual(["tGhost"]);
    expect(plan.tables.map((t) => t.tableId)).toEqual(["tData", "tRows", "tAll"]);
    expect(plan.tables.map((t) => t.mode)).toEqual(["table_data", "rows", "rows"]);
    expect(plan.removedRecordIds).toEqual(["d1", "d2", "x1"]);
    expect(plan.affectedLinkRowIds).toEqual(["Ld", "Lx"]);
    expect(plan.tables.find((t) => t.tableId === "tRows")!.rescopedFields).toEqual([
      { tableId: "tRows", recordId: "x2", fieldIds: ["f2"] },
    ]);
    expect(plan.stats).toEqual({
      tablesScanned: 3, recordsRemoved: 3, fieldKeysRemoved: 1, linksRemoved: 2,
    });
    expect(plan.triggered).toBe(true);
    expect(plan.reason).toBe("ok");
  });
});
