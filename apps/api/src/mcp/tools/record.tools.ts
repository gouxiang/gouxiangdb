// M6/S4 record 族只读工具（list_records / query_records / record.search）。
//
// 纪律：handler 只编排——资源判定经权限端口（M4 闸门二），数据读取经既有 domain service
// （recordService.queryRecords / loadTableFields、M5 queryRuntime+executeUnifiedSearch），
// 掩码经 M4 maskGate.resolveTableMask；本文件不 import 旧守卫、不裸查 prisma。
// 字段物理缺席（AC-M6-2）：把【可见字段子集】与【脱敏 config】下推给 queryRecords，
// 与 REST 同口径（routes/records.ts 的 mask 消费方式一致）。

import { loadTableFields, parseViewConfig, queryRecords } from "../../domain/recordService.js";
import { runMcpUnifiedSearch } from "../../domain/mcpSearchBridge.js";
import type { SearchEntityType } from "../../domain/search/queryPlan.js";
import {
  assertWriteOnlyFields,
  AuthzFieldError,
  NON_WRITABLE_FIELD_TYPES,
} from "../../domain/authz/fieldMask.js";
import type { FieldMeta } from "../../domain/types.js";
import { config } from "../../config.js";
import { recordBriefById } from "../../domain/mcpReadModels.js";
import { createRecordTx, softDeleteRecordTx, updateRecordTx } from "../../domain/recordWrite.js";
import { applyCreateDefaults, applyEditDefaults, applyReverseDefaultsForChild } from "../../domain/defaults.js";
import { runWrite, withWriteTx } from "../../db.js";
import { buildFilterNode, buildSortSpec, InvalidParamsError, type FilterArg } from "./filterMap.js";
import { displaySelectValue, indexSelectOptions, type SelectDisplayIndex } from "./selectFields.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

interface ReadArgs { tableId: string; cursor?: string; limit?: number; search?: string; filter?: unknown; sortFieldId?: string; sortDirection?: "asc" | "desc" }

/** 读前置：表可见（闸门二 r）。返回 null 表示已拒绝（返回体已构造）。 */
async function guardTable(ctx: ToolCtx, tableId: string): Promise<ToolResult | null> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const ok = await ctx.port.can("r", { kind: "table", id: tableId });
  return ok ? null : deny("FORBIDDEN_RESOURCE", "无权访问该表（或该表不存在）");
}

/**
 * 记录读出参投影：不可见字段物理缺席（与 REST 同口径）。
 *
 * selectIndex 非空时额外输出 `fieldsDisplay`：一份与 fields 同键的**只读可读镜像**，
 * 仅把选择类字段的选项 id 换成选项名；fields 本身维持 id 原值（写工具回写依赖它）。
 * selectIndex 为 null（表内无选择类字段）时完全不输出该键，避免无谓膨胀。
 */
function project(
  rows: Array<Record<string, unknown>>,
  visibleFieldIds: string[] | null,
  selectIndex: SelectDisplayIndex | null,
): Array<Record<string, unknown>> {
  if (visibleFieldIds === null && !selectIndex) return rows;
  const allow = visibleFieldIds === null ? null : new Set(visibleFieldIds);
  return rows.map((r) => {
    const fields = (r.fields ?? {}) as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (!allow || allow.has(k)) kept[k] = v;
    if (!selectIndex) return { ...r, fields: kept };
    const display: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(kept)) {
      const byKey = selectIndex.get(k);
      display[k] = byKey ? displaySelectValue(v, byKey) : v;
    }
    return { ...r, fields: kept, fieldsDisplay: display };
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

  // 选择类字段（单选/多选）的 id→名索引：表内无此类字段时为 null -> 不出 fieldsDisplay。
  const selectIndex: SelectDisplayIndex | null = indexSelectOptions(queryFields);

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
    records: project(result.records as unknown as Array<Record<string, unknown>>, visibleIds, selectIndex),
    total: result.total, filteredTotal: result.filteredTotal,
    nextCursor: result.nextCursor ?? null, hasMore: result.hasMore ?? false,
    truncatedScope: false,
  };
  return text(JSON.stringify(payload));
}

/**
 * P1-B 写字段守卫（fail-closed，事务前）：按写动作 c/u 取【纯写字段能力】（writeSources 语义，
 * 不要求 r 来源，只写身份也能得到正确白名单），校验 payload 的物理可写键：
 *   - 只校验存在字段定义且非服务端计算/系统类型的物理键（与 REST maskSession.assertWritable 同口径）；
 *   - writableAll=true（任一 c/u 来源 mask=null，含 creator/owner 宽来源）-> 全放行（宽授权不回归）；
 *   - 否则键必须落在可写并集内（已排除各来源 readOnlyFields）；越界/只读 -> FORBIDDEN_FIELD，整单不开事务。
 * 返回非 null 表示已构造拒绝结果。
 */
