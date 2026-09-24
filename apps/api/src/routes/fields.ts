// apps/api/src/routes/fields.ts
// 字段 CRUD + 排序 + Lookup 候选 + 关系类型元数据

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteBatch } from "../db.js";
import { requireCanView, HttpError } from "../guards.js";
import { requireSchemaDesign } from "../domain/authz/tableManageGuards.js";
import { createField, updateField, deleteField, lookupTargetFields, relationDisplayName, relationIsMultiple } from "../domain/fieldService.js";
import { loadTableFields } from "../domain/recordService.js";
import { invalidateOrdinalCache } from "../domain/prismaDeps.js";
import { validateFieldConfig, type FieldConfigView } from "../domain/fieldValidation.js";

export const fields = new Hono();

const FIELD_TYPE_ENUM = z.enum([
  "singleLineText", "longText", "richText", "number", "currency", "percent", "duration",
  "date", "datetime", "checkbox", "singleSelect", "multiSelect", "email", "url", "phone",
  "rating", "autoNumber", "json", "attachment", "links", "lookup", "rollup", "count",
  "formula", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy",
  "tabs",
  "subtable",
]);

const selectOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

const tabFieldWidth = z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]);

const tabLayoutItemSchema = z.object({
  fieldId: z.string(),
  widthPct: tabFieldWidth,
});

const tabConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  fieldIds: z.array(z.string()),
  // widths / rows 必须显式声明，否则 zod object 默认剥离未知 key（tab 内字段宽度不落库的根因）
  widths: z.record(z.string(), tabFieldWidth).optional(),
  rows: z.array(z.object({ items: z.array(tabLayoutItemSchema) })).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  type: FIELD_TYPE_ENUM,
  description: z.string().nullish(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  options: z.array(selectOptionSchema).nullish(),
  precision: z.number().int().min(0).max(8).nullish(),
  maxLength: z.number().int().min(0).nullish(),
  defaultNow: z.boolean().optional(),
  relatedTableId: z.string().nullish(),
  relationKind: z.enum(["mm", "hm", "bt"]).nullish(),
  linkDisplayFieldId: z.string().nullish(),
  lookupFieldId: z.string().nullish(),
  linkFieldId: z.string().nullish(),
  rollupFunction: z.enum(["sum", "avg", "min", "max", "count"]).nullish(),
  formula: z.string().nullish(),
  recordFilter: z.unknown().nullish(),
  tabsConfig: z.array(tabConfigSchema).nullish(),
  displayedFieldIds: z.array(z.string()).nullish(),
  visibleFieldIds: z.array(z.string()).nullish(),
  defaultConfig: z.unknown().nullish(),
  numberRule: z.unknown().nullish(),
});

const updateSchema = createSchema.partial().extend({ order: z.number().int().min(0).optional() });

async function baseIdOfTable(tableId: string): Promise<string> {
  const t = await prisma.table.findUnique({ where: { id: tableId }, select: { baseId: true } });
  if (!t) throw new HttpError(404, "数据表不存在");
  return t.baseId;
}

// ============ 列表 ============

fields.get("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  await requireCanView(c, baseId);
  return c.json({ fields: await loadTableFields(tableId) });
});

// ============ 创建 ============

