// beta.2 S4b：失权擦除链路的【只读取数层】（DESIGN-OFFLINE-SYNC §9.3 + 决策 D2 的「本地有什么」半边）。
//
// 它把一个本地副本 base 在库里的现状投影成 S4a 计划层消费的 LocalReplicaInventory：
//   readReplicaInventoryTx 在【调用方给定的单个事务 tx】内只读完成，自身绝不 import 全局 prisma、
//   绝不开新事务、绝不写任何表、不发网络、不读文件/env、不碰 Date.now/随机。执行器（真正按计划
//   删除）与「visibility 拉取 → 计划 → 执行」的触发接线都是后续刀，本刀不做；合入后本模块不被
//   任何 src 生产代码 import，唯一引用方是其单测，生产运行路径零行为变化。
//
// 取数口径（与 schema 落库事实对齐）：
//   - 纯本地判定 D2：replica_state 无 (nodeId, remoteBaseId=localBaseId) 行 → isLocalOnly=true，
//     纯本地 base 永不擦（S4a 计划层也会再短路一次，这里如实报身份）。
//   - 只数活表（tables.deletedAt=null）、活记录（records.deletedAt=null）；墓碑由 pull 通道管，
//     绝不进差集。
//   - recordFieldKeys 只取 records.fields JSON【自身可枚举 key】（=fieldId），不 join field 表——
//     fields 是自由 JSON，可能含 field 表已不存在的 key，照实报给计划层。
//   - link_rows 无 tableId 且可跨表：按 parentRowId 反查活记录的 tableId 归表（=正向关联字段所在
//     表）；parent 不在本 base 活记录集的 link（孤儿/跨 base）丢弃；childRowId 可指向别的表，原样
//     保留 id 不过滤（S4a 全局聚合按两端记录是否被擦决定）。软删 link 不读。
//   - 确定性：tables 按 tableId 字典序；liveRecordIds、每条 recordFieldKeys、每表 links(按 id) 全部
//     去重 + 字典序；出参全 JSON 可序列化（Map/Set 仅内部计算，不外露；无 BigInt/Date）。
//   - 坏 fields（空串/null/非法 JSON）：该记录 key 集按 [] 处理，try/catch 吞解析错，绝不让一条坏
//     数据中断整份清单（宁可少报字段 key，计划层宁残留不误擦）。

import type { DbTx } from "../../db.js";
import type { LocalReplicaInventory, LocalTableInventory, LocalLinkInventory } from "./replicaPurgePlan.js";

export interface ReadReplicaInventoryInput {
  nodeId: string;
  /** 本地承载 base 的 id（副本保 id 直插，localBaseId===remoteBaseId）。 */
  localBaseId: string;
}

/** 去重 + 字典序（出参确定性的唯一收口）。 */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((s) => s.length > 0).sort();
}

/**
 * 安全解析 records.fields：只取自身可枚举 key；空串/null/非对象/非法 JSON 一律回空数组，不抛错。
 */
function extractFieldKeys(rawFields: string | null | undefined): string[] {
  if (typeof rawFields !== "string" || rawFields.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFields);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return sortedUnique(Object.keys(parsed as Record<string, unknown>));
}

/**
 * 在调用方事务内只读投影一个副本 base 的本地清单。
 * 三次 findMany（活表 / 活记录 / 全部活 link_row）+ 内存 join，无 N+1。
 */
export async function readReplicaInventoryTx(
  tx: DbTx,
  input: ReadReplicaInventoryInput,
): Promise<LocalReplicaInventory> {
  const { nodeId, localBaseId } = input;

  // ① 纯本地判定：有 replica_state 行＝远端副本；无行＝纯本地（D2 纵深防御）。
  const stateRow = await tx.replicaState.findUnique({
    where: { nodeId_remoteBaseId: { nodeId, remoteBaseId: localBaseId } },
    select: { id: true },
  });
  const isLocalOnly = stateRow === null;

  // ② 活表（id 升序作为辅助稳定；最终出参再按 tableId 排序收口）。
  const tableRows = await tx.table.findMany({
    where: { baseId: localBaseId, deletedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const tableIds = tableRows.map((t) => t.id);

  // 预登记每张表的累加器（即使该表无活记录也出现在 tables 中，结构在但数据为空）。
  const byTable = new Map<string, {
    tableId: string;
    liveRecordIds: Set<string>;
    recordFieldKeys: Record<string, string[]>;
    links: LocalLinkInventory[];
  }>();
  for (const tableId of tableIds) {
    byTable.set(tableId, { tableId, liveRecordIds: new Set(), recordFieldKeys: {}, links: [] });
  }

  // parentRowId → tableId（仅本 base 活记录），供 link 归表。
  const recordTable = new Map<string, string>();

  if (tableIds.length > 0) {
    // ③ 这些表的全部活记录（一次查回，内存分表；不按表 N 次查）。
    const recordRows = await tx.record.findMany({
      where: { tableId: { in: tableIds }, deletedAt: null },
      select: { id: true, tableId: true, fields: true },
    });
    for (const r of recordRows) {
      const acc = byTable.get(r.tableId);
      if (!acc) continue; // 理论不可达（where 已限活表），防御性跳过。
      acc.liveRecordIds.add(r.id);
      acc.recordFieldKeys[r.id] = extractFieldKeys(r.fields);
      recordTable.set(r.id, r.tableId);
    }

    // ④ 全部活 link_row（一次查回）；仅保留 parent 落在本 base 活记录集的，按 parent 所在表归表。
    //    不按 tableId 过滤——link_row 无该列，且 child 可跨表；全局扫描量级与副本 link 总量同级。
    const linkRows = await tx.linkRow.findMany({
      where: { deletedAt: null },
      select: { id: true, linkFieldId: true, parentRowId: true, childRowId: true },
    });
    for (const l of linkRows) {
      const ownerTableId = recordTable.get(l.parentRowId);
      if (!ownerTableId) continue; // 孤儿 / parent 非本 base 活记录 → 不计入本清单。
      byTable.get(ownerTableId)!.links.push({
        id: l.id,
        linkFieldId: l.linkFieldId,
        parentRowId: l.parentRowId,
        childRowId: l.childRowId,
      });
    }
  }

  // ⑤ 组装确定性出参（tables 按 tableId 字典序；内部各 id/key/link 排序；普通对象/数组，无 Map/Set）。
  const tables: LocalTableInventory[] = [...byTable.keys()].sort().map((tableId) => {
    const acc = byTable.get(tableId)!;
    return {
      tableId,
      liveRecordIds: sortedUnique(acc.liveRecordIds),
      recordFieldKeys: Object.fromEntries(
        Object.entries(acc.recordFieldKeys)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([recordId, keys]) => [recordId, sortedUnique(keys)]),
      ),
      links: [...acc.links]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  });

  return { baseId: localBaseId, isLocalOnly, tables };
}
