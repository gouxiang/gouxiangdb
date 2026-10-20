// beta.2 S4a：失权后副本可见集收缩的【纯擦除计划层】（DESIGN-OFFLINE-SYNC §9.3 + 决策 D2、§6.3）。
//
// 本文件只做一件事：拿「服务端按当前权限收敛的可见集」（VisibilityReport，GET /visibility）与
// 「调用方传入的本地副本清单」（LocalReplicaInventory）做差集，产出一份确定性的 PurgePlan。
// 它【只算、绝不执行】——不删 record、不改 fields JSON、不软 link_row、不写游标；真正的执行器/
// 接线是未来另一刀。合入后本模块不被任何 src 生产代码 import（唯一引用方是其单测），生产运行
// 路径零行为变化。
//
// 零 IO 纪律：不 import ../../db.js（无 prisma）、不发网络、不读文件、不读 env、不碰
// Date.now/Math.random —— 同样输入必得逐字节一致的计划（可重复、可 JSON 序列化、可审计重放）。
// 本地清单由调用方在别处读库后以参数传入。
//
// 四条不可违背的安全规则（最高约束：不破坏真实数据，宁残留不误删）：
//  1) 结构永不擦：table/field/view 等结构绝不出现在计划里。对称事实来自 bootstrap.ts——
//     tableReadable=false 的表基线引导时【仍保留 table/field/view 结构、只跳过 records/links】，
//     pull 也照常收结构增量；若擦了结构，重新授权后补不回。故 readable:false 只清表内数据。
//  2) ghost 表不擦：本地有、report.tables 完全没返回的表进 skippedTablesNotOnServer，不产生任何
//     removed/rescoped/link 动作（可能表已删或两端口径不一致，fail-safe 宁残留）。
//  3) 纯本地 base 不擦：inventory.isLocalOnly 恒短路为空计划（D2 纵深防御）。
//  4) link 跨表全局聚合：link_row 可跨表，affectedLinkRowIds 在【全部 inventory 表】上按
//     parent/child 是否落入全局被擦 record 集判定，包括 ghost 表自身的 link（只列 link id，
//     绝不动 ghost 表数据）。
//
// 不在本刀范围：附件/uploads 缓存擦除（另一轨）、加密镜像整节点销毁（403 分支）、墓碑记录
// （deletedAt 非空由 pull 管，liveRecordIds 只含活记录，墓碑不进任何差集）。

import type { VisibilityReport, TableVisibilitySet } from "./visibility.js";

// ───────────────────────── 本地清单（调用方读库后传入） ─────────────────────────

/** 本地一条 link_row 的最小投影（id + 两端活记录 id + 所属正向关联字段）。 */
export interface LocalLinkInventory {
  id: string;
  linkFieldId: string;
  parentRowId: string;
  childRowId: string;
}

/** 本地一张表参与差集所需的清单（只含活记录；墓碑不进差集）。 */
export interface LocalTableInventory {
  tableId: string;
  /** 仅活记录（records.deletedAt=null）id；软删墓碑由 pull 通道管理，绝不列入。 */
  liveRecordIds: string[];
  /**
   * 仅活记录：每条记录当前 records.fields JSON 里【实际存在】的 fieldId key。
   * 字段级擦除据此精确到「该记录真正含有的 key」，执行器无需重写不含该键的记录。
   */
  recordFieldKeys: Record<string, string[]>;
  /** 本表全部 link_row（含跨表指向；用于全局 affectedLinkRowIds 聚合）。 */
  links: LocalLinkInventory[];
}

/** 本地某个副本 base 的清单。 */
export interface LocalReplicaInventory {
  baseId: string;
  /** 纯本地 base（从未与权威端同步）→ 任何计划都不得擦它（D2）。 */
  isLocalOnly: boolean;
  /** 本地记得的最近一次 authzVersion（replica_state.authzVersion 字符串；无则 null）。 */
  tables: LocalTableInventory[];
}

// ───────────────────────── 计划（全部 JSON 可序列化：无 BigInt/Set/Map） ─────────────────────────

/** 单条记录的字段级收敛：fieldIds 为应从该记录 fields JSON 抹除的 key（去重 + 字典序）。 */
export interface RescopedField {
  tableId: string;
  recordId: string;
  fieldIds: string[];
}

/** 单表擦除计划。 */
export interface TablePurge {
  tableId: string;
  /** table_data＝表级失权清全部活记录（结构保留）；rows＝仅行级/字段级差集。 */
  mode: "table_data" | "rows";
  /** 本表应擦除的活记录 id（去重 + 字典序）。 */
  removedRecordIds: string[];
  /** 字段值应收敛的记录条目（空数组表示无字段级动作）。 */
  rescopedFields: RescopedField[];
  /**
   * 本表 links 中受【全局】被擦记录牵连的 link_row id（跨表合并在顶层再聚合一次；
   * 这里保留 per-table 视图便于审计定位该 link 属于哪张表的字段）。
   */
  affectedLinkRowIds: string[];
}

