// YN2a 离线同步：按「当前权限」裁剪的基线快照 + 订阅记账（只读面）。
//
// 设计权威：DESIGN-OFFLINE-SYNC §6.1/§6.2、§9.1/§9.3、§13、§15.2（YN2）。
//
// 两条铁律：
//   1) 快照口径必须与在线列表【完全一致】（验收：快照与在线列表一致）——因此逐表复用
//      records 列表 GET / 的同一条管线，不另写一套裁剪：
//        fieldScopeOf(access)          （库 config.fields 的 hidden 档）
//        → resolveTableMask(userId)   （on 态字段掩码 + 行级 rowFilter + 跨表可见性钩子）
//        → queryRecords(noPaging)     （mask.rowFilter AND 进 config，行过滤物理/内存同源）
//        → stripHiddenFromRecords     （隐藏字段键兜底再抹一次）
//   2) 权限按【调用当下】实时重算，绝不因「订过」就放宽（§6.2）：每次快照都重新取
//      base access + 每表 mask。被降权/移出的主体：库门 enter 不过直接 403；表级 r
//      被收回由 mask 行过滤/字段掩码收敛（与列表同一结果）。
//
// 懒初始化/不回填：快照只从 records 现存活行投影，version 从 sync_entity_versions 取，
// 同步开启前就存在的「老记录」无版本行 → version=0（与离线端「未见过」语义一致），
// 不回填、不制造 oplog。快照本身是只读操作，不推进任何版本。

import type { LibraryAccessDTO } from "@gx/shared-types";
import { prisma } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { resolveBaseAccess } from "../authz/libraryPolicy.js";
import { enforceOrLegacy } from "../authz/enforceGate.js";
import { fieldScopeOf, stripHiddenFromRecords } from "../authz/fieldScope.js";
import { resolveTableMask } from "../authz/maskGate.js";
import { loadTableFields, queryRecords, parseViewConfig } from "../recordService.js";
import type { HydratedRecord } from "../types.js";

/** 单工作区，与 oplog/outbox 同口径。 */
const WORKSPACE_ID = "ws_default";

export interface AuthzTag {
  /** workspaces.policyVersion：策略/行条件/字段掩码写都会 bump；客户端据此发现权限可能变化。 */
  authzVersion: number;
}

/** 订阅（upsert）结果 + 当前游标/权限版本。 */
export interface SubscribeResult extends AuthzTag {
  clientId: string;
  scopeType: string;
  scopeId: string;
  /** 已确认收到的最大 seq（新订阅为 0）。 */
  cursorSeq: string;
  /** 是否已完成过快照（决定客户端先拉快照还是直接走增量）。 */
  snapshotDone: boolean;
}

/** 快照中的一条记录（字段已按当前权限裁剪）。 */
export interface SnapshotRecord {
  id: string;
  tableId: string;
  /** 已按字段权限裁剪/脱敏后的平铺字段（key=fieldId）；不回吐隐藏/掩码外字段。 */
  fields: Record<string, unknown>;
  /** 当前权威版本（老记录=0）；字符串承载 BigInt。 */
  version: string;
  isDeleted: boolean;
  lastSeq: string;
}

export interface SnapshotPage extends AuthzTag {
  baseId: string;
  records: SnapshotRecord[];
  /** 本次快照读取时刻的最大 oplog seq（字符串）；客户端完成快照后以它作增量起点。 */
  snapshotSeq: string;
  serverTime: string;
}

/** 读当前权限版本（workspaces.policyVersion；缺省 0）。visibility 对账（§9.3）同样以它为版本戳。 */
export async function readAuthzVersion(): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: WORKSPACE_ID },
    select: { policyVersion: true },
  });
  return ws?.policyVersion ?? 0;
}

/**
 * 库门：按当前 token 对 base 的 enter 裁决（与 guards.requireCanView 同一接线缝）。
 * 不过直接抛 403；引擎故障由 enforceOrLegacy 抛 503（fail-closed）。snapshot/pull 共用。
 */
export async function authorizeBaseRead(userId: string, baseId: string): Promise<LibraryAccessDTO> {
  const access = await resolveBaseAccess(userId, baseId);
  const allowed = await enforceOrLegacy({
    guard: "sync.snapshot",
    userId,
    action: "enter",
    legacyAllowed: access.visible,
    ref: { resourceType: "base", resourceId: baseId },
  });
  if (!allowed.allowed) throw new HttpError(403, "无权访问该 Base");
  return access;
}

/**
 * 一张表对当前主体「此刻」的可见性投影（snapshot 与 pull 同源复用，保证口径零漂移）：
 *   - tableReadable=false：表级 r 完全不可见（cap.visible=false），该表数据/增量一律不下发；
 *   - records：经行级条件（mask.rowFilter，与列表同管线）过滤、字段裁剪后的当前可见活记录；
 *   - visibleFieldIds=null：字段全可见；否则仅集合内字段可下发（被收回字段不下发/脱敏）。
 */
export interface TableVisibility {
  tableReadable: boolean;
  /** 已 hydrate、已按字段权限裁剪的当前可见活记录（snapshot 直接投影，pull 取 id 集）。 */
  records: HydratedRecord[];
  /** null = 不裁剪（全字段可见）。 */
  visibleFieldIds: Set<string> | null;
}

/** 便捷：可见记录 id 集（pull 行可见判定用）。 */
export function visibleIdSet(vis: TableVisibility): Set<string> {
  return new Set(vis.records.map((r) => r.id));
}