fields.post("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  await requireSchemaDesign(c, tableId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  // 重名/空名校验已收口进 createField 事务体内（domain/fieldServiceTx.ts），
  // 事务前查重存在 TOCTOU，且无法 trim 拦截纯空格。

  // 跨 Base 越权防护：关联/子表字段的目标表必须与本表属于同一 Base。
  if (parsed.data.relatedTableId) {
    const target = await prisma.table.findUnique({
      where: { id: parsed.data.relatedTableId },
      select: { baseId: true, deletedAt: true },
    });
    if (!target || target.deletedAt) return c.json({ error: "关联的数据表不存在" }, 400);
    if (target.baseId !== baseId) {
      return c.json({ error: "关联字段只能指向同一数据库内的数据表" }, 400);
    }
  }

  // 类型校验：默认内容跨类型关联 / 公式输出类型 / rollup 函数与字段类型 / 关联标题字段等
  const validationError = await validateFieldConfig(tableId, {
    type: parsed.data.type,
    formula: parsed.data.formula ?? null,
    lookupFieldId: parsed.data.lookupFieldId ?? null,
    rollupFunction: parsed.data.rollupFunction ?? null,
    linkDisplayFieldId: parsed.data.linkDisplayFieldId ?? null,
    relatedTableId: parsed.data.relatedTableId ?? null,
    // 查阅/聚合/计数的关联源：由 validateFieldConfig 判定是否为「本表的 links 字段」
    linkFieldId: parsed.data.linkFieldId ?? null,
    defaultConfig: parsed.data.defaultConfig ?? null,
  });
  if (validationError) return c.json({ error: validationError }, 400);

  // 结构写的串行化 + 事务已由 fieldService 内部 withWriteTx 提供；外层不再包 runWrite，
  // 否则外层占住并发度 1 的写队列、内部 withWriteTx 再入队会自死锁（db.ts 铁律）。
  const result = await createField({
      tableId,
      name: parsed.data.name,
      type: parsed.data.type,
      description: parsed.data.description ?? null,
      required: parsed.data.required,
      unique: parsed.data.unique,
      options: parsed.data.options ?? null,
      precision: parsed.data.precision ?? null,
      maxLength: parsed.data.maxLength ?? null,
      defaultNow: parsed.data.defaultNow ?? false,
      recordFilter: parsed.data.recordFilter ?? null,
      relatedTableId: parsed.data.relatedTableId ?? null,
      relationKind: parsed.data.relationKind ?? null,
      linkDisplayFieldId: parsed.data.linkDisplayFieldId ?? null,
      lookupFieldId: parsed.data.lookupFieldId ?? null,
      linkFieldId: parsed.data.linkFieldId ?? null,
      rollupFunction: parsed.data.rollupFunction ?? null,
      formula: parsed.data.formula ?? null,
      tabsConfig: parsed.data.tabsConfig ?? null,
      displayedFieldIds: parsed.data.displayedFieldIds ?? null,
      visibleFieldIds: parsed.data.visibleFieldIds ?? null,
      defaultConfig: parsed.data.defaultConfig ?? null,
      numberRule: parsed.data.numberRule ?? null,
    });

  return c.json({ field: result.field, reverseField: result.reverseField ?? null }, 201);
});

// ============ 更新 ============

fields.patch("/:fieldId", async (c) => {
  const fieldId = c.req.param("fieldId");
  const fieldRow = await prisma.field.findUnique({
    where: { id: fieldId },
    select: { tableId: true, table: { select: { baseId: true } } },
  });
  if (!fieldRow) throw new HttpError(404, "字段不存在");
  await requireSchemaDesign(c, fieldRow.tableId);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  // 类型校验：用「已有字段配置 + 本次补丁」合并出有效视图后校验（update 是部分提交）
  const existingRow = await prisma.field.findFirst({ where: { id: fieldId, deletedAt: null } });
  if (!existingRow) throw new HttpError(404, "字段不存在");
  const safeParse = <T,>(s: string | null): T | null => {
    if (!s) return null;
    try { return JSON.parse(s) as T; } catch { return null; }
  };
  const existingDefault = safeParse<Record<string, unknown>>(existingRow.defaultConfig);
  const patchDefault = (parsed.data.defaultConfig ?? undefined) as Record<string, unknown> | null | undefined;
  const mergedConfig: FieldConfigView = {
    type: existingRow.type,
    formula: parsed.data.formula !== undefined ? (parsed.data.formula ?? null) : (existingRow.formula ?? null),
    lookupFieldId: parsed.data.lookupFieldId !== undefined ? (parsed.data.lookupFieldId ?? null) : (existingRow.lookupFieldId ?? null),
    rollupFunction: parsed.data.rollupFunction !== undefined ? (parsed.data.rollupFunction ?? null) : (existingRow.rollupFunction ?? null),
    linkDisplayFieldId: parsed.data.linkDisplayFieldId !== undefined ? (parsed.data.linkDisplayFieldId ?? null) : (existingRow.linkDisplayFieldId ?? null),
    relatedTableId: parsed.data.relatedTableId !== undefined ? (parsed.data.relatedTableId ?? null) : (existingRow.relatedTableId ?? null),
    // 合并已有配置再校验：PATCH 只改子字段时也要守住「关联源必须是 links」这一条
    linkFieldId: parsed.data.linkFieldId !== undefined ? (parsed.data.linkFieldId ?? null) : (existingRow.linkFieldId ?? null),
    defaultConfig: patchDefault === undefined ? existingDefault : patchDefault,
  };
  const validationError = await validateFieldConfig(existingRow.tableId, mergedConfig);
  if (validationError) return c.json({ error: validationError }, 400);

  // 注意：直接透传 parsed.data 的值。zod 未提供的 key 为 undefined（service 跳过不改），
  // 显式 null 会原样转发（service 据此清空字段）。不能用 `?? undefined`，否则把清空用的 null 吞掉。
  // 串行化 + 事务由 updateField 内部 withWriteTx 提供，外层不包 runWrite（避免自死锁）。
  const updated = await updateField(fieldId, {
    name: parsed.data.name,
    description: parsed.data.description,
    required: parsed.data.required,
    unique: parsed.data.unique,
    order: parsed.data.order,
    options: parsed.data.options,
    precision: parsed.data.precision,
    maxLength: parsed.data.maxLength,
    defaultNow: parsed.data.defaultNow,
    recordFilter: parsed.data.recordFilter,
    relationKind: parsed.data.relationKind,
    linkDisplayFieldId: parsed.data.linkDisplayFieldId,
    lookupFieldId: parsed.data.lookupFieldId,
    linkFieldId: parsed.data.linkFieldId,
    rollupFunction: parsed.data.rollupFunction,
    formula: parsed.data.formula,
    tabsConfig: parsed.data.tabsConfig,
    relatedTableId: parsed.data.relatedTableId,
    displayedFieldIds: parsed.data.displayedFieldIds,
    visibleFieldIds: parsed.data.visibleFieldIds,
    defaultConfig: parsed.data.defaultConfig,
    numberRule: parsed.data.numberRule,
  });
  if (!updated) throw new HttpError(404, "字段不存在");
  return c.json({ field: updated });
});