export type PurgeReason = "ok" | "skipped_local_only" | "identical_authz_version" | "empty";

export interface PurgePlan {
  /** 以本地清单视角的 baseId（report.baseId 不一致时也不抛错，见 buildReplicaPurgePlan）。 */
  baseId: string;
  /** 是否确有差集需要执行（records/fieldKeys/links 任一 >0）。 */
  triggered: boolean;
  reason: PurgeReason;
  serverAuthzVersion: number;
  localAuthzVersion: string | null;
  /** 交集表（本地与 report 都有）的逐表计划。 */
  tables: TablePurge[];
  /** 跨表去重排序后的全部被擦活记录 id。 */
  removedRecordIds: string[];
  /** 全局聚合的受牵连 link_row id（去重排序）。 */
  affectedLinkRowIds: string[];
  /** 本地有、report 未返回的表（fail-safe 跳过、绝不擦）。 */
  skippedTablesNotOnServer: string[];
  stats: {
    /** 交集表数量（真正参与差集扫描的表）。 */
    tablesScanned: number;
    recordsRemoved: number;
    fieldKeysRemoved: number;
    linksRemoved: number;
  };
}

export interface BuildPurgePlanInput {
  report: VisibilityReport;
  inventory: LocalReplicaInventory;
  /** 本地 replica_state.authzVersion（字符串）；null＝从未记过版本。 */
  localAuthzVersion: string | null;
}

// ───────────────────────── 小纯函数（导出便于单测） ─────────────────────────

/** 去空、去重并按字典序排序（所有出参 id 数组确定性的唯一收口）。 */
export function uniqSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((s) => s.length > 0).sort();
}

/** 全集 universe 中不在 keep 集内的元素（去重排序）。 */
export function setDiffSorted(universe: Iterable<string>, keep: ReadonlySet<string>): string[] {
  return uniqSorted([...universe].filter((x) => !keep.has(x)));
}

/**
 * 是否需要按新可见集对账：
 *  - local null（从未记版本）→ true（保守对账一次）；
 *  - local 非负整数串且与 server 数值相等 → false（权限版本未变，零差集也不扫）；
 *  - local 可解析但数值不同 → true；
 *  - local 为非数字串（脏值/老数据）→ true（保守对账，不因记账异常而漏擦失权数据）。
 */
export function shouldReconcileAuthz(localAuthzVersion: string | null, serverAuthzVersion: number): boolean {
  if (localAuthzVersion === null) return true;
  const t = localAuthzVersion.trim();
  if (!/^\d+$/.test(t)) return true;
  return Number.parseInt(t, 10) !== serverAuthzVersion;
}

function emptyPlan(
  inventory: LocalReplicaInventory,
  report: VisibilityReport,
  localAuthzVersion: string | null,
  reason: PurgeReason,
): PurgePlan {
  return {
    // 始终以本地清单视角标 baseId：report 若属于别的 base，交集自然为空（见 buildReplicaPurgePlan）。
    baseId: inventory.baseId,
    triggered: false,
    reason,
    serverAuthzVersion: report.authzVersion,
    localAuthzVersion,
    tables: [],
    removedRecordIds: [],
    affectedLinkRowIds: [],
    skippedTablesNotOnServer: [],
    stats: { tablesScanned: 0, recordsRemoved: 0, fieldKeysRemoved: 0, linksRemoved: 0 },
  };
}

/**
 * 计算失权擦除计划（纯函数）。不执行任何删除；同输入同输出；出参全 JSON 可序列化。
 */
