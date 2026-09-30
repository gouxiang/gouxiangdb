// MCP 搭建工具入参 shape（table/field 结构写）。
//
// zod4 隔离：本文件不直接 `import "zod/v4"`（唯一允许处是 schemas.ts），而是复用从 schemas.ts
// 转出的同一个 zod4 实例 z，既守住隔离守卫、又让本文件独立成篇（schemas.ts ≤300 行）。
// 入参字段口径与 routes/fields.ts 的 zod3 schema 对齐；服务端权威校验仍走 domain/fieldValidation。

import { z, requestId } from "./schemas.js";

/** 全部字段类型（与 shared-types FIELD_TYPES 同域，30 枚）。 */
export const FIELD_TYPE_VALUES = [
  "singleLineText", "longText", "richText", "number", "currency", "percent", "duration",
  "date", "datetime", "checkbox", "singleSelect", "multiSelect", "email", "url", "phone",
  "rating", "autoNumber", "json", "attachment", "links", "lookup", "rollup", "count",
  "formula", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy",
  "tabs", "subtable",
] as const;

const mcpSelectOptionShape = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

/** table.create_table：在 base 下建表（需 manage_schema + confirm）。 */
export const createTableShape = {
  baseId: z.string().min(1).describe("基础库 id（须在该令牌有 base 节点 manage_schema 权限）"),
  name: z.string().min(1).max(80).describe("表名（trim 后落库；同库唯一）"),
  withDefaults: z.boolean().optional().describe("是否同时建数量/状态/日期/备注四个默认字段"),
  confirm: z.literal(true).describe("写入确认；必须是字面量 true"),
  requestId,
};

/** table.update_table：改名/主字段/图标（需 manage_table）。 */
export const updateTableShape = {
  tableId: z.string().min(1),
  name: z.string().min(1).max(80).optional().describe("新表名（仅传 name 时改名；同库唯一）"),
  primaryFieldId: z.string().min(1).optional(),
  icon: z.string().nullable().optional().describe("自定义图标名（白名单）；null=清除"),
  iconColor: z.string().nullable().optional().describe("图标颜色 #RRGGBB；null=清除"),
  requestId,
};

/** table.delete_table：软删表（需 manage_table + confirm）。 */
export const deleteTableShape = {
  tableId: z.string().min(1),
  confirm: z.literal(true).describe("删除确认；必须是字面量 true（破坏性操作强制显式确认）"),
  requestId,
};

/** field.create_field：建字段（表节点需 manage_schema + confirm）。 */
export const createFieldShape = {
  tableId: z.string().min(1),
  name: z.string().min(1).max(80),
  type: z.enum(FIELD_TYPE_VALUES),
  description: z.string().nullable().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  options: z.array(mcpSelectOptionShape).nullable().optional(),
  precision: z.number().int().min(0).max(8).nullable().optional(),
  maxLength: z.number().int().min(0).nullable().optional(),
  defaultNow: z.boolean().optional(),
  relatedTableId: z.string().nullable().optional(),
  relationKind: z.enum(["mm", "hm", "bt"]).nullable().optional(),
  linkDisplayFieldId: z.string().nullable().optional(),
  lookupFieldId: z.string().nullable().optional(),
  linkFieldId: z.string().nullable().optional(),
  rollupFunction: z.enum(["sum", "avg", "min", "max", "count"]).nullable().optional(),
  formula: z.string().nullable().optional(),
  recordFilter: z.unknown().nullable().optional(),
  confirm: z.literal(true).describe("写入确认；必须是字面量 true"),
  requestId,
};

/** field.update_field：更新字段（需 manage_schema）。 */
export const updateFieldShape = {
  fieldId: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  description: z.string().nullable().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
  options: z.array(mcpSelectOptionShape).nullable().optional(),
  precision: z.number().int().min(0).max(8).nullable().optional(),
  maxLength: z.number().int().min(0).nullable().optional(),
  defaultNow: z.boolean().optional(),
  recordFilter: z.unknown().nullable().optional(),
  relatedTableId: z.string().nullable().optional(),
  relationKind: z.enum(["mm", "hm", "bt"]).nullable().optional(),
  linkDisplayFieldId: z.string().nullable().optional(),
  lookupFieldId: z.string().nullable().optional(),
  linkFieldId: z.string().nullable().optional(),
  rollupFunction: z.enum(["sum", "avg", "min", "max", "count"]).nullable().optional(),
  formula: z.string().nullable().optional(),
  requestId,
};

/** field.delete_field：软删字段（需 manage_schema + confirm）。 */
export const deleteFieldShape = {
  fieldId: z.string().min(1),
  confirm: z.literal(true).describe("删除确认；必须是字面量 true（破坏性操作强制显式确认）"),
  requestId,
};
