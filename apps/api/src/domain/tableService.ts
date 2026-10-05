// apps/api/src/domain/tableService.ts
// 数据表元数据服务：创建 / 更新 / 软删（对外编排层）。
//
// 本文件只负责：入参规整、开交互事务（withWriteTx）、提交成功后失效序号缓存。
// 事务体内的多步结构写全部在 tableServiceTx.ts，且回调内只用传入的 tx（RC-10 写路径全事务化）。
// REST（routes/tables.ts）与 MCP（mcp/tools/tableBuild.tools.ts）共用本服务，单一真源。

import { withWriteTx } from "../db.js";
import { invalidateOrdinalCache } from "./prismaDeps.js";
import { createTableTx, softDeleteTableTx, updateTableTx } from "./tableServiceTx.js";

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
  const result = await withWriteTx("table.create", (tx) =>
    createTableTx(tx, {
      baseId: input.baseId,
      name,
      withDefaults: input.withDefaults ?? false,
      userId: operatorUserId,
    }),
  );
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

/** 更新表元数据：仅在显式传 name 时改名（trim + 事务内查重排除自己）。 */
export async function updateTable(
  tableId: string,
  baseId: string,
  patch: UpdateTableInput,
): Promise<UpdateTableResult> {
  const trimmedName = patch.name?.trim();
  const renaming = patch.name !== undefined;
  const t = await withWriteTx("table.update", (tx) =>
    updateTableTx(tx, {
      tableId,
      baseId,
      name: trimmedName,
      primaryFieldId: patch.primaryFieldId,
      icon: patch.icon,
      iconColor: patch.iconColor,
      renaming,
    }),
  );
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
export async function softDeleteTable(tableId: string, operatorUserId: string): Promise<void> {
  await withWriteTx("table.softDelete", (tx) =>
    softDeleteTableTx(tx, tableId, operatorUserId));
  invalidateOrdinalCache(tableId);
}
