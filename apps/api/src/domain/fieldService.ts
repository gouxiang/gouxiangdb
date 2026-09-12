// apps/api/src/domain/fieldService.ts
// 字段元数据服务：创建 / 更新 / 删除
//
// 三个必须保真的 v1 行为：
//   1. 创建 links 字段时自动在关联表创建「反向字段」，两者 reverseFieldId 互指
//   2. relationKind 反向映射：mm↔mm、hm↔bt、bt↔hm（bt→bt 是 v1 修掉的真 bug）
//   3. 删除 links 字段时对称软删配对反向字段；删除被依赖字段时级联处理 lookup/rollup/count

import { prisma } from "../db.js";
import type { FieldMeta, SelectOption, TabConfig } from "./types.js";
import { toFieldMeta, invalidateOrdinalCache } from "./prismaDeps.js";

export type RelationKind = "mm" | "hm" | "bt";

/** 关系类型反向映射（v1 GXRelationType.reverse 1:1） */
export function reverseRelation(kind: RelationKind): RelationKind {
  switch (kind) {
    case "mm":
      return "mm"; // 多对多 ↔ 多对多
    case "hm":
      return "bt"; // 一对多 ↔ 多对一
    case "bt":
      return "hm"; // 多对一 ↔ 一对多
    default:
      return "mm";
  }
}

/** 关系类型显示名（v1 GXRelationType.displayName） */
export function relationDisplayName(kind: RelationKind | null): string {
  switch (kind) {
    case "mm":
      return "多对多";
    case "hm":
      return "一对多";
    case "bt":
      return "多对一";
    default:
      return "未设置";
  }
}

/** 该关系是否允许选多条（v1 isMultiple） */
export function relationIsMultiple(kind: RelationKind | null): boolean {
  return kind === "mm" || kind === "hm";
}

export const SELECT_PALETTE = [
  "#D3F0E4",
  "#F7E1D7",
  "#FBDDDD",
  "#DCE7F5",
  "#E5DEEB",
  "#FBE9D0",
  "#E1F0E8",
  "#F0E4D7",
] as const;

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function makeOptions(names: string[]): SelectOption[] {
  return names.map((name, i) => ({
    id: newId("opt"),
    name,
    color: SELECT_PALETTE[i % SELECT_PALETTE.length]!,
  }));
}

export interface CreateFieldInput {
  tableId: string;
  name: string;
  type: string;
  description?: string | null;
  required?: boolean;
  unique?: boolean;
  options?: SelectOption[] | null;
  precision?: number | null;
  maxLength?: number | null;
  defaultNow?: boolean;
  relatedTableId?: string | null;
  relationKind?: RelationKind | null;
  linkDisplayFieldId?: string | null;
  lookupFieldId?: string | null;
  linkFieldId?: string | null;
  rollupFunction?: string | null;
  formula?: string | null;
  recordFilter?: unknown | null;
  tabsConfig?: TabConfig[] | null;
  displayedFieldIds?: string[] | null;
  visibleFieldIds?: string[] | null;
  defaultConfig?: unknown | null;
  numberRule?: unknown | null;
}

export interface CreateFieldResult {
  field: FieldMeta;
  reverseField?: FieldMeta;
}

