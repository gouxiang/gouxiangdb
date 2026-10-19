// beta.2 S3b-1：空副本「下行引导基线」只读投影（replica bootstrap baseline）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §6（基线引导）；修正蓝图 S3「仅 snapshot+pull 即可引导空副本」
// 的假设——老库的表/字段/视图结构历史不在 oplog（oplog 只记开启同步捕获之后的结构改动），而
// GET /snapshot 只投影活记录、不含结构；逐 op 合成 create_table/add_field 又会让结构 cuid/主字段/
// 关联配对与权威端错位。故新增本只读端点：一次性下发 anchorSeq 时刻的【完整活结构（保留 cuid）】
// + 按【当前权限】裁剪的活记录 + 两端均可见的活 link_rows，供 S3b-2 本地空副本幂等直插。
//
// 纯只读铁律：本函数只有 findMany/findUnique/aggregate/count，绝无 create/update/updateMany/
// upsert/delete；不 markSnapshotDone、不推进 sync_subscription、不写 local_outbox/replica_state。
//
// 一致性/游标语义：函数开头【先】读 anchorSeq = sync_op_log.seq 的全局最大值，再读结构/数据。
// 它是 S3b-2 之后 pull(after=anchorSeq) 的增量起点。本刀【不】处理「anchor 之后、各表读取之前」
// 的并发写窗口（非单事务快照）：该窗口内的改动可能半入本基线，S3b-2 本地按 cuid 幂等 upsert +
// 随后 pull 增量对账兜重复/补缺（见 S3b-2 设计），故不要求此处线性一致。
//
// 权限口径（全部复用 snapshot 同一管线，禁止另写一套）：
//   - authorizeBaseRead：库门 enter，不过 403；进得去库即可见库【结构】（与 pull 结构轨同口径，
//     即使某表 tableReadable=false，该表 table/field/view 结构仍全量下发，只跳过其 records/links）。
//   - buildTableVisibility / visibleIdSet：逐表当前 r/行条件/字段掩码裁剪后的活记录与可见 id 集。

import { prisma } from "../../db.js";
import {
  authorizeBaseRead,
  buildTableVisibility,
  visibleIdSet,
  readAuthzVersion,
} from "./snapshot.js";

/** 与 buildBaseSnapshot 同钳制：默认 5000、硬上限 20000；只作用于 records 总数。 */
const DEFAULT_RECORD_LIMIT = 5000;
const HARD_RECORD_LIMIT = 20000;
// 注：bootstrap 分页正式化（游标续拉 records/links）属后续切片；本刀 limit 仅截断 records。

export interface BootstrapBase {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string;
  shareEnabled: number;
}
export interface BootstrapTable {
  id: string;
  name: string;
  primaryFieldId: string;
  icon: string | null;
  iconColor: string | null;
  shareEnabled: number;
}
export interface BootstrapField {
  id: string;
  tableId: string;
  name: string;
  type: string;
  description: string;
  order: number;
  required: boolean;
  unique: boolean;
  options: string | null; // 原样字符串，不二次解析
  maxLength: number | null;
  defaultNow: boolean;
  precision: number | null;
  recordFilter: string | null;
  linkFieldId: string | null;
  relatedTableId: string | null;
  relationKind: string | null;
  isReverse: boolean;
  reverseFieldId: string | null;
  linkDisplayFieldId: string | null;
  lookupFieldId: string | null;
  rollupFunction: string | null;
  formula: string | null;
  tabsConfig: string | null;
  displayedFieldIds: string | null;
  visibleFieldIds: string | null;
  defaultConfig: string | null;
  numberRule: string | null;
}
export interface BootstrapView {
  id: string;
  tableId: string;
  name: string;
  type: string;
  lockMode: string;
  order: number;
  config: string;
  adminConfig: string | null;
}
export interface BootstrapRecord {
  id: string;
  tableId: string;
  /** 已按当前字段权限裁剪/脱敏的平铺字段（key=fieldId）。 */
  fields: Record<string, unknown>;
}
export interface BootstrapLink {
  id: string;
  linkFieldId: string;
  parentRowId: string;
  childRowId: string;
  ord: number;
}

export interface ReplicaBootstrapPage {
  kind: "replica-bootstrap";
  baseId: string;
  anchorSeq: string;
  authzVersion: number;
  serverTime: string;
  recordsTruncated: boolean;
  base: BootstrapBase;
  tables: BootstrapTable[];
  fields: BootstrapField[];
  views: BootstrapView[];
  records: BootstrapRecord[];
  links: BootstrapLink[];
}

/**
 * 构建空副本引导基线（只读）。
 * @param opts.limit records 跨表总数上限（默认 5000、硬上限 20000）；结构/links 始终全量。
 */
