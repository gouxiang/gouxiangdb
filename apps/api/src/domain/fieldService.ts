// apps/api/src/domain/fieldService.ts
// 字段元数据服务：创建 / 更新 / 删除（对外编排层）。
//
// 三个必须保真的 v1 行为：
//   1. 创建 links 字段时自动在关联表创建「反向字段」，两者 reverseFieldId 互指
//   2. relationKind 反向映射：mm↔mm、hm↔bt、bt↔hm（bt→bt 是 v1 修掉的真 bug）
//   3. 删除 links 字段时对称软删配对反向字段；删除被依赖字段时级联处理 lookup/rollup/count
//
// 本文件只负责：入参规整、开交互事务（withWriteTx）、提交成功后失效序号缓存。
// 事务体内的多步结构写全部在 fieldServiceTx.ts，且回调内只用传入的 tx（RC-10 写路径全事务化）。

import { prisma, withWriteTx } from "../db.js";
import { HttpError } from "../guards.js";
import type { FieldMeta, SelectOption, TabConfig } from "./types.js";
import { toFieldMeta, invalidateOrdinalCache } from "./prismaDeps.js";
import {
  createSimpleFieldTx,
  createLinkFieldPairTx,
  updateFieldTx,
  deleteFieldTx,
  restoreFieldTx,
  reorderFieldsTx,
} from "./fieldServiceTx.js";
import { resyncTableMaskTx } from "./authz/scopeProjectionTx.js";
import { recordStructureOpTx } from "./sync/structureOplog.js";

/** 事务内取表所属 base（结构 oplog 的订阅分片键）；取不到返回 null。 */
async function baseIdOfTableTx(tx: Parameters<typeof resyncTableMaskTx>[0], tableId: string): Promise<string | null> {
  const t = await tx.table.findUnique({ where: { id: tableId }, select: { baseId: true } });
  return t?.baseId ?? null;
}

export type { RelationKind } from "./fieldServiceTx.js";
export { reverseRelation } from "./fieldServiceTx.js";

