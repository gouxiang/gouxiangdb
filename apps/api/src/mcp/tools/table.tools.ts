// M6/S3 table 族工具（S3 只落最小可用件 `table.list_bases`；S4 补齐 get_schema 与 record.*）。
//
// 纪律：handler 只编排——可见集与单资源判定**全部经权限端口（M4）**；不 import 旧守卫、不裸查 prisma。

import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

/** table.list_bases：列出主体可见的 base（闸门一给候选集，闸门二逐 base 复核 r）。 */
export async function tableListBases(ctx: ToolCtx): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const acc = await ctx.port.listAccessibleResources("table");
  const candidates = acc.byKind.base ?? [];
  const allowed: string[] = [];
  for (const id of candidates) {
    if (await ctx.port.can("r", { kind: "base", id })) allowed.push(id);
  }
  if (allowed.length === 0) return deny("FORBIDDEN_RESOURCE", "当前主体没有任何可见的 base");
  return text(JSON.stringify({ bases: allowed, truncated: acc.truncated }));
}
