// apps/api/src/domain/tableServiceTx.ts
// 数据表结构写的【交互事务体】：create / update / softDelete（RC-10 写路径全事务化）。
//
// 本文件只含在单个 withWriteTx 回调内执行、且只用传入 tx 的多步写；对外开事务、提交后失效
// 序号缓存由 tableService.ts 负责。REST（routes/tables.ts）与 MCP（mcp/tools/tableBuild.tools.ts）
// 共用同一事务体，杜绝两份建表/删表逻辑漂移。
//
// 铁律：这些函数体内禁止再调 runWrite/withWriteTx/withWriteBatch（写队列并发度恒 1，事务回调内
// 再次入队会自死锁）。

import type { DbTx } from "../db.js";
import { HttpError } from "../httpError.js";
import { makeOptions } from "./fieldService.js";
import { enqueueChangeEventsTx } from "./search/outbox.js";
import { syncNavFromEntitiesTx, softDeleteSubtreeTx } from "./nav/sync.js";
import { nodeId } from "./nav/backfill.js";
import {
  syncTableForAllScopesTx,
  resyncLibraryAggregateForAllScopesTx,
} from "./authz/scopeProjectionTx.js";
import { projectAdminForNewTableTx } from "./authz/scopeDoubleWrite.js";
import { resolveTableRestoreName } from "./restoreName.js";
import { restoreLinkRows } from "./recordWrite.js";
import { restoreRecordsTx } from "./fieldIndex/sync.js";
import { recordSyncOpsTx } from "./sync/oplog.js";

// ============ 表名唯一性（同库 + 未软删 + trim 后精确匹配）============
//
// 口径与字段名重名（fieldServiceTx.ts）一致：409 + `表名「X」已存在`。
// 不加数据库唯一索引：存量库里已有重复表名，加索引会让迁移失败、老库起不来——
// 唯一性只在应用层保证，且只在「新建 / 改名 / 显式命名复制」三条写路径拦，存量重复不动。
// 查重必须在 withWriteTx 回调内用 tx 做：外部查会有「两个请求都读到没重复→双双写入」的
// 竞态，而 withWriteTx 是并发度 1 的串行写队列，事务内查重可杜绝它。

/**
 * 断言名称在该库内未被占用；占用则抛 409（调用方所在事务随之回滚）。
 * excludeTableId：改名场景排除自己，避免「只改图标」或「改名成自己现在的名字」被误判。
 */
export async function assertTableNameFree(
  tx: DbTx,
  baseId: string,
  name: string,
  excludeTableId?: string,
): Promise<void> {
  const trimmed = name.trim();
  const dup = await tx.table.findFirst({
    where: {
      baseId,
      name: trimmed,
      deletedAt: null,
      ...(excludeTableId ? { id: { not: excludeTableId } } : {}),
    },
    select: { id: true },
  });
  if (dup) throw new HttpError(409, `表名「${trimmed}」已存在`);
}

/**
 * 复制表未显式命名时的自动排号：base → `${base} 2` → `${base} 3` …
 * 每次候选都在事务内实查（逐个编号），存量库里已存在的同名副本会被自动绕开。
 * 超过 maxTries 仍全部冲突才抛错——正常不会走到，避免无限循环。
 */
export async function resolveCopyTableName(
  tx: DbTx,
  baseId: string,
  base: string,
  maxTries = 50,
): Promise<string> {
  for (let i = 1; i <= maxTries; i += 1) {
    const candidate = i === 1 ? base : `${base} ${i}`;
    const dup = await tx.table.findFirst({
      where: { baseId, name: candidate, deletedAt: null },
      select: { id: true },
    });
    if (!dup) return candidate;
  }
  throw new HttpError(409, `表名「${base}」及其后 ${maxTries} 个编号均已被占用`);
}

/** 新建表时的默认「网格视图」配置（与 REST 历史口径一致）。 */
function defaultGridViewConfig(): Record<string, unknown> {
  return {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
  };
}

