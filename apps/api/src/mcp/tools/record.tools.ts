// M6/S4 record 族只读工具（list_records / query_records / record.search）。
//
// 纪律：handler 只编排——资源判定经权限端口（M4 闸门二），数据读取经既有 domain service
// （recordService.queryRecords / loadTableFields、M5 queryRuntime+executeUnifiedSearch），
// 掩码经 M4 maskGate.resolveTableMask；本文件不 import 旧守卫、不裸查 prisma。
// 字段物理缺席（AC-M6-2）：把【可见字段子集】与【脱敏 config】下推给 queryRecords，
// 与 REST 同口径（routes/records.ts 的 mask 消费方式一致）。

import { loadTableFields, parseViewConfig, queryRecords } from "../../domain/recordService.js";
import { runMcpUnifiedSearch } from "../../domain/mcpSearchBridge.js";
import { config } from "../../config.js";
import { recordBriefById } from "../../domain/mcpReadModels.js";
import { createRecordTx, softDeleteRecordTx } from "../../domain/recordWrite.js";
import { applyCreateDefaults, applyReverseDefaultsForChild } from "../../domain/defaults.js";
import { runWrite, withWriteTx } from "../../db.js";
import { buildFilterNode, buildSortSpec, InvalidParamsError, type FilterArg } from "./filterMap.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

interface ReadArgs { tableId: string; cursor?: string; limit?: number; search?: string; filter?: unknown; sortFieldId?: string; sortDirection?: "asc" | "desc" }

/** 读前置：表可见（闸门二 r）。返回 null 表示已拒绝（返回体已构造）。 */
async function guardTable(ctx: ToolCtx, tableId: string): Promise<ToolResult | null> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const ok = await ctx.port.can("r", { kind: "table", id: tableId });
  return ok ? null : deny("FORBIDDEN_RESOURCE", "无权访问该表（或该表不存在）");
}

/** 记录读出参投影：不可见字段物理缺席（与 REST 同口径）。 */
function project(rows: Array<Record<string, unknown>>, visibleFieldIds: string[] | null): Array<Record<string, unknown>> {
  if (visibleFieldIds === null) return rows;
  const allow = new Set(visibleFieldIds);
  return rows.map((r) => {
    const fields = (r.fields ?? {}) as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (allow.has(k)) kept[k] = v;
    return { ...r, fields: kept };
  });
}

async function readPage(ctx: ToolCtx, args: ReadArgs, withFilter: boolean): Promise<ToolResult> {
  const denied = await guardTable(ctx, args.tableId);
  if (denied) return denied;
  const port = ctx.port!; // guardTable 已确认非 null
  const fields = await loadTableFields(args.tableId);
  // 字段面经权限端口（M4 引擎 capability；不依赖 REST 侧 fieldMask 开关）
  const cap = await port.fieldCapabilityOf({ kind: "table", id: args.tableId });
  const visibleIds = cap.visibleAll || cap.visibleFields === null ? null : cap.visibleFields;
  const queryFields = visibleIds === null ? fields : fields.filter((f) => visibleIds.includes(f.id));

  const baseConfig = parseViewConfig(null);
  const filterNode = withFilter ? buildFilterNode(args.filter as FilterArg[] | undefined) : null;
  const sortSpec = withFilter ? buildSortSpec(args.sortFieldId, args.sortDirection) : null;
  const config2 = {
    ...baseConfig,
    ...(filterNode ? { filters: filterNode } : {}),
    ...(sortSpec ? { sorts: sortSpec } : {}),
  };

  let result;
  try {
    result = await queryRecords({
      tableId: args.tableId, fields: queryFields, config: config2,
      limit: args.limit ?? 50, cursor: args.cursor ?? null, search: args.search,
      // 掩码外字段在编译期禁止物理下推（纵深防御，与 REST 同口径）
      compileDeniedFieldIds: visibleIds === null ? null : new Set(fields.filter((f) => !visibleIds.includes(f.id)).map((f) => f.id)),
    });
  } catch (e) {
    const code = (e as { name?: string }).name;
    if (code === "InvalidCursorError" || code === "OffsetWindowError") {
      return deny("INVALID_PARAMS", (e as Error).message);
    }
    if (e instanceof InvalidParamsError) return deny("INVALID_PARAMS", e.message);
    throw e;
  }
  const payload = {
    records: project(result.records as unknown as Array<Record<string, unknown>>, visibleIds),
    total: result.total, filteredTotal: result.filteredTotal,
    nextCursor: result.nextCursor ?? null, hasMore: result.hasMore ?? false,
    truncatedScope: false,
  };
  return text(JSON.stringify(payload));
}