/** 关系类型显示名（v1 GXRelationType.displayName） */
export function relationDisplayName(kind: "mm" | "hm" | "bt" | null): string {
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
export function relationIsMultiple(kind: "mm" | "hm" | "bt" | null): boolean {
  return kind === "mm" || kind === "hm";
}

const SELECT_PALETTE = [
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
  relationKind?: "mm" | "hm" | "bt" | null;
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

interface CreateFieldResult {
  field: FieldMeta;
  reverseField?: FieldMeta;
}

export async function createField(
  input: CreateFieldInput,
  operatorUserId: string,
): Promise<CreateFieldResult> {
  // 子表格内部固定为「一对多（hm）」：一条主数据拥有多条子行（反向自动为多对一 bt）。
  // UI 隐藏关系类型选择；服务端强制，避免数据交叉混乱。
  if (input.type === "subtable" && input.relationKind) {
    input.relationKind = "hm";
  }

  // 名字写库前 trim：纯空格名不允许（zod min(1) 拦不住 "   "）。
  const trimmedName = input.name.trim();
  if (trimmedName === "") throw new HttpError(400, "字段名不能为空");
  input.name = trimmedName;

  const isLinkPair =
    (input.type === "links" || input.type === "subtable") &&
    !!input.relatedTableId &&
    !!input.relationKind;

  // 全部结构写（普通字段一写；links/subtable 的反向占位→正向→回填互指三写）收进单个
  // 交互事务：任一步失败整体回滚，绝不留孤立反向占位字段或单向链。RC-10 写路径全事务化。
  // P1/S7 #7/#8：结构写后重算受影响表 scope:role mask（反向字段建在 relatedTableId）。
  const result = await withWriteTx("field.create", async (tx): Promise<CreateFieldResult> => {
    // 普通字段一写 / links-subtable 成对三写；先拿到正向字段（与可选反向字段）。
    let forwardMeta: FieldMeta;
    let reverseMeta: FieldMeta | undefined;
    if (isLinkPair) {
      const pair = await createLinkFieldPairTx(tx, input);
      forwardMeta = pair.field;
      reverseMeta = pair.reverseField;
    } else {
      forwardMeta = (await createSimpleFieldTx(tx, input)).field;
    }
    await resyncTableMaskTx(tx, input.tableId, operatorUserId);
    if (isLinkPair) await resyncTableMaskTx(tx, input.relatedTableId!, operatorUserId);
    // YN7 §8.6：结构 oplog + table_schema 钟（off 时零 IO）。普通/成对都以正向字段为实体，
    // 成对用 create_link_field 一个 op 表达（含 reverseFieldId），保持正/反两字段原子（§19.1）。
    const baseId = await baseIdOfTableTx(tx, input.tableId);
    if (baseId) {
      await recordStructureOpTx(tx, {
        entityType: "field", entityId: forwardMeta.id, tableId: input.tableId, baseId,
        op: isLinkPair ? "create_link_field" : "add_field", actorId: operatorUserId,
        payload: {
          tableId: input.tableId, name: input.name, type: input.type,
          ...(reverseMeta ? { reverseFieldId: reverseMeta.id } : {}),
        },
      });
    }
    return reverseMeta ? { field: forwardMeta, reverseField: reverseMeta } : { field: forwardMeta };
  });

  // 缓存失效只能在事务提交成功后做（纯同步内存操作，不经写队列）。
  invalidateOrdinalCache(input.tableId);
  if (isLinkPair) invalidateOrdinalCache(input.relatedTableId!);
  return result;
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
  relationKind?: "mm" | "hm" | "bt" | null;
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

/**
 * 由「现有字段行 + 字段子集 patch」组装 Prisma field.update 的 data 对象（§20.6 单一事实来源）。
 * 在线 updateField 编排与 YN7 同步回放（structureRegistry 的 alter_field）共用同一套
 * 「!== undefined 才入列、JSON 列自行 stringify、null 表清空、关联表仅未配对时可写」规则，
 * 杜绝两条写路径对字段子集的解释漂移。纯函数，不读不写库。
 */
export function buildFieldUpdateData(
  existing: { type: string; linkFieldId: string | null },
  patch: UpdateFieldInput,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data["name"] = patch.name;
  if (patch.description !== undefined) data["description"] = patch.description ?? "";
  if (patch.required !== undefined) data["required"] = patch.required;
  if (patch.unique !== undefined) data["unique"] = patch.unique;
  if (patch.order !== undefined) data["order"] = patch.order;
  if (patch.options !== undefined) data["options"] = patch.options ? JSON.stringify(patch.options) : null;
  if (patch.precision !== undefined) data["precision"] = patch.precision;
  if (patch.maxLength !== undefined) data["maxLength"] = patch.maxLength;
  if (patch.defaultNow !== undefined) data["defaultNow"] = patch.defaultNow;
  if (patch.recordFilter !== undefined) data["recordFilter"] = patch.recordFilter ? JSON.stringify(patch.recordFilter) : null;
  // 关联表只在「尚未建立双向配对」时允许设置（首次补配）；已配对后改表会断链，忽略。
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
  return data;
}

export async function updateField(
  fieldId: string,
  patch: UpdateFieldInput,
  operatorUserId: string,
): Promise<FieldMeta | null> {
  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing || existing.deletedAt) return null;

  // 子表格关系固定 hm：忽略任何其它关系类型（UI 已隐藏选择，服务端兜底）
  if (existing.type === "subtable" && patch.relationKind !== undefined) {
    patch = { ...patch, relationKind: "hm" };
  }

  // 改名：trim 后写库；纯空格 400。提前到构造 data 之前，使 data、事务内查重、
  // partner 反向字段同步（fieldServiceTx.ts）统一拿到 trim 后的值。
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (trimmed === "") throw new HttpError(400, "字段名不能为空");
    patch = { ...patch, name: trimmed };
  }

  // 字段子集 → Prisma data 的组装与 YN7 结构回放共用 buildFieldUpdateData（单一事实来源）。
  const data = buildFieldUpdateData(existing, patch);

  const isLinkLike = existing.type === "links" || existing.type === "subtable";
  const backfilled =
    isLinkLike &&
    !existing.linkFieldId &&
    !existing.isReverse &&
    !!patch.relatedTableId &&
    patch.relatedTableId !== existing.relatedTableId;

  // 主 update + links/subtable 首次补配三写 + 尾部 partner 同步全部收进同一个交互事务：
  // 中途失败整体回滚，不留孤立反向字段/单向链。RC-10 写路径全事务化。
  // P1/S7 #9：结构写后重算本表 mask；首次 backfill 补配了对表新字段，对表也重算。
  const finalRow = await withWriteTx("field.update", async (tx) => {
    const r = await updateFieldTx(tx, fieldId, existing, patch, data, isLinkLike);
    await resyncTableMaskTx(tx, existing.tableId, operatorUserId);
    if (backfilled) await resyncTableMaskTx(tx, patch.relatedTableId!, operatorUserId);
    // YN7 §8.6：alter_field 结构 oplog（只记被改子集 changed；off 时零 IO）。
    const baseId = await baseIdOfTableTx(tx, existing.tableId);
    if (baseId) {
      await recordStructureOpTx(tx, {
        entityType: "field", entityId: fieldId, tableId: existing.tableId, baseId,
        op: "alter_field", actorId: operatorUserId,
        payload: { tableId: existing.tableId, changed: patch },
      });
    }
    return r;
  });

  // 缓存失效在提交成功后（纯同步内存操作）。
  invalidateOrdinalCache(existing.tableId);
  if (backfilled) invalidateOrdinalCache(patch.relatedTableId!);
  return toFieldMeta(finalRow);
}

/**
 * 软删字段。
 * - links 字段：对称软删配对反向字段
 * - 被 lookup/rollup/count 依赖的字段：级联软删依赖它的计算字段
 */
export async function deleteField(
  fieldId: string,
  operatorUserId: string,
): Promise<{ deleted: string[] }> {
  const field = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!field || field.deletedAt) return { deleted: [] };

  // 本字段软删 + partner 对称软删 + linkRow 打标 + lookup/rollup/count 级联软删全部收进
  // 单个交互事务：中途失败整体回滚，不出现「本字段已删、partner/关联未删」的半删态。
  // P1/S7 #10：deleteFieldTx 返回被删字段 id（含 partner/级联、可能跨表），
  // 收集去重受影响表逐个重算 scope:role mask。
  const deleted = await withWriteTx("field.delete", async (tx) => {
    const deletedIds = await deleteFieldTx(tx, field);
    const tableIds = new Set<string>([field.tableId]);
    for (const did of deletedIds) {
      const f = await tx.field.findUnique({ where: { id: did }, select: { tableId: true } });
      if (f) tableIds.add(f.tableId);
    }
    for (const tid of tableIds) await resyncTableMaskTx(tx, tid, operatorUserId);
    // YN7 §8.6：delete_field 结构 oplog（含级联删除 id；off 时零 IO）。
    const baseId = await baseIdOfTableTx(tx, field.tableId);
    if (baseId) {
      await recordStructureOpTx(tx, {
        entityType: "field", entityId: fieldId, tableId: field.tableId, baseId,
        op: "delete_field", actorId: operatorUserId,
        payload: { tableId: field.tableId, deleted: deletedIds },
      });
    }
    return deletedIds;
  });

  // 缓存失效在提交成功后（纯同步内存操作）。
  invalidateOrdinalCache(field.tableId);
  return { deleted };
}

