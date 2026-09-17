// apps/api/src/domain/fieldServiceTx.ts
// 字段结构写的【交互事务体】（RC-10 写路径全事务化）。
//
// 本文件只含在单个 withWriteTx 回调内执行、且只用传入 tx 的多步写：
//   - createSimpleFieldTx   普通字段一写
//   - createLinkFieldPairTx links/subtable 双向对：反向占位 → 正向 → 回填互指（三写）
//   - updateFieldTx         主更新 + 首次补配双向对三写 + 尾部 partner 同步
//   - deleteFieldTx         本字段/partner 软删 + linkRow 打标 + lookup/rollup/count 级联
// 铁律：这些函数体内禁止再调 runWrite/withWriteTx/withWriteBatch（写队列并发度恒 1，
// 事务回调内再次入队会自死锁）。对外开事务、提交后失效缓存由 fieldService.ts 负责。

import type { DbTx } from "../db.js";
import { toFieldMeta } from "./prismaDeps.js";
import type { CreateFieldInput, UpdateFieldInput } from "./fieldService.js";

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

export type ExistingFieldRow = NonNullable<Awaited<ReturnType<DbTx["field"]["findUnique"]>>>;

export async function createSimpleFieldTx(
  tx: DbTx,
  input: CreateFieldInput,
): Promise<{ field: ReturnType<typeof toFieldMeta> }> {
  const maxOrder = await tx.field.findFirst({
    where: { tableId: input.tableId, deletedAt: null },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const order = maxOrder ? maxOrder.order + 1 : 0;

  const created = await tx.field.create({
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
  return { field: toFieldMeta(created) };
}

export async function createLinkFieldPairTx(
  tx: DbTx,
  input: CreateFieldInput,
): Promise<{ field: ReturnType<typeof toFieldMeta>; reverseField: ReturnType<typeof toFieldMeta> }> {
  const kind = input.relationKind!;
  const reverseKind = reverseRelation(kind);
  const relatedTableId = input.relatedTableId!;

  const maxOrder = await tx.field.findFirst({
    where: { tableId: input.tableId, deletedAt: null },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const order = maxOrder ? maxOrder.order + 1 : 0;

  const maxReverse = await tx.field.findFirst({
    where: { tableId: relatedTableId, deletedAt: null },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const reverseOrder = maxReverse ? maxReverse.order + 1 : 0;

  // 先建反向字段（占位，稍后回填 reverseFieldId）；与正向保持同一类型
  const reverseField = await tx.field.create({
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
  const forwardField = await tx.field.create({
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
  const updatedReverse = await tx.field.update({
    where: { id: reverseField.id },
    data: { reverseFieldId: forwardField.id, linkFieldId: forwardField.id },
  });

  return { field: toFieldMeta(forwardField), reverseField: toFieldMeta(updatedReverse) };
}

export async function updateFieldTx(
  tx: DbTx,
  fieldId: string,
  existing: ExistingFieldRow,
  patch: UpdateFieldInput,
  data: Record<string, unknown>,
  isLinkLike: boolean,
): Promise<ExistingFieldRow> {
  const updated = await tx.field.update({ where: { id: fieldId }, data });

  // links/subtable 首次从「无关联表」补配关联表：此时字段还是孤立占位（无 linkFieldId、
  // 无反向字段、link_row 链路未建）。需补建双向配对，否则后续关联数据无处挂载。
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

    const maxReverse = await tx.field.findFirst({
      where: { tableId: targetTableId, deletedAt: null },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    const reverseOrder = maxReverse ? maxReverse.order + 1 : 0;

    // 建反向字段（占位 → 回填互指）
    const reverseField = await tx.field.create({
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
    await tx.field.update({
      where: { id: fieldId },
      data: { linkFieldId: reverseField.id, reverseFieldId: reverseField.id, relatedTableId: targetTableId, relationKind: kind },
    });
    // 反向字段回填互指
    await tx.field.update({
      where: { id: reverseField.id },
      data: { reverseFieldId: fieldId, linkFieldId: fieldId },
    });
    pairBackfilled = true;
  }

  // 补建配对后正向字段的 linkFieldId/reverseFieldId 已变，重新读取保证返回最新值
  const finalField = pairBackfilled
    ? await tx.field.findUnique({ where: { id: fieldId } })
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
        await tx.field.update({ where: { id: partnerId }, data: partnerPatch });
      }
    }
  }

  return finalField ?? updated;
}

export async function deleteFieldTx(tx: DbTx, field: ExistingFieldRow): Promise<string[]> {
  const now = new Date();
  const fieldId = field.id;
  const deleted: string[] = [fieldId];

  await tx.field.update({ where: { id: fieldId }, data: { deletedAt: now } });

  // 对称删除配对反向字段（v1 MetaRepository.deleteField 级联对称软删）
  // links 与 subtable 在存储层同构（同一张 link_row 表），删除处理一致
  if (field.type === "links" || field.type === "subtable") {
    const partnerId = field.isReverse ? field.reverseFieldId : field.linkFieldId;
    if (partnerId) {
      const partner = await tx.field.findUnique({ where: { id: partnerId } });
      if (partner && !partner.deletedAt) {
        await tx.field.update({ where: { id: partnerId }, data: { deletedAt: now } });
        deleted.push(partnerId);
      }
    }
    // 关联数据只打软删标记：字段进回收站后仍可恢复，恢复时关联一并回来（见 trash restore）
    await tx.linkRow.updateMany({
      where: {
        linkFieldId: { in: [fieldId, ...(field.linkFieldId ? [field.linkFieldId] : [])] },
        deletedAt: null,
      },
      data: { deletedAt: now },
    });
  }

  // 级联：删除依赖该字段的 lookup/rollup/count
  const dependents = await tx.field.findMany({
    where: {
      deletedAt: null,
      OR: [{ lookupFieldId: fieldId }, { linkFieldId: fieldId }],
    },
  });
  for (const d of dependents) {
    if (d.type === "lookup" || d.type === "rollup" || d.type === "count") {
      await tx.field.update({ where: { id: d.id }, data: { deletedAt: now } });
      deleted.push(d.id);
    }
  }

  return deleted;
}