export interface CreateTableTxInput {
  baseId: string;
  /** 已 trim 的表名（调用方保证非空）。 */
  name: string;
  /** 是否同时建数量/状态/日期/备注四个默认字段。 */
  withDefaults: boolean;
  userId: string;
  /**
   * YN7 同步回放可选：保留离线端生成的表 cuid 作权威主键（§8.4/§19.3，与 record 回放同策略）。
   * 在线建表恒不传 → Prisma 照常生成 cuid，默认行为逐字节不变。
   */
  tableId?: string;
  /**
   * S3b-3a 下行回放可选：保主字段/4 默认字段/默认网格视图的服务端权威 cuid（§8.4），供 pull 泵
   * 回放「订阅后新建的表」时子实体 id 与服务端一致。在线恒不传 → 全随机；数组按
   * [数量,状态,日期,备注] 对位，缺位/缺键回退随机（老 op 无此键即整体不传）。
   */
  presetChildIds?: {
    primaryFieldId?: string;
    defaultFieldIds?: readonly string[];
    defaultViewId?: string;
  };
}

interface CreateTableTxResult {
  table: { id: string; createdAt: Date };
  primaryFieldId: string;
  /** 实际落地的 4 默认字段 id（withDefaults=false 恒为 []）。 */
  defaultFieldIds: string[];
  /** 实际落地的默认网格视图 id。 */
  defaultViewId: string;
}

/**
 * 建表全流程（单事务）：表名查重 → 建表（primaryFieldId 先空）→ 建「名称」主字段并回填
 * → 可选默认字段 → 建网格视图 → 同步 nav 节点 → scope 双写 + role_admin 隐含投影。
 */
export async function createTableTx(tx: DbTx, input: CreateTableTxInput): Promise<CreateTableTxResult> {
  const { baseId, name, userId } = input;
  // S3b-3a：下行回放透传的权威子实体 id；在线路径 input.presetChildIds 恒为 undefined → 全随机。
  const preset = input.presetChildIds;
  await assertTableNameFree(tx, baseId, name);
  // shareEnabled 继承当前库级总闸：表级开关是库级「允许分享」的快照，
  // tableShareAllowed() 两级都判。不继承的话，管理员打开库开关之后新建的表依旧是 0。
  const owner = await tx.base.findUnique({ where: { id: baseId }, select: { shareEnabled: true } });
  const t = await tx.table.create({
    data: {
      // YN7 回放带 tableId 时保留离线 cuid（撞 id 由 Prisma P2002 冒到回放层归一成 conflict）。
      ...(input.tableId ? { id: input.tableId } : {}),
      baseId,
      name,
      primaryFieldId: "",
      createdBy: userId,
      shareEnabled: owner?.shareEnabled ?? 0,
    },
  });

  // 主字段：回放可保权威 cuid（preset.primaryFieldId）；在线缺省 → Prisma 生成。
  const nameField = await tx.field.create({
    data: {
      ...(preset?.primaryFieldId ? { id: preset.primaryFieldId } : {}),
      tableId: t.id, name: "名称", type: "singleLineText", order: 0,
    },
  });
  await tx.table.update({ where: { id: t.id }, data: { primaryFieldId: nameField.id } });

  // 4 默认字段按 [数量,状态,日期,备注] 对位保 id；withDefaults=false 时不建、返回 []。
  // 各 data 保持完整字面量（不收敛成 Record<string,unknown>），Prisma 枚举/列类型照常强校验。
  const defaultFieldIds: string[] = [];
  if (input.withDefaults) {
    const p = preset?.defaultFieldIds ?? [];
    const qty = await tx.field.create({
      data: { ...(p[0] ? { id: p[0] } : {}), tableId: t.id, name: "数量", type: "number", order: 1, precision: 0 },
    });
    const status = await tx.field.create({
      data: {
        ...(p[1] ? { id: p[1] } : {}),
        tableId: t.id, name: "状态", type: "singleSelect", order: 2,
        options: JSON.stringify(makeOptions(["未开始", "进行中", "已完成"])),
      },
    });
    const date = await tx.field.create({
      data: { ...(p[2] ? { id: p[2] } : {}), tableId: t.id, name: "日期", type: "date", order: 3 },
    });
    const note = await tx.field.create({
      data: { ...(p[3] ? { id: p[3] } : {}), tableId: t.id, name: "备注", type: "longText", order: 4 },
    });
    defaultFieldIds.push(qty.id, status.id, date.id, note.id);
  }

  // 默认网格视图：回放可保权威 cuid（preset.defaultViewId）；在线缺省 → Prisma 生成。
  const view = await tx.view.create({
    data: {
      ...(preset?.defaultViewId ? { id: preset.defaultViewId } : {}),
      tableId: t.id, name: "网格视图", type: "grid", order: 0,
      config: JSON.stringify(defaultGridViewConfig()),
    },
  });
  // M3/S3：同事务同步 table + view 节点（field 不建节点）。
  await syncNavFromEntitiesTx(tx);
  // P1/S7：为该库每条命中 scope 角色补新表节点 scope:role 策略 + role_admin 隐含策略。
  await syncTableForAllScopesTx(tx, "base", baseId, t.id, "add", userId);
  await projectAdminForNewTableTx(tx, baseId, t.id, userId);
  return {
    table: t, primaryFieldId: nameField.id,
    defaultFieldIds, defaultViewId: view.id,
  };
}

