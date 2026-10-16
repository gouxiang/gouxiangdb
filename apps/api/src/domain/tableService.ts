// apps/api/src/domain/tableService.ts
// 数据表元数据服务：创建 / 更新 / 软删（对外编排层）。
//
// 本文件只负责：入参规整、开交互事务（withWriteTx）、提交成功后失效序号缓存。
// 事务体内的多步结构写全部在 tableServiceTx.ts，且回调内只用传入的 tx（RC-10 写路径全事务化）。
// REST（routes/tables.ts）与 MCP（mcp/tools/tableBuild.tools.ts）共用本服务，单一真源。

import { withWriteTx } from "../db.js";
import { invalidateOrdinalCache } from "./prismaDeps.js";
import { createTableTx, softDeleteTableTx, updateTableTx, restoreTableTx } from "./tableServiceTx.js";
import { recordStructureOpTx } from "./sync/structureOplog.js";

export {
  assertTableNameFree,
  resolveCopyTableName,
  type CreateTableTxInput,
  type UpdateTableTxInput,
} from "./tableServiceTx.js";

interface CreateTableInput {
  baseId: string;
  name: string;
  withDefaults?: boolean;
}

interface CreateTableResult {
  tableId: string;
  primaryFieldId: string;
  createdAt: Date;
}

/** 建表：trim 表名（纯空格由调用方/此处 400），单事务落库。 */
export async function createTable(input: CreateTableInput, operatorUserId: string): Promise<CreateTableResult> {
  const name = input.name.trim();
  if (name === "") throw new Error("表名不能为空");
  // U-9：建表多步写事务化——任何一步失败整体回滚，不留无 primaryField / 无视图的半截表。
  const result = await withWriteTx("table.create", async (tx) => {
    const r = await createTableTx(tx, {
      baseId: input.baseId,
      name,
      withDefaults: input.withDefaults ?? false,
      userId: operatorUserId,
    });
    // YN7 §8.6：在线结构写也推进 table_schema 钟 + oplog（off 时第一行 return null，零 IO）。
    await recordStructureOpTx(tx, {
      entityType: "table", entityId: r.table.id, tableId: r.table.id, baseId: input.baseId,
      op: "create_table", actorId: operatorUserId,
      payload: { name, withDefaults: input.withDefaults ?? false, primaryFieldId: r.primaryFieldId },
    });
    return r;
  });
  return { tableId: result.table.id, primaryFieldId: result.primaryFieldId, createdAt: result.table.createdAt };
}

interface UpdateTableInput {
  name?: string;
  primaryFieldId?: string;
  icon?: string | null;
  iconColor?: string | null;
}

interface UpdateTableResult {
  id: string;
  name: string;
  primaryFieldId: string;
  icon: string | null;
  iconColor: string | null;
}

/** 更新表元数据：仅在显式传 name 时改名（trim + 事务内查重排除自己）。
 * operatorUserId 可选（YN7 oplog actor）；旧调用方不传 → actor=null，行为不变。 */
export async function updateTable(
  tableId: string,
  baseId: string,
  patch: UpdateTableInput,
  operatorUserId?: string | null,
): Promise<UpdateTableResult> {
  const trimmedName = patch.name?.trim();
  const renaming = patch.name !== undefined;
  const t = await withWriteTx("table.update", async (tx) => {
    const updated = await updateTableTx(tx, {
      tableId,
      baseId,
      name: trimmedName,
      primaryFieldId: patch.primaryFieldId,
      icon: patch.icon,
      iconColor: patch.iconColor,
      renaming,
    });
    // YN7 §8.6：改名走 rename_table；其它（主字段/图标）走 update_table_settings；off 时零 IO。
    const op = renaming ? "rename_table" : "update_table_settings";
    const payload: Record<string, unknown> = {};
    if (renaming && trimmedName !== undefined) payload.name = trimmedName;
    if (patch.primaryFieldId !== undefined) payload.primaryFieldId = patch.primaryFieldId;
    if (patch.icon !== undefined) payload.icon = patch.icon;
    if (patch.iconColor !== undefined) payload.iconColor = patch.iconColor;
    await recordStructureOpTx(tx, {
      entityType: "table", entityId: tableId, tableId, baseId,
      op, actorId: operatorUserId ?? null, payload,
    });
    return updated;
  });
  if (renaming) invalidateOrdinalCache(tableId);
  return {
    id: t.id,
    name: t.name,
    primaryFieldId: t.primaryFieldId,
    icon: t.icon,
    iconColor: t.iconColor,
  };
}

/** 软删表（级联软删记录/字段、nav 子树、outbox 登记、库节点聚合位重算）。 */
export async function softDeleteTable(
  tableId: string,
  operatorUserId: string,
  baseId?: string,
): Promise<void> {
  await withWriteTx("table.softDelete", async (tx) => {
    await softDeleteTableTx(tx, tableId, operatorUserId);
    // YN7 §8.6：删表推进 table_schema 钟 + oplog（baseId 可由调用方传入，避免软删后点查不到）。
    const resolvedBase = baseId
      ?? (await tx.table.findUnique({ where: { id: tableId }, select: { baseId: true } }))?.baseId
      ?? null;
    if (resolvedBase) {
      await recordStructureOpTx(tx, {
        entityType: "table", entityId: tableId, tableId, baseId: resolvedBase,
        op: "delete_table", actorId: operatorUserId, payload: {},
      });
    }
  });
  invalidateOrdinalCache(tableId);
}

/**
 * 恢复软删表（回收站/YN7 restore_table 共用编排）：单事务跑 restoreTableTx，并在同事务登记
 * restore_table 结构 oplog、推进 table_schema 钟（§19.1/§8.6；GX_SYNC_SERVER off 时切面第一行
 * return null，零 IO、零行为变化）。
 */
export async function restoreTable(
  tableId: string,
  operatorUserId: string,
): Promise<{ name: string; renamed: boolean }> {
  const r = await withWriteTx("table.restore", async (tx) => {
    const result = await restoreTableTx(tx, tableId, operatorUserId);
    await recordStructureOpTx(tx, {
      entityType: "table", entityId: tableId, tableId, baseId: result.baseId,
      op: "restore_table", actorId: operatorUserId,
      payload: { name: result.name, restoredRecords: result.restoredRecordIds.length },
    });
    return result;
  });
  invalidateOrdinalCache(tableId);
  return { name: r.name, renamed: r.renamed };
}