export function buildReplicaPurgePlan(input: BuildPurgePlanInput): PurgePlan {
  const { report, inventory, localAuthzVersion } = input;

  // 安全规则 3：纯本地 base 纵深防御短路，report 收缩得再狠也不擦。
  if (inventory.isLocalOnly) {
    return emptyPlan(inventory, report, localAuthzVersion, "skipped_local_only");
  }
  // authzVersion 未变：不扫差集（§9.3 触发条件）。
  if (!shouldReconcileAuthz(localAuthzVersion, report.authzVersion)) {
    return emptyPlan(inventory, report, localAuthzVersion, "identical_authz_version");
  }

  // report.tables 建索引；注意 report.baseId 若与 inventory.baseId 不一致，这里不抛错——
  // 交集按 tableId 计算（见下），错配 report 通常与本地表 id 不相交 → 全部落 ghost/无差集。
  const serverTables = new Map<string, TableVisibilitySet>();
  for (const t of report.tables) serverTables.set(t.tableId, t);

  const ghost: string[] = [];
  const tablePurges: TablePurge[] = [];
  // 全局被擦活记录集（跨表；link 聚合与顶层汇总都以它为准）。
  const globalRemoved = new Set<string>();
  let fieldKeysRemoved = 0;

  // 只遍历【本地】表：report 有、本地无的表无需任何动作（本地无数据可擦），也不计 tablesScanned。
  for (const local of inventory.tables) {
    const vis = serverTables.get(local.tableId);

    // 安全规则 2：ghost 表（report 未返回）跳过一切数据动作；其 links 仍在末尾参与全局聚合。
    if (!vis) {
      ghost.push(local.tableId);
      continue;
    }

    const removed: string[] = [];
    const rescopedFields: RescopedField[] = [];

    if (!vis.readable) {
      // 安全规则 1：表级失权只清【数据】——全部活记录进 removed，结构（table/field/view）永不擦；
      // 整表数据都将不存在，字段级收敛无意义，rescopedFields 留空。
      for (const id of uniqSorted(local.liveRecordIds)) {
        removed.push(id);
        globalRemoved.add(id);
      }
    } else {
      // 行级降权：本地活记录不在服务端可见集内 → 擦。
      const visibleRows = new Set(vis.visibleEntityIds);
      for (const id of setDiffSorted(local.liveRecordIds, visibleRows)) {
        removed.push(id);
        globalRemoved.add(id);
      }
      // 字段级降权：只对【仍保留】的活记录收敛（被擦记录无需重写 fields）。
      if (vis.visibleFieldIds !== null) {
        const visibleFields = new Set(vis.visibleFieldIds);
        // 记录处理顺序按 liveRecordIds 去重排序，保证 RescopedField 条目顺序确定。
        for (const recordId of uniqSorted(local.liveRecordIds)) {
          if (globalRemoved.has(recordId)) continue;
          const keys = local.recordFieldKeys[recordId];
          if (!keys) continue;
          const hiddenKeys = setDiffSorted(keys, visibleFields);
          if (hiddenKeys.length > 0) {
            rescopedFields.push({ tableId: local.tableId, recordId, fieldIds: hiddenKeys });
            fieldKeysRemoved += hiddenKeys.length;
          }
        }
      }
    }

    tablePurges.push({
      tableId: local.tableId,
      mode: vis.readable ? "rows" : "table_data",
      removedRecordIds: uniqSorted(removed),
      rescopedFields,
      // per-table 视图先占位；全局 link 聚合在所有表算完后统一回填（link 可跨表）。
      affectedLinkRowIds: [],
    });
  }

  // 安全规则 4：在【全部 inventory 表】（含 ghost 表）的 links 上做全局聚合——link_row 可跨表，
  // 任一端记录被擦即应列出该 link；ghost 表本身数据不动，但其 link 若连着被擦记录也要列出。
  const linkOwner = new Map<string, string>(); // linkId → 首个持有它的 tableId（per-table 回填用）
  const globalAffected = new Set<string>();
  for (const local of inventory.tables) {
    for (const link of local.links) {
      if (!linkOwner.has(link.id)) linkOwner.set(link.id, local.tableId);
      if (globalRemoved.has(link.parentRowId) || globalRemoved.has(link.childRowId)) {
        globalAffected.add(link.id);
      }
    }
  }
  for (const purge of tablePurges) {
    purge.affectedLinkRowIds = uniqSorted(
      [...globalAffected].filter((id) => linkOwner.get(id) === purge.tableId),
    );
  }

  const removedRecordIds = uniqSorted(globalRemoved);
  const affectedLinkRowIds = uniqSorted(globalAffected);
  const triggered = removedRecordIds.length > 0 || fieldKeysRemoved > 0 || affectedLinkRowIds.length > 0;

  return {
    baseId: inventory.baseId,
    triggered,
    // 有交集表但零差异 → ok；一张交集表都没有（空库存/全 ghost/base 错配）→ empty。
    reason: tablePurges.length === 0 ? "empty" : "ok",
    serverAuthzVersion: report.authzVersion,
    localAuthzVersion,
    tables: tablePurges,
    removedRecordIds,
    affectedLinkRowIds,
    skippedTablesNotOnServer: uniqSorted(ghost),
    stats: {
      tablesScanned: tablePurges.length,
      recordsRemoved: removedRecordIds.length,
      fieldKeysRemoved,
      linksRemoved: affectedLinkRowIds.length,
    },
  };
}