async function guardWriteFields(
  ctx: ToolCtx,
  tableId: string,
  action: "c" | "u",
  fields: FieldMeta[],
  payload: Record<string, unknown>,
): Promise<ToolResult | null> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const cap = await ctx.port.writeFieldCapabilityOf({ kind: "table", id: tableId }, action);
  // 宽来源（任一 c/u mask=null，含 creator/owner 兜底）：全字段放行，载荷键不再逐键校验。
  if (cap.writableAll) return null;
  // 掩码身份下把载荷键分三类：
  //  ① 已定义的物理可写键 -> 必须落在可写并集；
  //  ② 已定义但服务端计算/系统键（公式/lookup/rollup/…，applyFieldWrites 本就跳过）-> 不误拒（保 p1b-b4）；
  //  ③ 未知键（本表无该字段定义，如 fld_x）-> 必须拒绝，绝不静默丢弃（S4 AC：掩码身份写白名单外
  //     字段整单拒绝）。P1-B 初版只保留①，把③一并滤掉导致 fail-open（277fd95 回归），此处补回。
  const writableKeys: string[] = [];
  const unknownKeys: string[] = [];
  for (const k of Object.keys(payload)) {
    const f = fields.find((x) => x.id === k);
    if (!f) {
      unknownKeys.push(k);
    } else if (!NON_WRITABLE_FIELD_TYPES.has(f.type)) {
      writableKeys.push(k);
    }
  }
  try {
    assertWriteOnlyFields(writableKeys, {
      writeMatched: cap.matched,
      writableAll: cap.writableAll,
      writableFields: new Set(cap.writableFields),
    });
    if (unknownKeys.length) {
      throw new AuthzFieldError("包含无权写入的字段", "FORBIDDEN_FIELD", [...new Set(unknownKeys)]);
    }
  } catch (e) {
    if (e instanceof AuthzFieldError) return deny("FORBIDDEN_FIELD", e.message);
    throw e;
  }
  return null;
}

/** record.list_records：无过滤的 keyset 分页读。 */
export async function recordListRecords(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  return readPage(ctx, args as unknown as ReadArgs, false);
}

/** record.query_records：受控 filter/sort 的 keyset 分页读（禁公式/裸 SQL）。 */
export async function recordQueryRecords(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  return readPage(ctx, args as unknown as ReadArgs, true);
}

/**
 * 按 PAT 六位 scope 推导 record.search 允许检索的实体族（P0-A）：
 * record:read→record(nav kind=table)、doc:read→doc、canvas:read→canvas。
 * M5 的 scope 收敛只认登录用户 r 授权、不知道 PAT scope，故必须由 MCP 层按 scope 收窄实体族。
 * 返回空数组 = 该 PAT 无任何读族（注册层本已不发此工具，这里 fail-closed 兜底）。
 */
export function searchEntityTypesForScopes(scopes: readonly string[]): SearchEntityType[] {
  const set = new Set(scopes);
  const types: SearchEntityType[] = [];
  if (set.has("record:read")) types.push("record");
  if (set.has("doc:read")) types.push("doc");
  if (set.has("canvas:read")) types.push("canvas");
  return types;
}

/** record.search：薄封装 M5 统一检索；按 PAT scope 收窄实体族（P0-A），M5 scope 只认用户 r。 */
export async function recordSearch(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (config.m5Search === "off") return deny("INVALID_PARAMS", "统一检索未启用（GX_M5_SEARCH=off）");
  const allowedTypes = searchEntityTypesForScopes(ctx.subject.scopes);
  if (allowedTypes.length === 0) {
    // fail-closed：注册层（catalog 要求 record:read）理论上已挡住，这里纵深兜底，绝不回落全族。
    return deny("FORBIDDEN_RESOURCE", "该令牌无权检索任何实体");
  }
  const q = String(args.q ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const mode = (args.mode as "auto" | "fts" | "vector" | undefined) ?? "auto";
  try {
    const res = await runMcpUnifiedSearch(ctx.subject.userId, q, mode, limit, allowedTypes);
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
  const fields = await loadTableFields(tableId);
  // P1-B 字段级写权（fail-closed）：按 c 动作的纯写能力判定，只写身份（无 r 来源）也必须收窄；
  // 同时校验 allowFields 与 readOnlyFields。宽 c 来源（mask=null，含 creator/owner）全放行。
  const fieldDenied = await guardWriteFields(ctx, tableId, "c", fields, payloadFields);
  if (fieldDenied) return fieldDenied;
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

/**
 * record.update_record：闸门二 enforce `u` + 字段级整单拒；复用 domain/recordWrite.updateRecordTx
 * （与 REST 同一事务体）；事务后 defaults 联动（失败不阻断）；写而无 `r` -> 精简 {ok:true}。
 */
export async function recordUpdateRecord(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const tableId = String(args.tableId ?? "");
  const recordId = String(args.recordId ?? "");
  const patch = (args.fields ?? {}) as Record<string, unknown>;
  if (!(await ctx.port.can("u", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权更新该表的记录（或该表不存在）");
  }
  const fields = await loadTableFields(tableId);
  // P1-B 字段级写权（fail-closed）：按 u 动作纯写能力判定，只写身份也收窄；allow + readOnly 双校验。
  const fieldDenied = await guardWriteFields(ctx, tableId, "u", fields, patch);
  if (fieldDenied) return fieldDenied;
  const brief = await recordBriefById(recordId);
  if (!brief || brief.deletedAt !== null || brief.tableId !== tableId) {
    return deny("FORBIDDEN_RESOURCE", "记录不存在或不属于该表");
  }
  await withWriteTx("record.update", (tx) =>
    updateRecordTx(tx, { tableId, recordId, patch, fields, userId: ctx.subject.userId }),
  );
  // 编辑期默认值联动（与 REST 同口径；失败不阻断已提交的更新）
  const changed = new Set(Object.keys(patch));
  if (changed.size > 0) {
    try {
      await runWrite("defaults.edit", () => applyEditDefaults(tableId, recordId, changed, ctx.subject.userId));
    } catch (err) {
      console.error("[mcp] defaults.edit failed (不阻断):", err);
    }
  }
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead ? { ok: true, recordId } : { ok: true }));
}