// ============ 删除 ============

fields.delete("/:fieldId", async (c) => {
  const fieldId = c.req.param("fieldId");
  const fieldRow = await prisma.field.findUnique({
    where: { id: fieldId },
    select: { tableId: true, table: { select: { baseId: true } } },
  });
  if (!fieldRow) throw new HttpError(404, "字段不存在");
  await requireSchemaDesign(c, fieldRow.tableId);
  const { deleted } = await deleteField(fieldId);
  return c.json({ ok: true, deleted });
});

// ============ 排序 ============

const moveSchema = z.object({ toIndex: z.number().int().min(0) });

fields.post("/:fieldId/move", async (c) => {
  const fieldId = c.req.param("fieldId");
  const f0 = await prisma.field.findUnique({
    where: { id: fieldId },
    select: { tableId: true, table: { select: { baseId: true } } },
  });
  if (!f0) throw new HttpError(404, "字段不存在");
  await requireSchemaDesign(c, f0.tableId);

  const parsed = moveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const f = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!f) throw new HttpError(404, "字段不存在");

  const all = await prisma.field.findMany({
    where: { tableId: f.tableId, deletedAt: null },
    orderBy: { order: "asc" },
  });
  const from = all.findIndex((x) => x.id === fieldId);
  if (from === -1) throw new HttpError(404, "字段不存在");
  const to = Math.min(parsed.data.toIndex, all.length - 1);

  const reordered = [...all];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);

  await withWriteBatch(
    "field.reorder",
    reordered.map((x, i) => prisma.field.update({ where: { id: x.id }, data: { order: i } })),
  );
  return c.json({ fields: await loadTableFields(f.tableId) });
});

// ============ Lookup/Rollup 候选字段 ============

fields.get("/lookup-targets", async (c) => {
  const linkFieldId = c.req.query("linkFieldId");
  if (!linkFieldId) return c.json({ error: "缺少 linkFieldId" }, 400);
  const lf = await prisma.field.findUnique({
    where: { id: linkFieldId },
    select: { table: { select: { baseId: true } } },
  });
  if (!lf) throw new HttpError(404, "关联字段不存在");
  await requireCanView(c, lf.table.baseId);
  return c.json({ fields: await lookupTargetFields(linkFieldId) });
});

// ============ 关系类型元数据 ============

fields.get("/relation-types", async (c) => {
  void c;
  const kinds = ["mm", "hm", "bt"] as const;
  return c.json({
    relationTypes: kinds.map((k) => ({
      id: k,
      name: relationDisplayName(k),
      isMultiple: relationIsMultiple(k),
      reverse: relationDisplayName(
        k === "mm" ? "mm" : k === "hm" ? "bt" : "hm",
      ),
    })),
  });
});

export { invalidateOrdinalCache };
