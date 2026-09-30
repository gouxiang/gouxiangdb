// MCP table 族视图搭建工具：view.create_view / update_view / delete_view。
//
// 纪律：handler 只编排——资源判定经权限端口（table 节点 manage_schema，M4 闸门二），
// 结构写经 domain/viewService（REST 与 MCP 同一事务体），本文件不 import 旧守卫、不裸查 prisma。
// 权限口径与 routes/views.ts 的 requireSchemaDesign 同语义（视图结构=表结构设计的一部分）。
// 写而无 table r 时回精简回执。

import { createView, updateView, purgeView } from "../../domain/viewService.js";
import { viewBriefById } from "../../domain/mcpReadModels.js";
import { parseViewConfig } from "../../domain/recordService.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

function noEngine(): ToolResult {
  return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
}

/** view.create_view：table 节点 manage_schema；单事务建视图。 */
export async function viewCreateView(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const tableId = String(args.tableId ?? "");
  const name = String(args.name ?? "").trim();
  const type = String(args.type ?? "");
  if (!name) return deny("INVALID_PARAMS", "视图名不能为空");
  if (!type) return deny("INVALID_PARAMS", "视图类型不能为空");
  if (!(await ctx.port.can("manage_schema", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该表创建视图（或该表不存在）");
  }
  const config = args.config && typeof args.config === "object"
    ? (args.config as Record<string, unknown>)
    : undefined;
  const created = await createView({ tableId, name, type, config });
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead
    ? { ok: true, viewId: created.id }
    : { ok: true }));
}

/** view.update_view：table 节点 manage_schema；组装可写列，config 走合并并留表单快照。 */
export async function viewUpdateView(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const viewId = String(args.viewId ?? "");
  const brief = await viewBriefById(viewId);
  if (!brief) return deny("FORBIDDEN_RESOURCE", "视图不存在");
  if (!(await ctx.port.can("manage_schema", { kind: "table", id: brief.tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权管理该视图（或该表不存在）");
  }

  const data: Record<string, unknown> = {};
  if (args.name !== undefined) {
    const n = String(args.name).trim();
    if (!n) return deny("INVALID_PARAMS", "视图名不能为空");
    data["name"] = n;
  }
  if (args.lockMode !== undefined) data["lockMode"] = String(args.lockMode);
  if (args.order !== undefined) data["order"] = args.order;
  let configChanged = false;
  if (args.config !== undefined) {
    if (typeof args.config !== "object" || args.config === null) {
      return deny("INVALID_PARAMS", "config 必须是对象");
    }
    const current = parseViewConfig(brief.config);
    data["config"] = JSON.stringify({ ...current, ...(args.config as Record<string, unknown>) });
    configChanged = true;
  }
  if (Object.keys(data).length === 0) {
    return deny("INVALID_PARAMS", "至少需修改一项（name/lockMode/order/config）");
  }
  const affectsNav = Object.prototype.hasOwnProperty.call(data, "name")
    || Object.prototype.hasOwnProperty.call(data, "order");

  const u = await updateView(viewId, {
    data,
    affectsNav,
    snapshot: configChanged
      ? { userId: ctx.subject.userId, tableId: brief.tableId, viewType: brief.type, skipIfIdentical: true }
      : null,
  });
  const canRead = await ctx.port.can("r", { kind: "table", id: brief.tableId });
  return text(JSON.stringify(canRead
    ? { ok: true, view: { id: u.id, name: u.name, type: u.type, lockMode: u.lockMode, order: u.order } }
    : { ok: true }));
}

/** view.delete_view：table 节点 manage_schema；至少保留一个视图。 */
export async function viewDeleteView(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const viewId = String(args.viewId ?? "");
  const brief = await viewBriefById(viewId);
  if (!brief) return deny("FORBIDDEN_RESOURCE", "视图不存在");
  if (!(await ctx.port.can("manage_schema", { kind: "table", id: brief.tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权删除该视图（或该表不存在）");
  }
  await purgeView(viewId);
  const canRead = await ctx.port.can("r", { kind: "table", id: brief.tableId });
  return text(JSON.stringify(canRead ? { ok: true, viewId, deleted: true } : { ok: true }));
}
