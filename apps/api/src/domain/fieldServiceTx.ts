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
import { HttpError } from "../guards.js";
import { toFieldMeta } from "./prismaDeps.js";
import type { CreateFieldInput, UpdateFieldInput } from "./fieldService.js";
import { resolveFieldRestoreName } from "./restoreName.js";

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

/**
 * YN7 同步回放可选：保留离线端生成的字段 cuid（§8.4/§19.3）。在线路径恒不传 → Prisma 生成 id。
 */
export interface CreateFieldPreserveOpt {
  /** 普通字段/正向字段保留的主键。 */
  id?: string;
  /** links/subtable 成对创建时，反向字段保留的主键。 */
  reverseId?: string;
}

export async function createSimpleFieldTx(
  tx: DbTx,
  input: CreateFieldInput,
  preserve?: CreateFieldPreserveOpt,
): Promise<{ field: ReturnType<typeof toFieldMeta> }> {
  const maxOrder = await tx.field.findFirst({
    where: { tableId: input.tableId, deletedAt: null },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const order = maxOrder ? maxOrder.order + 1 : 0;

  // 重名校验在写事务内、用 tx 做（消除事务前查重的 TOCTOU）；名字已在 service 层 trim。
  const dup = await tx.field.findFirst({
    where: { tableId: input.tableId, name: input.name, deletedAt: null },
    select: { id: true },
  });
  if (dup) throw new HttpError(409, `字段名「${input.name}」已存在`);

  const created = await tx.field.create({
    data: {
      // YN7 回放带 preserve.id 时保留离线 cuid（§8.4）；在线路径不传 → Prisma 生成 id。
      ...(preserve?.id ? { id: preserve.id } : {}),
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
  preserve?: CreateFieldPreserveOpt,
): Promise<{ field: ReturnType<typeof toFieldMeta>; reverseField: ReturnType<typeof toFieldMeta> }> {
  const kind = input.relationKind!;
  const reverseKind = reverseRelation(kind);
  const relatedTableId = input.relatedTableId!;

  // 重名校验在写事务内、用 tx 做（links/subtable 建字段同样要守名字唯一）。
  const dup = await tx.field.findFirst({
    where: { tableId: input.tableId, name: input.name, deletedAt: null },
    select: { id: true },
  });
  if (dup) throw new HttpError(409, `字段名「${input.name}」已存在`);

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
      // YN7 回放：保留反向字段离线 cuid（§8.4/§19.1 成对原子）；在线不传 → 生成 id。
      ...(preserve?.reverseId ? { id: preserve.reverseId } : {}),
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
      // YN7 回放：保留正向字段离线 cuid（§8.4）；在线不传 → 生成 id。
      ...(preserve?.id ? { id: preserve.id } : {}),
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
  // 改名查重在写事务内、用 tx 做：同表、同名、未删、排除自己；只在本次带 name 时校验，
  // 只改其它字段不受影响。名字已在 service 层 trim。
  if (patch.name !== undefined) {
    const dup = await tx.field.findFirst({
      where: {
        tableId: existing.tableId,
        name: patch.name,
        deletedAt: null,
        id: { not: fieldId },
      },
      select: { id: true },
    });
    if (dup) throw new HttpError(409, `字段名「${patch.name}」已存在`);
  }

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

export interface RestoreFieldTxResult {
  tableId: string;
  /** 恢复后最终字段名（同名冲突时已自动改名去歧义）。 */
  name: string;
  /** 是否因同名冲突被自动改名。 */
  renamed: boolean;
  /** 受影响、需重算 mask 的表（正向表 + partner 字段所在表，去重）。 */
  maskTableIds: string[];
}

/**
 * 恢复软删字段（单事务）：字段复活（同名活字段冲突时自动改名）→ links/subtable 的 partner
 * 字段对称复活（同样去歧义改名）→ 关联 link_row 撤软删。
 *
 * 从 routes/records.ts 回收站恢复的 field 分支下沉（原为历史非事务多写），供【在线恢复】与
 * 【YN7 结构回放 restore_field 处理器】共用（§20.1 单一事实源）。mask 重算与 oplog 切面由编排/
 * 注册表层在同事务调用（与 deleteFieldTx 同分工）。字段已是活字段时按幂等成功处理（不改名）。
 * 铁律：只用传入 tx，回调内禁止再入写队列。
 */
export async function restoreFieldTx(
  tx: DbTx,
  fieldId: string,
): Promise<RestoreFieldTxResult> {
  const f = await tx.field.findUnique({
    where: { id: fieldId },
    select: {
      name: true, tableId: true, type: true, isReverse: true,
      reverseFieldId: true, linkFieldId: true, deletedAt: true,
    },
  });
  if (!f) throw new HttpError(404, "字段不存在");

  const tableIds = new Set<string>([f.tableId]);
  let finalName = f.name;

  if (f.deletedAt) {
    // 恢复前查重名：删除后重建同名字段、再恢复旧的，会落下两个同名活字段（公式/CSV 歧义）。
    finalName = await resolveFieldRestoreName(tx, fieldId, f.tableId, f.name);
    await tx.field.update({ where: { id: fieldId }, data: { deletedAt: null, name: finalName } });
  }

  // links/subtable 配对反向字段一并恢复（删除时对称软删，只恢复一个会成孤儿）。
  if (f.type === "links" || f.type === "subtable") {
    const partnerId = f.isReverse ? f.reverseFieldId : f.linkFieldId;
    if (partnerId) {
      const partner = await tx.field.findUnique({
        where: { id: partnerId },
        select: { name: true, tableId: true, deletedAt: true },
      });
      if (partner) tableIds.add(partner.tableId);
      // 配对字段同样查重名；若它已是活字段则什么都不做（保持只复活软删行的语义）。
      if (partner?.deletedAt) {
        const partnerName = await resolveFieldRestoreName(tx, partnerId, partner.tableId, partner.name);
        await tx.field.updateMany({
          where: { id: partnerId, deletedAt: { not: null } },
          data: { deletedAt: null, name: partnerName },
        });
      }
      // 删字段时 linkRow 只打了软删标记，恢复字段时一并恢复，否则关联数据静默丢失。
      await tx.linkRow.updateMany({
        where: { linkFieldId: { in: [fieldId, partnerId] }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
    }
  }

  return {
    tableId: f.tableId,
    name: finalName,
    renamed: f.deletedAt !== null && finalName !== f.name,
    maskTableIds: [...tableIds],
  };
}

/**
 * 字段整表重排（单事务）：payload 为该表【全部活字段】的有序 id 列表，校验与当前活字段集合
 * 严格一致（同集合、无重复、无遗漏、不含已删/它表字段）后，按列表下标重写 order。
 *
 * 从 routes/fields.ts 的 move 编排下沉为「整表规范顺序」事务体（§19.1 reorder_fields payload＝
 * 有序 fieldId 列表），供在线 move（换算成完整顺序后）与 YN7 结构回放共用。集合不一致即 400，
 * 绝不按部分列表静默重排（会吞掉离线期间他人新增的字段位置）。铁律：只用传入 tx。
 */
export async function reorderFieldsTx(
  tx: DbTx,
  tableId: string,
  orderedIds: string[],
): Promise<void> {
  const live = await tx.field.findMany({
    where: { tableId, deletedAt: null },
    orderBy: { order: "asc" },
    select: { id: true },
  });
  const liveIds = live.map((x) => x.id);
  const sameSet = liveIds.length === orderedIds.length
    && new Set(orderedIds).size === orderedIds.length
    && orderedIds.every((id) => liveIds.includes(id));
  if (!sameSet) {
    throw new HttpError(400, "字段排序列表与当前字段集合不一致（可能离线期间有字段增删），请刷新后重试", "SYNC_MALFORMED_PAYLOAD");
  }
  for (let i = 0; i < orderedIds.length; i += 1) {
    await tx.field.update({ where: { id: orderedIds[i] }, data: { order: i } });
  }
}