export interface UpdateTableTxInput {
  tableId: string;
  baseId: string;
  /** 已 trim 的新表名；undefined=本次不改名。 */
  name?: string;
  primaryFieldId?: string;
  icon?: string | null;
  iconColor?: string | null;
  /** 本次请求是否带了 name（决定是否触发 nav 同步）。 */
  renaming: boolean;
}

/** 更新表元数据（单事务）：改名走事务内查重 + 排除自己，并同步 nav 节点名。 */
export async function updateTableTx(tx: DbTx, input: UpdateTableTxInput) {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data["name"] = input.name;
  if (input.primaryFieldId !== undefined) data["primaryFieldId"] = input.primaryFieldId;
  if (input.icon !== undefined) data["icon"] = input.icon;
  if (input.iconColor !== undefined) data["iconColor"] = input.iconColor;
  if (input.name !== undefined) {
    await assertTableNameFree(tx, input.baseId, input.name, input.tableId);
  }
  const updated = await tx.table.update({ where: { id: input.tableId }, data });
  // icon / iconColor 不进 nav_nodes（实体图标走读取时解析），故只有改名才触发 nav 同步。
  if (input.renaming) await syncNavFromEntitiesTx(tx);
  return updated;
}

/**
 * 软删表（单事务）：表打软删 → 级联软删 records/fields、view 置 order=-1 → nav 子树整棵软删
 * → 活记录逐条登记 delete outbox → 重算库节点聚合位（防 edit_data 残留 OVERALLOW）。
 */
export async function softDeleteTableTx(
  tx: DbTx,
  tableId: string,
  operatorUserId: string,
): Promise<void> {
  const now = new Date();
  const table = await tx.table.findUnique({
    where: { id: tableId }, select: { baseId: true },
  });
  if (!table) throw new HttpError(404, "数据表不存在");
  const { baseId } = table;
  await tx.table.update({ where: { id: tableId }, data: { deletedAt: now } });
  // M5/S1：级联软删的活记录逐条登记 delete（先取 id，再更新）。
  const liveRecords = await tx.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true },
  });
  await tx.record.updateMany({ where: { tableId }, data: { deletedAt: now } });
  await tx.field.updateMany({ where: { tableId }, data: { deletedAt: now } });
  await tx.view.updateMany({ where: { tableId }, data: { order: -1 } });
  await softDeleteSubtreeTx(tx, nodeId("table", tableId));
  if (liveRecords.length > 0) {
    const softVersion = BigInt(now.getTime());
    await enqueueChangeEventsTx(tx, liveRecords.map((r) => ({
      entityType: "record" as const, entityId: r.id, op: "delete" as const, version: softVersion,
    })));
  }
  // 删表后按当前活表形态整行覆盖重算库节点：唯一可写表被删时 edit_data 正确移除，
  // canManage 角色则由 projectScopeRow 继续导出 edit_data（见 ADR-0056）。
  await resyncLibraryAggregateForAllScopesTx(tx, "base", baseId, operatorUserId);
}

