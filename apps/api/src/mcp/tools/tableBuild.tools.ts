// MCP table 族搭建工具：table.create_table / update_table / delete_table。
//
// 纪律：handler 只编排——资源判定经权限端口（M4 闸门二），结构写经 domain/tableService
// （REST 与 MCP 共用同一事务体），本文件不 import 旧守卫、不裸查 prisma。
//
// 权限口径（与 domain/authz/tableManageGuards.ts 同语义，但不走 Hono 守卫）：
//   - 建表：在 base 节点判 manage_schema；
//   - 改名/删表：在 table 节点判 manage_table（经祖先链在库节点命中）。
// 写而无 r 时回精简回执（不回表内容）。

import { createTable, updateTable, softDeleteTable } from "../../domain/tableService.js";
import { tableBriefById } from "../../domain/mcpReadModels.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

function noEngine(): ToolResult {
  return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
}

/** table.create_table：base 节点 manage_schema；单事务建表。 */
export async function tableCreateTable(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const baseId = String(args.baseId ?? "");
  const rawName = String(args.name ?? "");
  const name = rawName.trim();
  if (!name) return deny("INVALID_PARAMS", "表名不能为空");
  if (!(await ctx.port.can("manage_schema", { kind: "base", id: baseId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该 base 建表（或该 base 不存在）");
  }
  const created = await createTable(
    { baseId, name, withDefaults: args.withDefaults === true },
    ctx.subject.userId,
  );
  const canRead = await ctx.port.can("r", { kind: "table", id: created.tableId });
  const payload = canRead
    ? { ok: true, tableId: created.tableId, primaryFieldId: created.primaryFieldId }
    : { ok: true };
  return text(JSON.stringify(payload));
}

/** table.update_table：table 节点 manage_table；仅显式传 name 时改名。 */
export async function tableUpdateTable(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const tableId = String(args.tableId ?? "");
  if (args.name !== undefined && !String(args.name).trim()) {
    return deny("INVALID_PARAMS", "表名不能为空");
  }
  if (!(await ctx.port.can("manage_table", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权管理该表（或该表不存在）");
  }
  const brief = await tableBriefById(tableId);
  if (!brief) return deny("FORBIDDEN_RESOURCE", "数据表不存在");
  const t = await updateTable(tableId, brief.baseId, {
    name: args.name === undefined ? undefined : String(args.name),
    primaryFieldId: args.primaryFieldId === undefined ? undefined : String(args.primaryFieldId),
    icon: args.icon === undefined ? undefined : (args.icon as string | null),
    iconColor: args.iconColor === undefined ? undefined : (args.iconColor as string | null),
  });
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead
    ? { ok: true, table: { id: t.id, name: t.name, primaryFieldId: t.primaryFieldId, icon: t.icon, iconColor: t.iconColor } }
    : { ok: true }));
}

/** table.delete_table：table 节点 manage_table；软删（可由回收站恢复）。 */
export async function tableDeleteTable(ctx: ToolCtx, args: Record<string,unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const tableId = String(args.tableId ?? "");
  if (!(await ctx.port.can("manage_table", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权删除该表（或该表不存在）");
  }
  const brief = await tableBriefById(tableId);
  if (!brief) return deny("FORBIDDEN_RESOURCE", "数据表不存在");
  await softDeleteTable(tableId, ctx.subject.userId);
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead ? { ok: true, tableId, deleted: true } : { ok: true }));
}