export async function createField(input: CreateFieldInput): Promise<CreateFieldResult> {
  const maxOrder = await prisma.field.findFirst({
    where: { tableId: input.tableId, deletedAt: null },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const order = maxOrder ? maxOrder.order + 1 : 0;

  // 子表格内部固定为「一对多（hm）」：一条主数据拥有多条子行（反向自动为多对一 bt）。
  // UI 隐藏关系类型选择；服务端强制，避免数据交叉混乱。
  if (input.type === "subtable" && input.relationKind) {
    input.relationKind = "hm";
  }

  // ============ links / subtable：双向自动建 ============
// subtable 在存储层与 links 完全一致（同一张 link_row 表），只是 UI 层呈现为子表格
if ((input.type === "links" || input.type === "subtable") && input.relatedTableId && input.relationKind) {
    return await createLinkFieldPair(input, order);
  }

  const created = await prisma.field.create({
    data: {
      tableId: input.tableId,
      name: input.name,
      type: input.type,
      description: input.description ?? undefined,
      order,
      required: input.required ?? false,
      unique: input.unique ?? false,
      options: input.options ? JSON.stringify(input.options) : null,
      precision: input.precision ?? undefined,
      maxLength: input.maxLength ?? undefined,
      defaultNow: input.defaultNow ?? false,
      recordFilter: input.recordFilter ? JSON.stringify(input.recordFilter) : null,
      relatedTableId: input.relatedTableId ?? undefined,
      relationKind: input.relationKind ?? undefined,
      linkDisplayFieldId: input.linkDisplayFieldId ?? undefined,
      lookupFieldId: input.lookupFieldId ?? undefined,
      linkFieldId: input.linkFieldId ?? undefined,
      rollupFunction: input.rollupFunction ?? undefined,
      formula: input.formula ?? undefined,
      tabsConfig: input.tabsConfig ? JSON.stringify(input.tabsConfig) : null,
      displayedFieldIds: input.displayedFieldIds ? JSON.stringify(input.displayedFieldIds) : null,
      visibleFieldIds: input.visibleFieldIds ? JSON.stringify(input.visibleFieldIds) : null,
      defaultConfig: input.defaultConfig ? JSON.stringify(input.defaultConfig) : null,
      numberRule: input.numberRule ? JSON.stringify(input.numberRule) : null,
    },
  });
  invalidateOrdinalCache(input.tableId);
  return { field: toFieldMeta(created) };
}

async function createLinkFieldPair(input: CreateFieldInput, order: number): Promise<CreateFieldResult> {
  const kind = input.relationKind!;
  const reverseKind = reverseRelation(kind);
  const relatedTableId = input.relatedTableId!;

  const maxReverse = await prisma.field.findFirst({
    where: { tableId: relatedTableId, deletedAt: null },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const reverseOrder = maxReverse ? maxReverse.order + 1 : 0;

  // 先建反向字段（占位，稍后回填 reverseFieldId）；与正向保持同一类型
  const reverseField = await prisma.field.create({
    data: {
      tableId: relatedTableId,
      name: `${input.name}（反向）`,
      type: input.type,
      order: reverseOrder,
      relatedTableId: input.tableId,
      relationKind: reverseKind,
      isReverse: true,
      linkDisplayFieldId: input.linkDisplayFieldId ?? undefined,
    },
  });

  // 再建正向字段，linkFieldId 指向反向字段（v1 同构：正向.linkFieldId = 反向字段 id）
  const forwardField = await prisma.field.create({
    data: {
      tableId: input.tableId,
      name: input.name,
      type: input.type,
      description: input.description ?? undefined,
      order,
      required: input.required ?? false,
      unique: input.unique ?? false,
      relatedTableId,
      relationKind: kind,
      linkFieldId: reverseField.id,
      isReverse: false,
      linkDisplayFieldId: input.linkDisplayFieldId ?? undefined,
      recordFilter: input.recordFilter ? JSON.stringify(input.recordFilter) : null,
      displayedFieldIds: input.displayedFieldIds ? JSON.stringify(input.displayedFieldIds) : null,
      visibleFieldIds: input.visibleFieldIds ? JSON.stringify(input.visibleFieldIds) : null,
      defaultConfig: input.defaultConfig ? JSON.stringify(input.defaultConfig) : null,
    },
  });

  // 互指：反向字段的 reverseFieldId / linkFieldId = 正向字段 id
  const updatedReverse = await prisma.field.update({
    where: { id: reverseField.id },
    data: { reverseFieldId: forwardField.id, linkFieldId: forwardField.id },
  });

  invalidateOrdinalCache(input.tableId);
  invalidateOrdinalCache(relatedTableId);

  return { field: toFieldMeta(forwardField), reverseField: toFieldMeta(updatedReverse) };
}

export interface UpdateFieldInput {
  name?: string;
  description?: string | null;
  required?: boolean;
  unique?: boolean;
  order?: number;
  options?: SelectOption[] | null;
  precision?: number | null;
  maxLength?: number | null;
  defaultNow?: boolean;
  recordFilter?: unknown | null;
  relatedTableId?: string | null;
  relationKind?: RelationKind | null;
  linkDisplayFieldId?: string | null;
  lookupFieldId?: string | null;
  linkFieldId?: string | null;
  rollupFunction?: string | null;
  formula?: string | null;
  tabsConfig?: TabConfig[] | null;
  displayedFieldIds?: string[] | null;
  visibleFieldIds?: string[] | null;
  defaultConfig?: unknown | null;
  numberRule?: unknown | null;
}

export async function updateField(fieldId: string, patch: UpdateFieldInput): Promise<FieldMeta | null> {
  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing || existing.deletedAt) return null;

  // 子表格关系固定 hm：忽略任何其它关系类型（UI 已隐藏选择，服务端兜底）
  if (existing.type === "subtable" && patch.relationKind !== undefined) {
    patch = { ...patch, relationKind: "hm" };
  }

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data["name"] = patch.name;
  // description 列为非空 String（@default("")），显式 null（清空提示）落库为 ""
  if (patch.description !== undefined) data["description"] = patch.description ?? "";
  if (patch.required !== undefined) data["required"] = patch.required;
  if (patch.unique !== undefined) data["unique"] = patch.unique;
  if (patch.order !== undefined) data["order"] = patch.order;
  if (patch.options !== undefined) data["options"] = patch.options ? JSON.stringify(patch.options) : null;
  if (patch.precision !== undefined) data["precision"] = patch.precision;
  if (patch.maxLength !== undefined) data["maxLength"] = patch.maxLength;
  if (patch.defaultNow !== undefined) data["defaultNow"] = patch.defaultNow;
  if (patch.recordFilter !== undefined) data["recordFilter"] = patch.recordFilter ? JSON.stringify(patch.recordFilter) : null;
  // 关联表只在「尚未建立双向配对」时允许设置（首次补配）；已配对后改表会导致反向字段与
  // link_row 仍指旧表而断链，故忽略（前端也已锁定下拉）。需改表请删除重建。
  const linkLikeExisting = existing.type === "links" || existing.type === "subtable";
  if (patch.relatedTableId !== undefined && !(linkLikeExisting && existing.linkFieldId)) {
    data["relatedTableId"] = patch.relatedTableId;
  }
  if (patch.relationKind !== undefined) data["relationKind"] = patch.relationKind;
  if (patch.linkDisplayFieldId !== undefined) data["linkDisplayFieldId"] = patch.linkDisplayFieldId;
  if (patch.lookupFieldId !== undefined) data["lookupFieldId"] = patch.lookupFieldId;
  if (patch.linkFieldId !== undefined) data["linkFieldId"] = patch.linkFieldId;
  if (patch.rollupFunction !== undefined) data["rollupFunction"] = patch.rollupFunction;
  if (patch.formula !== undefined) data["formula"] = patch.formula;
  if (patch.tabsConfig !== undefined) data["tabsConfig"] = patch.tabsConfig ? JSON.stringify(patch.tabsConfig) : null;
  if (patch.displayedFieldIds !== undefined) data["displayedFieldIds"] = patch.displayedFieldIds ? JSON.stringify(patch.displayedFieldIds) : null;
  if (patch.visibleFieldIds !== undefined) data["visibleFieldIds"] = patch.visibleFieldIds ? JSON.stringify(patch.visibleFieldIds) : null;
  if (patch.defaultConfig !== undefined) data["defaultConfig"] = patch.defaultConfig ? JSON.stringify(patch.defaultConfig) : null;
  if (patch.numberRule !== undefined) data["numberRule"] = patch.numberRule ? JSON.stringify(patch.numberRule) : null;

  const updated = await prisma.field.update({ where: { id: fieldId }, data });

  // links/subtable 首次从「无关联表」补配关联表：此时字段还是孤立占位（无 linkFieldId、
  // 无反向字段、link_row 链路未建）。需补建双向配对，否则后续关联数据无处挂载。
  const isLinkLike = existing.type === "links" || existing.type === "subtable";
  let pairBackfilled = false;
  if (
    isLinkLike &&
    !existing.linkFieldId &&
    !existing.isReverse &&
    patch.relatedTableId &&
    patch.relatedTableId !== existing.relatedTableId
  ) {
    const targetTableId = patch.relatedTableId;
    const rawKind = (patch.relationKind as RelationKind | null | undefined) ?? (existing.relationKind as RelationKind | null) ?? "mm";
    // 子表格固定一对多（多个子行归属一条主数据）
    const kind: RelationKind = existing.type === "subtable" ? "hm" : rawKind;
    const reverseKind = reverseRelation(kind);

    const maxReverse = await prisma.field.findFirst({
      where: { tableId: targetTableId, deletedAt: null },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    const reverseOrder = maxReverse ? maxReverse.order + 1 : 0;

    // 建反向字段（占位 → 回填互指）
    const reverseField = await prisma.field.create({
      data: {
        tableId: targetTableId,
        name: `${updated.name}（反向）`,
        type: existing.type,
        order: reverseOrder,
        relatedTableId: existing.tableId,
        relationKind: reverseKind,
        isReverse: true,
        linkDisplayFieldId: (patch.linkDisplayFieldId as string | null | undefined) ?? existing.linkDisplayFieldId ?? undefined,
      },
    });
    // 正向字段回填 linkFieldId / reverseFieldId
    await prisma.field.update({
      where: { id: fieldId },
      data: { linkFieldId: reverseField.id, reverseFieldId: reverseField.id, relatedTableId: targetTableId, relationKind: kind },
    });
    // 反向字段回填互指
    await prisma.field.update({
      where: { id: reverseField.id },
      data: { reverseFieldId: fieldId, linkFieldId: fieldId },
    });
    invalidateOrdinalCache(targetTableId);
    pairBackfilled = true;
  }

  // 补建配对后正向字段的 linkFieldId/reverseFieldId 已变，重新读取保证返回最新值
  const finalField = pairBackfilled
    ? await prisma.field.findUnique({ where: { id: fieldId } })
    : updated;
  // 关联字段改名 / 改关系类型 / 改显示字段 → 同步反向字段（v1 syncReverseLink）
  if (isLinkLike) {
    const selfLinkId = finalField?.linkFieldId ?? existing.linkFieldId;
    const partnerId = existing.isReverse ? (existing.reverseFieldId ?? existing.linkFieldId) : selfLinkId;
    if (partnerId) {
      const partnerPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) partnerPatch["name"] = `${patch.name}（反向）`;
      if (patch.relationKind !== undefined) {
        partnerPatch["relationKind"] = reverseRelation(patch.relationKind ?? "mm");
      }
      if (patch.linkDisplayFieldId !== undefined) {
        partnerPatch["linkDisplayFieldId"] = patch.linkDisplayFieldId;
      }
      if (Object.keys(partnerPatch).length > 0) {
        await prisma.field.update({ where: { id: partnerId }, data: partnerPatch });
      }
    }
  }

  invalidateOrdinalCache(existing.tableId);
  return toFieldMeta(finalField ?? updated);
}

/**
 * 软删字段。
 * - links 字段：对称软删配对反向字段
 * - 被 lookup/rollup/count 依赖的字段：级联软删依赖它的计算字段
 */
export async function deleteField(fieldId: string): Promise<{ deleted: string[] }> {
  const field = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!field || field.deletedAt) return { deleted: [] };

  const now = new Date();
  const deleted: string[] = [fieldId];

  await prisma.field.update({ where: { id: fieldId }, data: { deletedAt: now } });

  // 对称删除配对反向字段（v1 MetaRepository.deleteField 级联对称软删）
  // links 与 subtable 在存储层同构（同一张 link_row 表），删除处理一致
  if (field.type === "links" || field.type === "subtable") {
    const partnerId = field.isReverse ? field.reverseFieldId : field.linkFieldId;
    if (partnerId) {
      const partner = await prisma.field.findUnique({ where: { id: partnerId } });
      if (partner && !partner.deletedAt) {
        await prisma.field.update({ where: { id: partnerId }, data: { deletedAt: now } });
        deleted.push(partnerId);
      }
    }
    // 关联数据只打软删标记：字段进回收站后仍可恢复，恢复时关联一并回来（见 trash restore）
    await prisma.linkRow.updateMany({
      where: {
        linkFieldId: { in: [fieldId, ...(field.linkFieldId ? [field.linkFieldId] : [])] },
        deletedAt: null,
      },
      data: { deletedAt: now },
    });
  }

  // 级联：删除依赖该字段的 lookup/rollup/count
  const dependents = await prisma.field.findMany({
    where: {
      deletedAt: null,
      OR: [{ lookupFieldId: fieldId }, { linkFieldId: fieldId }],
    },
  });
  for (const d of dependents) {
    if (d.type === "lookup" || d.type === "rollup" || d.type === "count") {
      await prisma.field.update({ where: { id: d.id }, data: { deletedAt: now } });
      deleted.push(d.id);
    }
  }

  invalidateOrdinalCache(field.tableId);
  return { deleted };
}

export async function listFields(tableId: string): Promise<FieldMeta[]> {
  const rows = await prisma.field.findMany({
    where: { tableId, deletedAt: null },
    orderBy: { order: "asc" },
  });
  return rows.map(toFieldMeta);
}

/**
 * Lookup/Rollup 的取值字段候选：
 * 由「本表的 links 字段」→ 该 links 字段的 relatedTableId → 该表的字段
 * （v1 曾在这里错用 meta.relatedTableId，导致候选加载失败，是真 bug）
 */
export async function lookupTargetFields(linkFieldId: string): Promise<FieldMeta[]> {
  const linkField = await prisma.field.findUnique({ where: { id: linkFieldId } });
  if (!linkField || linkField.deletedAt) return [];
  const targetTableId = linkField.relatedTableId;
  if (!targetTableId) return [];
  const rows = await prisma.field.findMany({
    where: { tableId: targetTableId, deletedAt: null },
    orderBy: { order: "asc" },
  });
  // lookup 不能指向关联表里的 links/lookup/rollup/count（会引入递归），
  // 也不能指向 tabs（纯容器无值）/ subtable（子表格，非标量）
  return rows
    .map(toFieldMeta)
    .filter((f) => !["links", "lookup", "rollup", "count", "tabs", "subtable"].includes(f.type));
}
