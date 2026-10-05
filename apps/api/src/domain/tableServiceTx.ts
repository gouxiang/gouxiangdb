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
}

interface CreateTableTxResult {
  table: { id: string; createdAt: Date };
  primaryFieldId: string;
}

/**
 * 建表全流程（单事务）：表名查重 → 建表（primaryFieldId 先空）→ 建「名称」主字段并回填
 * → 可选默认字段 → 建网格视图 → 同步 nav 节点 → scope 双写 + role_admin 隐含投影。
 */
export async function createTableTx(tx: DbTx, input: CreateTableTxInput): Promise<CreateTableTxResult> {
  const { baseId, name, userId } = input;
  await assertTableNameFree(tx, baseId, name);
  // shareEnabled 继承当前库级总闸：表级开关是库级「允许分享」的快照，
  // tableShareAllowed() 两级都判。不继承的话，管理员打开库开关之后新建的表依旧是 0。
  const owner = await tx.base.findUnique({ where: { id: baseId }, select: { shareEnabled: true } });
  const t = await tx.table.create({
    data: {
      baseId,
      name,
      primaryFieldId: "",
      createdBy: userId,
      shareEnabled: owner?.shareEnabled ?? 0,
    },
  });

  const nameField = await tx.field.create({
    data: { tableId: t.id, name: "名称", type: "singleLineText", order: 0 },
  });
  await tx.table.update({ where: { id: t.id }, data: { primaryFieldId: nameField.id } });

  if (input.withDefaults) {
    await tx.field.create({
      data: { tableId: t.id, name: "数量", type: "number", order: 1, precision: 0 },
    });
    await tx.field.create({
      data: {
        tableId: t.id,
        name: "状态",
        type: "singleSelect",
        order: 2,
        options: JSON.stringify(makeOptions(["未开始", "进行中", "已完成"])),
      },
    });
    await tx.field.create({ data: { tableId: t.id, name: "日期", type: "date", order: 3 } });
    await tx.field.create({ data: { tableId: t.id, name: "备注", type: "longText", order: 4 } });
  }

  await tx.view.create({
    data: { tableId: t.id, name: "网格视图", type: "grid", order: 0, config: JSON.stringify(defaultGridViewConfig()) },
  });
  // M3/S3：同事务同步 table + view 节点（field 不建节点）。
  await syncNavFromEntitiesTx(tx);
  // P1/S7：为该库每条命中 scope 角色补新表节点 scope:role 策略 + role_admin 隐含策略。
  await syncTableForAllScopesTx(tx, "base", baseId, t.id, "add", userId);
  await projectAdminForNewTableTx(tx, baseId, t.id, userId);
  return { table: t, primaryFieldId: nameField.id };
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
