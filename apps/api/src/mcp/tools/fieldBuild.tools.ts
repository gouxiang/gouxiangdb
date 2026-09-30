// MCP table 族字段搭建工具：field.create_field / update_field / delete_field。
//
// 纪律：handler 只编排——资源判定经权限端口（table 节点 manage_schema，M4 闸门二），
// 结构写经 domain/fieldService（REST 与 MCP 同一事务体），类型权威校验经
// domain/fieldValidation（与 routes/fields.ts 同口径）；本文件不 import 旧守卫、不裸查 prisma。

import {
  createField, updateField, deleteField,
  type CreateFieldInput, type UpdateFieldInput,
} from "../../domain/fieldService.js";
import { fieldBriefById, fieldConfigById, tableBriefById } from "../../domain/mcpReadModels.js";
import { validateFieldConfig, type FieldConfigView } from "../../domain/fieldValidation.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

function noEngine(): ToolResult {
  return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
}

function asCreateInput(args: Record<string, unknown>, tableId: string): CreateFieldInput {
  return {
    tableId,
    name: String(args.name ?? ""),
    type: String(args.type ?? ""),
    description: (args.description as string | null | undefined) ?? null,
    required: args.required === true,
    unique: args.unique === true,
    options: (args.options as CreateFieldInput["options"]) ?? null,
    precision: (args.precision as number | null | undefined) ?? null,
    maxLength: (args.maxLength as number | null | undefined) ?? null,
    defaultNow: args.defaultNow === true,
    relatedTableId: (args.relatedTableId as string | null | undefined) ?? null,
    relationKind: (args.relationKind as CreateFieldInput["relationKind"]) ?? null,
    linkDisplayFieldId: (args.linkDisplayFieldId as string | null | undefined) ?? null,
    lookupFieldId: (args.lookupFieldId as string | null | undefined) ?? null,
    linkFieldId: (args.linkFieldId as string | null | undefined) ?? null,
    rollupFunction: (args.rollupFunction as string | null | undefined) ?? null,
    formula: (args.formula as string | null | undefined) ?? null,
    recordFilter: (args.recordFilter as unknown) ?? null,
  };
}

/** field.create_field：table 节点 manage_schema + confirm；跨 base 关联拦 + 类型校验。 */
export async function fieldCreateField(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const tableId = String(args.tableId ?? "");
  if (!(await ctx.port.can("manage_schema", { kind: "table", id: tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该表设计字段（或该表不存在）");
  }
  const table = await tableBriefById(tableId);
  if (!table) return deny("FORBIDDEN_RESOURCE", "数据表不存在");
  const input = asCreateInput(args, tableId);

  // 跨 Base 越权防护：关联/子表字段的目标表必须与本表同 Base（与 routes/fields.ts 同口径）。
  if (input.relatedTableId) {
    const target = await tableBriefById(input.relatedTableId);
    if (!target) return deny("INVALID_PARAMS", "关联的数据表不存在");
    if (target.baseId !== table.baseId) {
      return deny("INVALID_PARAMS", "关联字段只能指向同一数据库内的数据表");
    }
  }
  const validationError = await validateFieldConfig(tableId, {
    type: input.type,
    formula: input.formula ?? null,
    lookupFieldId: input.lookupFieldId ?? null,
    rollupFunction: input.rollupFunction ?? null,
    linkDisplayFieldId: input.linkDisplayFieldId ?? null,
    relatedTableId: input.relatedTableId ?? null,
    linkFieldId: input.linkFieldId ?? null,
  });
  if (validationError) return deny("INVALID_PARAMS", validationError);

  const result = await createField(input, ctx.subject.userId);
  const canRead = await ctx.port.can("r", { kind: "table", id: tableId });
  return text(JSON.stringify(canRead
    ? { ok: true, field: result.field, reverseField: result.reverseField ?? null }
    : { ok: true }));
}

function patchFromArgs(args: Record<string, unknown>): UpdateFieldInput {
  const out: UpdateFieldInput = {};
  const keys: (keyof UpdateFieldInput)[] = [
    "name", "description", "required", "unique", "order", "options", "precision",
    "maxLength", "defaultNow", "recordFilter", "relatedTableId", "relationKind",
    "linkDisplayFieldId", "lookupFieldId", "linkFieldId", "rollupFunction", "formula",
  ];
  for (const k of keys) {
    if (args[k] !== undefined) (out as Record<string, unknown>)[k] = args[k];
  }
  return out;
}

/** field.update_field：table 节点 manage_schema；合并已有配置后类型校验。 */
export async function fieldUpdateField(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const fieldId = String(args.fieldId ?? "");
  const brief = await fieldBriefById(fieldId);
  if (!brief) return deny("FORBIDDEN_RESOURCE", "字段不存在");
  if (!(await ctx.port.can("manage_schema", { kind: "table", id: brief.tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该表设计字段（或该表不存在）");
  }
  const patch = patchFromArgs(args);
  // 合并已有配置再校验（PATCH 是部分提交；与 routes/fields.ts 同口径）。
  const existing = await fieldConfigById(fieldId);
  if (!existing) return deny("FORBIDDEN_RESOURCE", "字段不存在");
  const pick = <T,>(v: T | undefined, cur: T): T => (v === undefined ? cur : v);
  const merged: FieldConfigView = {
    type: existing.type,
    formula: pick(patch.formula, existing.formula),
    lookupFieldId: pick(patch.lookupFieldId, existing.lookupFieldId),
    rollupFunction: pick(patch.rollupFunction, existing.rollupFunction),
    linkDisplayFieldId: pick(patch.linkDisplayFieldId, existing.linkDisplayFieldId),
    relatedTableId: pick(patch.relatedTableId, existing.relatedTableId),
    linkFieldId: pick(patch.linkFieldId, existing.linkFieldId),
  };
  const validationError = await validateFieldConfig(existing.tableId, merged);
  if (validationError) return deny("INVALID_PARAMS", validationError);

  const updated = await updateField(fieldId, patch, ctx.subject.userId);
  if (!updated) return deny("FORBIDDEN_RESOURCE", "字段不存在");
  const canRead = await ctx.port.can("r", { kind: "table", id: brief.tableId });
  return text(JSON.stringify(canRead ? { ok: true, field: updated } : { ok: true }));
}

/** field.delete_field：table 节点 manage_schema + confirm；级联软删。 */
export async function fieldDeleteField(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const fieldId = String(args.fieldId ?? "");
  const brief = await fieldBriefById(fieldId);
  if (!brief) return deny("FORBIDDEN_RESOURCE", "字段不存在");
  if (!(await ctx.port.can("manage_schema", { kind: "table", id: brief.tableId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该表设计字段（或该表不存在）");
  }
  const { deleted } = await deleteField(fieldId, ctx.subject.userId);
  const canRead = await ctx.port.can("r", { kind: "table", id: brief.tableId });
  return text(JSON.stringify(canRead ? { ok: true, deleted } : { ok: true }));
}