export async function buildReplicaBootstrap(
  userId: string,
  baseId: string,
  opts: { limit?: number } = {},
): Promise<ReplicaBootstrapPage> {
  // ① 最先读锚点 seq（后续 pull 的 after 起点）。
  const maxRow = await prisma.syncOpLog.aggregate({ _max: { seq: true } });
  const anchorSeq = maxRow._max.seq ?? 0n;

  // ② 库门（enter；结构可见性只要求进得去库）。
  const access = await authorizeBaseRead(userId, baseId);

  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_RECORD_LIMIT, HARD_RECORD_LIMIT));

  // ③ 全量活结构（不按表 r 裁剪）：base / tables / fields / views，全部保留权威 cuid。
  const [baseRow, tableRows, fieldRows, viewRows] = await Promise.all([
    prisma.base.findUniqueOrThrow({
      where: { id: baseId },
      select: { id: true, name: true, icon: true, iconColor: true, shareEnabled: true },
    }),
    prisma.table.findMany({
      where: { baseId, deletedAt: null },
      select: { id: true, name: true, primaryFieldId: true, icon: true, iconColor: true, shareEnabled: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.field.findMany({
      where: { table: { baseId, deletedAt: null }, deletedAt: null },
      orderBy: [{ tableId: "asc" }, { order: "asc" }, { id: "asc" }],
    }),
    prisma.view.findMany({
      // views 无 deletedAt：软删表级联软删但 view 行仍在，故只取【活表】的视图。
      where: { table: { baseId, deletedAt: null } },
      orderBy: [{ tableId: "asc" }, { order: "asc" }, { id: "asc" }],
    }),
  ]);

  // ④ 逐表当前权限可见性（与 snapshot/pull 同管线）：仅可读表产出记录与可见 id 集。
  const records: BootstrapRecord[] = [];
  const globalVisibleIds = new Set<string>();
  let truncated = false;
  for (const t of tableRows) {
    const vis = await buildTableVisibility(userId, access, t.id);
    if (!vis.tableReadable) continue; // 结构已全量下发；该表数据/links 跳过。
    for (const rid of visibleIdSet(vis)) globalVisibleIds.add(rid);
    if (records.length >= limit) { truncated = true; continue; }
    for (const r of vis.records) {
      if (records.length >= limit) { truncated = true; break; }
      records.push({ id: r.id, tableId: r.tableId, fields: r.fields as Record<string, unknown> });
    }
  }

  // ⑤ links：正向字段（links/subtable 且非反向）上、两端记录都在【全局可见集】内的活行。
  const forwardLinkFieldIds = fieldRows
    .filter((f) => (f.type === "links" || f.type === "subtable") && !f.isReverse)
    .map((f) => f.id);
  let links: BootstrapLink[] = [];
  if (forwardLinkFieldIds.length > 0 && globalVisibleIds.size > 0) {
    const visibleArr = [...globalVisibleIds];
    const linkRows = await prisma.linkRow.findMany({
      where: {
        deletedAt: null,
        linkFieldId: { in: forwardLinkFieldIds },
        parentRowId: { in: visibleArr },
        childRowId: { in: visibleArr },
      },
      orderBy: [{ linkFieldId: "asc" }, { parentRowId: "asc" }, { ord: "asc" }, { id: "asc" }],
    });
    links = linkRows.map((l) => ({
      id: l.id, linkFieldId: l.linkFieldId, parentRowId: l.parentRowId,
      childRowId: l.childRowId, ord: l.ord,
    }));
  }

  const authzVersion = await readAuthzVersion();

  return {
    kind: "replica-bootstrap",
    baseId,
    anchorSeq: anchorSeq.toString(),
    authzVersion,
    serverTime: new Date().toISOString(),
    recordsTruncated: truncated,
    base: {
      id: baseRow.id, name: baseRow.name, icon: baseRow.icon,
      iconColor: baseRow.iconColor, shareEnabled: baseRow.shareEnabled,
    },
    tables: tableRows.map((t) => ({
      id: t.id, name: t.name, primaryFieldId: t.primaryFieldId,
      icon: t.icon, iconColor: t.iconColor, shareEnabled: t.shareEnabled,
    })),
    fields: fieldRows.map((f) => ({
      id: f.id, tableId: f.tableId, name: f.name, type: f.type, description: f.description,
      order: f.order, required: f.required, unique: f.unique, options: f.options,
      maxLength: f.maxLength, defaultNow: f.defaultNow, precision: f.precision,
      recordFilter: f.recordFilter, linkFieldId: f.linkFieldId, relatedTableId: f.relatedTableId,
      relationKind: f.relationKind, isReverse: f.isReverse, reverseFieldId: f.reverseFieldId,
      linkDisplayFieldId: f.linkDisplayFieldId, lookupFieldId: f.lookupFieldId,
      rollupFunction: f.rollupFunction, formula: f.formula, tabsConfig: f.tabsConfig,
      displayedFieldIds: f.displayedFieldIds, visibleFieldIds: f.visibleFieldIds,
      defaultConfig: f.defaultConfig, numberRule: f.numberRule,
    })),
    views: viewRows.map((v) => ({
      id: v.id, tableId: v.tableId, name: v.name, type: v.type, lockMode: v.lockMode,
      order: v.order, config: v.config, adminConfig: v.adminConfig,
    })),
    records,
    links,
  };
}