export interface RestoreTableTxResult {
  baseId: string;
  /** 恢复后的最终表名（与同名活表冲突时已自动改名去歧义）。 */
  name: string;
  /** 是否因同名冲突被自动改名。 */
  renamed: boolean;
  /** 本次连带恢复的记录 id（供编排层登记结构 oplog/失效缓存）。 */
  restoredRecordIds: string[];
}

/**
 * 恢复软删表（单事务）：表复活（同名自动改名）→ 连带复活字段/记录 → 回填两端存活关联、
 * 重建记录 sidecar + 变更/同步版本登记 → 隐藏视图重排可见 → nav 子树原地复活 → scope 投影重建
 * （补 role_admin 隐含策略）→ 库节点聚合位重算。
 *
 * 从 routes/records.ts 回收站恢复的 table 分支整体下沉，供【在线恢复】与【YN7 结构回放
 * restore_table 处理器】共用同一事务体（§20.1 单一事实源，防语义漂移）。
 * 铁律同本文件其它函数：只用传入 tx，回调内禁止再入写队列。
 */
export async function restoreTableTx(
  tx: DbTx,
  tableId: string,
  operatorUserId: string,
): Promise<RestoreTableTxResult> {
  const t = await tx.table.findUnique({
    where: { id: tableId },
    select: { baseId: true, name: true },
  });
  if (!t) throw new HttpError(404, "数据表不存在");
  const { baseId } = t;

  // 同字段恢复：恢复前查同 base 下同名活表，冲突则自动改名（回收站恢复不能被 409 拒绝）。
  const finalName = await resolveTableRestoreName(tx, tableId, baseId, t.name);
  await tx.table.update({ where: { id: tableId }, data: { deletedAt: null, name: finalName } });
  await tx.field.updateMany({ where: { tableId, deletedAt: { not: null } }, data: { deletedAt: null } });
  // 先取回待恢复记录 id，恢复后按「两端都存活」回填关联。
  const restoredRows = await tx.record.findMany({
    where: { tableId, deletedAt: { not: null } },
    select: { id: true },
  });
  await tx.record.updateMany({ where: { tableId, deletedAt: { not: null } }, data: { deletedAt: null } });
  await restoreLinkRows(tx, restoredRows.map((r) => r.id));
  const restoredIds = restoredRows.map((r) => r.id);
  if (restoredRows.length > 0) {
    // M1/S4：整表恢复后批量重建全部恢复记录的 sidecar。
    await restoreRecordsTx(tx, tableId, restoredIds);
    // M5/S1：整表恢复的记录逐条登记 upsert。
    const restoreVersion = BigInt(Date.now());
    await enqueueChangeEventsTx(tx, restoredIds.map((rid) => ({
      entityType: "record" as const, entityId: rid, op: "upsert" as const, version: restoreVersion,
    })));
    // YN1：整表恢复的记录逐条推进同步版本、撤墓碑（op=restore，显式传 baseId；开关 off 零写）。
    await recordSyncOpsTx(tx, restoredIds.map((rid) => ({
      entityType: "record" as const, entityId: rid, tableId, baseId,
      op: "restore" as const, actorId: operatorUserId, changes: [],
    })));
  }
  // 删表时视图被置 order=-1 隐藏，恢复时按原序无关地重置为可见顺序。
  const hiddenViews = await tx.view.findMany({ where: { tableId, order: -1 }, select: { id: true } });
  for (let i = 0; i < hiddenViews.length; i++) {
    await tx.view.update({ where: { id: hiddenViews[i]!.id }, data: { order: i } });
  }
  await syncNavFromEntitiesTx(tx);
  // P1/S7 #5：表恢复同建表——为该库每条命中 scope 角色补齐恢复表节点策略 + role_admin 隐含投影。
  await syncTableForAllScopesTx(tx, "base", baseId, tableId, "add", operatorUserId);
  await projectAdminForNewTableTx(tx, baseId, tableId, operatorUserId);
  // 与删表对称：恢复表后按现活表形态重算库节点聚合位，恢复可写表的 edit_data。
  await resyncLibraryAggregateForAllScopesTx(tx, "base", baseId, operatorUserId);

  return { baseId, name: finalName, renamed: finalName !== t.name, restoredRecordIds: restoredIds };
}