/**
 * 恢复软删字段（回收站/YN7 restore_field 共用编排）：单事务跑 restoreFieldTx（含 partner 对称
 * 复活、linkRow 回填），重算受影响表 mask，并登记 restore_field 结构 oplog（§19.1/§8.6；off 零 IO）。
 */
export async function restoreField(
  fieldId: string,
  operatorUserId: string,
): Promise<{ name: string; renamed: boolean }> {
  const r = await withWriteTx("field.restore", async (tx) => {
    const result = await restoreFieldTx(tx, fieldId);
    for (const tid of result.maskTableIds) await resyncTableMaskTx(tx, tid, operatorUserId);
    const baseId = await baseIdOfTableTx(tx, result.tableId);
    if (baseId) {
      await recordStructureOpTx(tx, {
        entityType: "field", entityId: fieldId, tableId: result.tableId, baseId,
        op: "restore_field", actorId: operatorUserId,
        payload: { tableId: result.tableId, name: result.name, renamed: result.renamed },
      });
    }
    return result;
  });
  invalidateOrdinalCache(r.tableId);
  return { name: r.name, renamed: r.renamed };
}

/**
 * 字段整表重排（在线 move / YN7 reorder_fields 共用编排）：单事务把 orderedIds 落为该表活字段
 * 的规范顺序，并登记 reorder_fields 结构 oplog（§19.1 payload＝有序 fieldId 列表；off 零 IO）。
 * 集合一致性校验在 reorderFieldsTx 内（不一致 400，绝不静默吞字段位置）。
 */
export async function reorderFields(
  tableId: string,
  orderedIds: string[],
  operatorUserId: string,
): Promise<void> {
  await withWriteTx("field.reorder", async (tx) => {
    await reorderFieldsTx(tx, tableId, orderedIds);
    const baseId = await baseIdOfTableTx(tx, tableId);
    if (baseId) {
      await recordStructureOpTx(tx, {
        entityType: "field", entityId: tableId, tableId, baseId,
        op: "reorder_fields", actorId: operatorUserId,
        payload: { fieldIds: orderedIds },
      });
    }
  });
  invalidateOrdinalCache(tableId);
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