/** record.list_records：无过滤的 keyset 分页读。 */
export async function recordListRecords(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  return readPage(ctx, args as unknown as ReadArgs, false);
}

/** record.query_records：受控 filter/sort 的 keyset 分页读（禁公式/裸 SQL）。 */
export async function recordQueryRecords(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  return readPage(ctx, args as unknown as ReadArgs, true);
}

/** record.search：薄封装 M5 统一检索（scope 先收敛由 M5 保证，MCP 侧只做 PAT 粗档，不重复鉴权）。 */
export async function recordSearch(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (config.m5Search === "off") return deny("INVALID_PARAMS", "统一检索未启用（GX_M5_SEARCH=off）");
  const q = String(args.q ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const mode = (args.mode as "auto" | "fts" | "vector" | undefined) ?? "auto";
  try {
    const res = await runMcpUnifiedSearch(ctx.subject.userId, q, mode, limit);
    return text(JSON.stringify(res));
  } catch (err) {
    // 检索不可用（search.db 缺失/损坏、provider 故障）：结构化错误，**不 500 不挂死**。
    return deny("INVALID_PARAMS", `统一检索暂不可用：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * record.delete_record（C-6）：confirm 已由 zod4 literal 强制；执行期 enforce `d`（闸门二）；
 * **软删与 REST DELETE 同语义**（复用 domain/recordWrite.softDeleteRecordTx：软删 + 关联软删 +
 * sidecar 撤销 + outbox delete），事务边界与 REST 一致（withWriteTx("record.softDelete")）。
 * 写后无 `r` 时返回精简回执（不回记录内容）。
 */
export async function recordDeleteRecord(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const tableId = String(args.tableId ?? "");
  const recordId = String(args.recordId ?? "");
  if (!(await ctx.port.can("d", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权删除该表的记录（或该表不存在）");
  }
  const brief = await recordBriefById(recordId);
  if (!brief || brief.deletedAt !== null || brief.tableId !== tableId) {
    return deny("FORBIDDEN_RESOURCE", "记录不存在或不属于该表");
  }
  await withWriteTx("record.softDelete", (tx) => softDeleteRecordTx(tx, recordId));
  // 反向联动（与 REST 同口径；失败不阻断删除结果，已提交的软删不回滚）
  try {
    await runWrite("defaults.reverseOnDelete", async () => {
      await applyReverseDefaultsForChild(tableId, [recordId], ctx.subject.userId, { includeDeleted: true });
    });
  } catch (err) {
    console.error("[mcp] reverse recalc on delete failed:", err);
  }
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead ? { ok: true, recordId, deleted: true } : { ok: true }));
}

/**
 * record.create_record：闸门二 enforce `c`（+ 字段级写权，非全写来源时按可见字段集保守收窄）；
 * 复用 domain/recordWrite.createRecordTx（与 REST 同一事务体）；事务后 defaults 补偿写（失败不阻断）；
 * 写而无 `r` -> 精简回执 `{ok:true}`（不回字段映射，防派生值泄漏）。
 */
export async function recordCreateRecord(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const tableId = String(args.tableId ?? "");
  const payloadFields = (args.fields ?? {}) as Record<string, unknown>;
  if (!(await ctx.port.can("c", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该表创建记录（或该表不存在）");
  }
  // 字段级：非「全字段可写」来源时，payload 键必须落在可见字段集内，否则整单拒绝（不静默丢弃）
  const cap = await ctx.port.fieldCapabilityOf({ kind: "table", id: tableId });
  if (!cap.writableAll) {
    const allowed = new Set(cap.visibleFields ?? []);
    const bad = Object.keys(payloadFields).filter((k) => !allowed.has(k));
    if (bad.length > 0) return deny("FORBIDDEN_FIELD", `不可写字段：${bad.join(", ")}`);
  }
  const fields = await loadTableFields(tableId);
  const created = await withWriteTx("record.create", (tx) =>
    createRecordTx(tx, { tableId, payloadFields, fields, userId: ctx.subject.userId, isDraft: false }),
  );
  try {
    await runWrite("defaults.create", () => applyCreateDefaults(tableId, created.id, ctx.subject.userId));
  } catch (err) {
    console.error("[mcp] defaults.create failed (不阻断):", err);
  }
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead ? { ok: true, recordId: created.id } : { ok: true }));
}
