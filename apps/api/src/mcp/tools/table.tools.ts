// M6/S3-S4 table 族工具：list_bases / get_schema。
//
// 纪律：handler 只编排——可见集与单资源判定**全部经权限端口（M4）**；元数据经 domain 只读投影
// （domain/mcpReadModels，MCP §3-3 禁 mcp/** 裸查 prisma）；字段面经 M4 maskGate 收窄。

import { listBasesByIds, listTablesUnderBases } from "../../domain/mcpReadModels.js";
import { loadTableFields } from "../../domain/recordService.js";
import { withSelectOptions } from "./selectFields.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

/** table.list_bases：列出主体可见的 base（闸门一给候选集，闸门二逐 base 复核 r），带 name。 */
export async function tableListBases(ctx: ToolCtx): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const acc = await ctx.port.listAccessibleResources("table");
  const candidates = acc.byKind.base ?? [];
  const allowed: string[] = [];
  for (const id of candidates) {
    if (await ctx.port.can("r", { kind: "base", id })) allowed.push(id);
  }
  if (allowed.length === 0) return deny("FORBIDDEN_RESOURCE", "当前主体没有任何可见的 base");
  const bases = await listBasesByIds(allowed);
  return text(JSON.stringify({ bases, truncated: acc.truncated }));
}

/**
 * table.get_schema：base 下【可见表】的元数据 + 每表【可见字段】。
 * 字段经 M4 maskGate 收窄（不可见字段**不进 schema**，AC-M6-2）；表集合与可见集求交。
 */
export async function tableGetSchema(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const baseId = String(args.baseId ?? "");
  if (!(await ctx.port.can("r", { kind: "base", id: baseId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权访问该 base（或该 base 不存在）");
  }
  const acc = await ctx.port.listAccessibleResources("table");
  const visibleTables = new Set(acc.byKind.table ?? []);
  const tables = (await listTablesUnderBases([baseId])).filter((t) => visibleTables.has(t.id));

  const out = [];
  for (const t of tables) {
    if (!(await ctx.port.can("r", { kind: "table", id: t.id }))) continue;
    const fields = await loadTableFields(t.id);
    // 字段面经权限端口（M4 引擎 capability，**不依赖 REST 侧 fieldMask 开关**，AC-M6-2 恒定生效）。
    const cap = await ctx.port.fieldCapabilityOf({ kind: "table", id: t.id });
    const visible = cap.visibleAll || cap.visibleFields === null
      ? fields
      : fields.filter((f) => cap.visibleFields!.includes(f.id));
    out.push({
      tableId: t.id,
      name: t.name,
      // 选择类字段（singleSelect/multiSelect）附 options，客户端据此把记录里的选项 id 映射成名称。
      fields: visible.map((f) =>
        withSelectOptions(f, { fieldId: f.id, name: f.name, type: f.type, required: f.required, unique: f.unique }),
      ),
      truncatedScope: acc.truncated,
    });
  }
  return text(JSON.stringify({ baseId, tables: out }));
}
