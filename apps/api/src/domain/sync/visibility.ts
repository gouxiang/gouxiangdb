// YN5 失权对账可见集（GET /visibility）：服务端只给【按当前权限收敛】的可见集 + authzVersion，
// 差集（要擦什么）由 Mac 侧车拿它与本地副本对比得出（§9.3「重连发现 authzVersion 变化 → 受限重
// 快照，把不再可见的 record/字段从本地副本删除」）。
//
// 为什么服务端不算 removedEntityIds：服务端不持有"某客户端本地副本里有什么"的状态，真正的差集只
// 能在侧车（它有 replica_state + 本地库）对比得出。服务端的职责是给出权威、实时、已收敛的可见集，
// 且口径必须与 snapshot/pull【完全一致】——故逐表复用 buildTableVisibility（fieldScope → mask →
// queryRecords(rowFilter) → stripHidden），绝不另写一套裁剪，避免擦错/擦漏真实数据（最高硬约束）。
//
// 与 snapshot 的区别：snapshot 回记录【字段值】（初次填充副本用）；visibility 只回【id 集 + 字段 id
// 集 + 版本戳】，载荷小、专供周期性/重连对账，不回任何字段值明文（失权主体本就不该再收字段值）。

import { prisma } from "../../db.js";
import { authorizeBaseRead, buildTableVisibility, readAuthzVersion } from "./snapshot.js";

export interface TableVisibilitySet {
  tableId: string;
  /** 表级 r 是否仍可见；false 时该表整张在本地应被擦除（侧车据表 id 集对比）。 */
  readable: boolean;
  /** 当前可见【活记录】id 集；本地有、此集无的活记录即应擦除（墓碑由 pull 单独同步）。 */
  visibleEntityIds: string[];
  /**
   * null＝字段不裁剪（全可见）；否则为当前可见字段 id 集，本地有、此集无的字段值应被擦除。
   */
  visibleFieldIds: string[] | null;
}

export interface VisibilityReport {
  baseId: string;
  /** workspaces.policyVersion；与上次对账不同才需侧车做差集擦除（§9.3 触发条件）。 */
  authzVersion: number;
  serverTime: string;
  tables: TableVisibilitySet[];
}

/**
 * 取某 base 对当前主体【此刻】的收敛可见集（遍历全部未删表，逐表走与列表/快照同管线）。
 * 库门 enter 不过（被移出 base/组织）→ authorizeBaseRead 抛 403；侧车收到 403 走"整节点失权＝
 * 销毁加密镜像"分支（§9.3/§18.3），本函数无需在那情况下返回部分集。
 */
export async function buildVisibilityReport(
  userId: string,
  baseId: string,
): Promise<VisibilityReport> {
  const access = await authorizeBaseRead(userId, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const out: TableVisibilitySet[] = [];
  for (const { id: tableId } of tables) {
    // 与 snapshot/pull 同源；每表只查一次。
    const vis = await buildTableVisibility(userId, access, tableId);
    if (!vis.tableReadable) {
      out.push({ tableId, readable: false, visibleEntityIds: [], visibleFieldIds: [] });
      continue;
    }
    out.push({
      tableId,
      readable: true,
      visibleEntityIds: vis.records.map((r) => r.id),
      visibleFieldIds: vis.visibleFieldIds === null ? null : [...vis.visibleFieldIds],
    });
  }

  const authzVersion = await readAuthzVersion();
  return { baseId, authzVersion, serverTime: new Date().toISOString(), tables: out };
}