/**
 * 计算某张表对当前主体的可见性。走与 records 列表 GET / 完全相同的裁剪管线
 * （fieldScopeOf → resolveTableMask → queryRecords(rowFilter) → stripHidden）。
 * 纯读；每表只查一次，返回 hydrate 后的可见记录供 snapshot/pull 复用。
 */
export async function buildTableVisibility(
  userId: string,
  access: LibraryAccessDTO,
  tableId: string,
): Promise<TableVisibility> {
  const fields = await loadTableFields(tableId);
  const scope = fieldScopeOf(access, tableId, fields);
  const scopeFields = scope.active ? scope.fields : fields;
  const mask = await resolveTableMask(userId, tableId, scopeFields);
  if (mask && mask.mask.cap.visible === false) {
    return { tableReadable: false, records: [], visibleFieldIds: new Set() };
  }
  const queryFields = mask ? mask.visibleFields : scopeFields;
  const config = parseViewConfig(null);
  if (mask?.rowFilter) config.filters = mask.rowFilter;

  const result = await queryRecords({
    tableId,
    fields: queryFields,
    config,
    noPaging: true,
    hydrateDeps: mask?.hydrateDeps,
    compileDeniedFieldIds: mask?.deniedIds ?? null,
    currentUserId: userId,
  });
  const records = stripHiddenFromRecords(result.records, scope.hiddenIds);
  // visibleIds 为 null（宽来源/owner/creator）→ 字段不裁剪；否则用掩码后可见字段集。
  const visibleFieldIds: Set<string> | null =
    mask?.mask.visibleIds === null && !scope.active
      ? null
      : new Set(queryFields.map((f) => f.id));
  return { tableReadable: true, records, visibleFieldIds };
}

/**
 * 订阅某 base（按 clientId+scope upsert 记账）。幂等：重复订阅不重置游标。
 * 注意：调用方必须已通过同步总门 + 登录；本函数再做一次当前库门裁决。
 * 所有读写都经 db.ts 单例（与 mask/query 同源），不接受外部 client，避免两套库混用。
 */
export async function subscribeBase(
  userId: string,
  clientId: string,
  baseId: string,
): Promise<SubscribeResult> {
  await authorizeBaseRead(userId, baseId);
  await prisma.syncSubscription.upsert({
    where: {
      clientId_scopeType_scopeId: { clientId, scopeType: "base", scopeId: baseId },
    },
    create: {
      clientId, scopeType: "base", scopeId: baseId, actorId: userId,
      cursorSeq: 0n, snapshotDone: false,
    },
    // 幂等：已订阅则只刷新 actorId（换账号登录同设备），绝不动游标/快照位。
    update: { actorId: userId },
  });
  const authzVersion = await readAuthzVersion();

  const sub = await prisma.syncSubscription.findUniqueOrThrow({
    where: { clientId_scopeType_scopeId: { clientId, scopeType: "base", scopeId: baseId } },
    select: { cursorSeq: true, snapshotDone: true },
  });
  return {
    clientId, scopeType: "base", scopeId: baseId,
    cursorSeq: sub.cursorSeq.toString(),
    snapshotDone: sub.snapshotDone,
    authzVersion,
  };
}

/**
 * 取一页按当前权限裁剪的基线快照（遍历该 base 全部【未删】表，逐表走列表同管线）。
 *
 * @param limit 最多返回多少条（跨表总数）；到达上限即截断，做超大库保护（默认 5000）。
 */
export async function buildBaseSnapshot(
  userId: string,
  baseId: string,
  opts: { limit?: number } = {},
): Promise<SnapshotPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000));
  const access = await authorizeBaseRead(userId, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const out: SnapshotRecord[] = [];
  for (const { id: tableId } of tables) {
    if (out.length >= limit) break;
    // 逐表可见性与 pull 完全同源（buildTableVisibility 内含与列表相同的裁剪管线，每表只查一次）。
    const vis = await buildTableVisibility(userId, access, tableId);
    if (!vis.tableReadable || vis.records.length === 0) continue;
    const visible = vis.records;

    // join 实体版本（一次 IN 查询）；老记录无版本行 → version=0/isDeleted=false。
    const versions = await prisma.syncEntityVersion.findMany({
      where: { id: { in: visible.map((r) => r.id) } },
      select: { id: true, version: true, isDeleted: true, lastSeq: true },
    });
    const vById = new Map(versions.map((v) => [v.id, v]));

    for (const r of visible) {
      if (out.length >= limit) break;
      const v = vById.get(r.id);
      out.push({
        id: r.id,
        tableId: r.tableId,
        fields: r.fields as Record<string, unknown>,
        version: (v?.version ?? 0n).toString(),
        isDeleted: v?.isDeleted ?? false,
        lastSeq: (v?.lastSeq ?? 0n).toString(),
      });
    }
  }

  const [maxRows, authzVersion] = await Promise.all([
    prisma.syncOpLog.aggregate({ _max: { seq: true } }),
    readAuthzVersion(),
  ]);

  return {
    baseId,
    records: out,
    snapshotSeq: (maxRows._max.seq ?? 0n).toString(),
    serverTime: new Date().toISOString(),
    authzVersion,
  };
}

/** 标记某订阅快照已完成（客户端拉完快照后回执；游标推进由 pull 的 after 语义负责）。 */
export async function markSnapshotDone(clientId: string, baseId: string): Promise<void> {
  await prisma.syncSubscription.updateMany({
    where: { clientId, scopeType: "base", scopeId: baseId },
    data: { snapshotDone: true },
  });
}
