// YN7 离线同步：结构轨（table / field / view）op 注册表 —— §20.1 的落地件。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §19.1（元数据 op 词表/字段级 payload）、§19.3（回放只走现有领域写原语、跑现有校验）、
//   §19.4（结构 op 对 base/table 节点按【当前】角色判 manage_schema；分享 manage_share、
//   表杂项 manage_table；视图共享层 manage_schema）、§20.1（扩展走注册表，引擎只认识注册表、
//   不堆模块特判 if）、§20.4（同串行队列/同事务登记/同一权限裁决）、§8.4（默认保留离线 cuid）。
//
// 引擎纪律：push 回放引擎对结构 op 的全部了解就是「用 entityType:op 查本表 → 调处理器」。
//   table/field/view 的差异一律表达为注册表条目（处理器内复用现有 *Tx 原语），引擎里不允许出现
//   `if (entityType === "field") ...` 这类模块分支。新增 nav/menu（YN8）只是再登记条目。
//
// 本文件只做【结构写应用 + oplog 元数据准备】；版本钟推进/乐观锁/终态落库由 push.ts 的
// replayStructureTx 统一经 structureOplog.writeStructureOpTx 完成（与 record 轨同一套状态机）。
//
// 分期诚实边界（YN7＝#787 首段 + #788 续段）：
//   - 已登记：create_table / rename_table / update_table_settings / delete_table / restore_table、
//     add_field / alter_field / delete_field / restore_field / reorder_fields / create_link_field、
//     create_view / alter_view / delete_view。
//   - 结构分叉的人工 resolve、字段类型变更对存量数据的可转换校验（§19.3 场景 2/3/5/6）在 #788-C/D
//     落地；未登记 op 由引擎回 SYNC_OP_UNSUPPORTED（明确拒绝、不静默、不假装支持）。

import type { ResourceAction } from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { createTableTx, updateTableTx, softDeleteTableTx, restoreTableTx } from "../tableServiceTx.js";
import {
  createSimpleFieldTx,
  createLinkFieldPairTx,
  updateFieldTx,
  deleteFieldTx,
  restoreFieldTx,
  reorderFieldsTx,
} from "../fieldServiceTx.js";
import { createViewTx, updateViewTx, assertAndPurgeViewTx } from "../viewServiceTx.js";
import { buildFieldUpdateData, type CreateFieldInput, type UpdateFieldInput } from "../fieldService.js";
import type { SelectOption } from "../types.js";
import {
  isConvertibleSourceType,
  isConvertibleTargetType,
  parseSelectOptions,
  scanTypeConversionBlockersTx,
  throwIfBlocked,
  assertPrimaryFieldPopulatedTx,
  RC_TYPE_CHANGE_UNSUPPORTED,
  RC_STRUCTURE_ENTITY_DELETED,
} from "./structureValidation.js";
import { resyncTableMaskTx } from "../authz/scopeProjectionTx.js";
import { parseViewConfig } from "../recordService.js";
import type { StructureEntityType } from "./structureOplog.js";
// 仅类型引用（编译期擦除）：注册表与 push 引擎互相 import 不产生运行时循环。
import type { IncomingOp } from "./push.js";

// ───────────────────────── 小工具（与 push.ts 同口径，本地副本避免循环导出） ─────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function bool(v: unknown, dft = false): boolean {
  return typeof v === "boolean" ? v : dft;
}
function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

// ───────────────────────── 注册表类型 ─────────────────────────

export interface StructureAuthzRef {
  resourceType: "base" | "table";
  resourceId: string;
}

export interface StructureResolution {
  /** 结构版本钟所属表（sync_entity_versions: table_schema:<tableId>）。 */
  tableId: string;
  /** 当前权限裁决挂载点与动作（§19.4）。 */
  ref: StructureAuthzRef;
  action: ResourceAction;
}

export interface StructureApplyOutcome {
  entityType: StructureEntityType;
  /** oplog 实体 id（默认＝o.entityId；成对关联字段＝正向字段 id）。 */
  entityId: string;
  tableId: string;
  /** 写入 oplog 的规范化 op 名（create_link_field 等与入站一致）。 */
  op: string;
  /** 结构化 payload（随 oplog 下发，供其它端 pull 重放；只含结构元数据，无记录行明文）。 */
  payload: Record<string, unknown>;
  /** 应用后需在同事务重算 mask 的表（字段增删改影响字段掩码；表/视图 ops 留空）。 */
  resyncMaskTables: string[];
}

export interface StructureOpHandler {
  entityType: StructureEntityType;
  /** 解析目标表 + 权限挂载点（事务内调用，可读库；payload 非法应抛 HttpError 400 MALFORMED）。 */
  resolve: (tx: DbTx, baseId: string, o: IncomingOp) => Promise<StructureResolution>;
  /** 在回放事务内应用结构主写（复用现有 *Tx 原语）；不得自行开事务/入写队列。 */
  apply: (tx: DbTx, userId: string, baseId: string, o: IncomingOp) => Promise<StructureApplyOutcome>;
}

// ───────────────────────── 共用校验 ─────────────────────────

async function assertTableInBase(tx: DbTx, tableId: string, baseId: string): Promise<void> {
  const t = await tx.table.findUnique({
    where: { id: tableId },
    select: { baseId: true, deletedAt: true },
  });
  if (!t || t.baseId !== baseId) {
    throw new HttpError(400, "目标数据表不存在或不属于该 Base", "SYNC_BAD_TABLE");
  }
}

// ───────────────────────── table 族 ─────────────────────────

const createTableHandler: StructureOpHandler = {
  entityType: "table",
  async resolve(_tx, baseId, _o) {
    // 建表时表节点尚不存在 → 权限挂 base（与在线 requireCreateTable 同款，§19.4）。
    return { tableId: _o.entityId, ref: { resourceType: "base", resourceId: baseId }, action: "manage_schema" };
  },
  async apply(tx, userId, baseId, o) {
    const name = str(o.payload.name);
    if (!name) throw new HttpError(400, "create_table 缺少 name", "SYNC_MALFORMED_PAYLOAD");
    const withDefaults = bool(o.payload.withDefaults, false);
    // S3b-3a：从 payload 读服务端权威子实体 id 组 preset（§8.4 下行保 id）。老 op 缺键 / 键畸形
    // 一律回退 Prisma 随机生成（与升级前回放逐字节一致）；defaultFieldIds 按 [数量,状态,日期,备注]
    // 对位，数组非法（非数组/含空串）整体视为缺键，内部缺位也逐位回退随机。
    const pfId = str(o.payload.primaryFieldId);
    const dvId = str(o.payload.defaultViewId);
    const rawDefaultFieldIds = o.payload.defaultFieldIds;
    const defaultFieldIds = Array.isArray(rawDefaultFieldIds)
      && rawDefaultFieldIds.every((x) => typeof x === "string" && x.trim() !== "")
      ? (rawDefaultFieldIds as string[])
      : undefined;
    const r = await createTableTx(tx, {
      baseId, name, withDefaults, userId,
      // 保留离线表 cuid（§8.4）；撞 id 由 P2002 冒到回放层归一冲突。
      tableId: o.entityId,
      presetChildIds: {
        ...(pfId ? { primaryFieldId: pfId } : {}),
        ...(defaultFieldIds ? { defaultFieldIds } : {}),
        ...(dvId ? { defaultViewId: dvId } : {}),
      },
    });
    return {
      entityType: "table", entityId: o.entityId, tableId: o.entityId, op: o.op,
      payload: {
        name, withDefaults, primaryFieldId: r.primaryFieldId,
        defaultFieldIds: r.defaultFieldIds, defaultViewId: r.defaultViewId,
      },
      resyncMaskTables: [],
    };
  },
};

const renameTableHandler: StructureOpHandler = {
  entityType: "table",
  async resolve(tx, baseId, o) {
    await assertTableInBase(tx, o.entityId, baseId);
    return { tableId: o.entityId, ref: { resourceType: "table", resourceId: o.entityId }, action: "manage_schema" };
  },
  async apply(tx, _userId, baseId, o) {
    const name = str(o.payload.name);
    if (!name) throw new HttpError(400, "rename_table 缺少 name", "SYNC_MALFORMED_PAYLOAD");
    await updateTableTx(tx, { tableId: o.entityId, baseId, name, renaming: true });
    return {
      entityType: "table", entityId: o.entityId, tableId: o.entityId, op: o.op,
      payload: { name }, resyncMaskTables: [],
    };
  },
};

const updateTableSettingsHandler: StructureOpHandler = {
  entityType: "table",
  async resolve(tx, baseId, o) {
    await assertTableInBase(tx, o.entityId, baseId);
    // 表设置杂项（图标/主字段）归 manage_table；若 payload 仅含分享开关则应走 manage_share——
    // 本期结构回放只接图标/主字段（分享链接同步不在结构词表内）。
    return { tableId: o.entityId, ref: { resourceType: "table", resourceId: o.entityId }, action: "manage_table" };
  },
  async apply(tx, _userId, baseId, o) {
    const data: { primaryFieldId?: string; icon?: string | null; iconColor?: string | null } = {};
    if (o.payload.primaryFieldId !== undefined) {
      const pf = str(o.payload.primaryFieldId);
      if (!pf) throw new HttpError(400, "update_table_settings.primaryFieldId 非法", "SYNC_MALFORMED_PAYLOAD");
      // §19.3 场景 5：改主字段与在线同规则——目标字段须是本表活字段，且全表每条记录该字段非空。
      const pfRow = await tx.field.findFirst({
        where: { id: pf, tableId: o.entityId, deletedAt: null },
        select: { id: true },
      });
      if (!pfRow) throw new HttpError(400, "主字段必须是该数据表内未删除的字段", "SYNC_MALFORMED_PAYLOAD");
      await assertPrimaryFieldPopulatedTx(tx, o.entityId, pf);
      data.primaryFieldId = pf;
    }
    if (Object.keys(o.payload).includes("icon")) {
      const icon = o.payload.icon;
      data.icon = icon === null ? null : str(icon);
    }
    if (Object.keys(o.payload).includes("iconColor")) {
      const iconColor = o.payload.iconColor;
      data.iconColor = iconColor === null ? null : str(iconColor);
    }
    if (Object.keys(data).length === 0) {
      throw new HttpError(400, "update_table_settings 无可应用设置", "SYNC_MALFORMED_PAYLOAD");
    }
    await updateTableTx(tx, { tableId: o.entityId, baseId, renaming: false, ...data });
    return {
      entityType: "table", entityId: o.entityId, tableId: o.entityId, op: o.op,
      payload: o.payload, resyncMaskTables: [],
    };
  },
};

const deleteTableHandler: StructureOpHandler = {
  entityType: "table",
  async resolve(tx, baseId, o) {
    await assertTableInBase(tx, o.entityId, baseId);
    return { tableId: o.entityId, ref: { resourceType: "table", resourceId: o.entityId }, action: "manage_schema" };
  },
  async apply(tx, userId, _baseId, o) {
    await softDeleteTableTx(tx, o.entityId, userId);
    return {
      entityType: "table", entityId: o.entityId, tableId: o.entityId, op: o.op,
      payload: {}, resyncMaskTables: [],
    };
  },
};

// 恢复软删表：表节点处于软删态、无法在 table 节点解析权限，故与在线 requireRestoreTable 同款，
// 权限挂【base 节点】判 manage_schema（§19.4）；assertTableInBase 只校验归属、不因 deletedAt 拒绝。
const restoreTableHandler: StructureOpHandler = {
  entityType: "table",
  async resolve(tx, baseId, o) {
    await assertTableInBase(tx, o.entityId, baseId);
    return { tableId: o.entityId, ref: { resourceType: "base", resourceId: baseId }, action: "manage_schema" };
  },
  async apply(tx, userId, _baseId, o) {
    const r = await restoreTableTx(tx, o.entityId, userId);
    return {
      entityType: "table", entityId: o.entityId, tableId: o.entityId, op: o.op,
      // 只落结构元数据 + 恢复记录条数（无记录行明文，§19.1 oplog payload 纪律）。
      payload: { name: r.name, renamed: r.renamed, restoredRecords: r.restoredRecordIds.length },
      resyncMaskTables: [],
    };
  },
};

// ───────────────────────── field 族 ─────────────────────────

/** 从 add_field payload 解析目标表（字段尚未创建，不能由 fieldId 反查）。 */
async function resolveFieldPayloadTable(tx: DbTx, baseId: string, o: IncomingOp): Promise<string> {
  const tableId = str(o.payload.tableId);
  if (!tableId) throw new HttpError(400, `${o.op} 缺少 tableId`, "SYNC_MALFORMED_PAYLOAD");
  await assertTableInBase(tx, tableId, baseId);
  return tableId;
}

/** 把 add_field payload 收敛成 CreateFieldInput（只挑白名单键，拒绝整对象透传）。 */
function parseCreateFieldInput(o: IncomingOp, tableId: string): Record<string, unknown> {
  const p = o.payload;
  const name = str(p.name);
  const type = str(p.type);
  if (!name || !type) throw new HttpError(400, `${o.op} 缺少 name/type`, "SYNC_MALFORMED_PAYLOAD");
  const out: Record<string, unknown> = { tableId, name, type };
  const passthrough = [
    "description", "required", "unique", "options", "precision", "maxLength", "defaultNow",
    "relatedTableId", "relationKind", "linkDisplayFieldId", "lookupFieldId", "linkFieldId",
    "rollupFunction", "formula", "recordFilter", "tabsConfig", "displayedFieldIds",
    "visibleFieldIds", "defaultConfig", "numberRule",
  ];
  for (const k of passthrough) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

function isLinkPairInput(p: Record<string, unknown>): boolean {
  const type = str(p.type);
  return (type === "links" || type === "subtable") && !!str(p.relatedTableId) && !!str(p.relationKind);
}

const addFieldHandler: StructureOpHandler = {
  entityType: "field",
  async resolve(tx, baseId, o) {
    const tableId = await resolveFieldPayloadTable(tx, baseId, o);
    return { tableId, ref: { resourceType: "table", resourceId: tableId }, action: "manage_schema" };
  },
  async apply(tx, _userId, baseId, o) {
    const tableId = await resolveFieldPayloadTable(tx, baseId, o);
    // 白名单键已逐个从 payload 挑出（非整对象透传），name/type 已校验；经 unknown 收敛为领域入参。
    const input = parseCreateFieldInput(o, tableId) as unknown as CreateFieldInput;
    const resync = new Set<string>([tableId]);
    let forwardId = o.entityId;
    let reverseId: string | null = null;
    if (isLinkPairInput(o.payload)) {
      // 与在线 createField 同口径：子表格关系固定 hm（UI 隐藏、服务端兜底）。
      if (input.type === "subtable" && input.relationKind) input.relationKind = "hm";
      reverseId = str(o.payload.reverseFieldId);
      const r = await createLinkFieldPairTx(
        tx, input,
        { id: o.entityId, ...(reverseId ? { reverseId } : {}) },
      );
      forwardId = r.field.id;
      reverseId = r.reverseField.id;
      if (input.relatedTableId) resync.add(String(input.relatedTableId));
    } else {
      const r = await createSimpleFieldTx(tx, input, { id: o.entityId });
      forwardId = r.field.id;
    }
    for (const tid of resync) await resyncTableMaskTx(tx, tid, _userId);
    return {
      entityType: "field", entityId: forwardId, tableId, op: isLinkPairInput(o.payload) ? "create_link_field" : o.op,
      payload: { ...input, ...(reverseId ? { reverseFieldId: reverseId } : {}) },
      resyncMaskTables: [...resync],
    };
  },
};

const alterFieldHandler: StructureOpHandler = {
  entityType: "field",
  async resolve(tx, baseId, o) {
    const existing = await tx.field.findUnique({
      where: { id: o.entityId },
      select: { tableId: true, deletedAt: true, table: { select: { baseId: true } } },
    });
    if (!existing || existing.table.baseId !== baseId) {
      throw new HttpError(400, "字段不存在或不属于该 Base", "SYNC_ENTITY_NOT_FOUND");
    }
    // §19.3-2：我离线改的字段在服务端已被对方软删 → 结构冲突（可复合 restore_field+alter_field），
    // 而非永久 rejected。用 409 + 专用码，replayStructureTx preflight 据此落 conflict（带结构快照）。
    if (existing.deletedAt) {
      throw new HttpError(409, "该字段已被删除（可能由他人在你离线期间操作）；可选择恢复并应用你的修改，或采用服务端", RC_STRUCTURE_ENTITY_DELETED);
    }
    return { tableId: existing.tableId, ref: { resourceType: "table", resourceId: existing.tableId }, action: "manage_schema" };
  },
  async apply(tx, userId, baseId, o) {
    const existing = await tx.field.findUnique({ where: { id: o.entityId } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(400, "字段不存在或已删除", "SYNC_ENTITY_NOT_FOUND");
    }
    await assertTableInBase(tx, existing.tableId, baseId);
    const changed = asRecord(o.payload.changed);
    if (!changed || Object.keys(changed).length === 0) {
      throw new HttpError(400, "alter_field 需要非空 changed 子集", "SYNC_MALFORMED_PAYLOAD");
    }
    if (existing.type === "subtable" && changed.relationKind !== undefined) changed.relationKind = "hm";
    if (changed.name !== undefined) {
      const trimmed = String(changed.name).trim();
      if (trimmed === "") throw new HttpError(400, "字段名不能为空", "SYNC_MALFORMED_PAYLOAD");
      changed.name = trimmed;
    }

    // §19.3 场景 3：alter_field 改类型——YN7 结构回放是第一条真正改 type 的路径（在线 PATCH 刻意
    // 不支持）。接受前先做两道安全门：① 仅物理标量字段间可转（关联/计算/容器/附件/人员/自动编号/
    // 系统字段明确拒绝，走新建字段）；② 扫描全表活记录存量值，任一非空值无法安全转换即 rejected
    // （带阻碍数/示例），field 行不动、版本不推进。通过后只改 type 元数据、不重写存量 cells（值存
    // records.fields JSON、非物理列，零破坏可回退）。
    if (changed.type !== undefined && changed.type !== existing.type) {
      const newType = str(changed.type);
      if (!newType) throw new HttpError(400, "字段类型非法", "SYNC_MALFORMED_PAYLOAD");
      if (!isConvertibleSourceType(existing.type) || !isConvertibleTargetType(newType)) {
        throw new HttpError(
          422,
          `暂不支持把「${existing.type}」字段改为「${newType}」类型（关联/公式/查找引用/附件/人员/自动编号等请新建字段）`,
          RC_TYPE_CHANGE_UNSUPPORTED,
        );
      }
      // 目标为单选/多选时，存量值必须命中新选项集合；优先取本次 changed.options，否则沿用现有选项。
      let targetOptions: SelectOption[] | null = null;
      if (newType === "singleSelect" || newType === "multiSelect") {
        if (changed.options !== undefined) {
          const parsed = parseSelectOptions(changed.options);
          if (!parsed) throw new HttpError(400, "选项 options 必须是 {id,name,color} 数组", "SYNC_MALFORMED_PAYLOAD");
          targetOptions = parsed;
        } else if (existing.options) {
          targetOptions = parseSelectOptions(safeJsonParse(existing.options)) ?? [];
        } else {
          targetOptions = [];
        }
      }
      const blockers = await scanTypeConversionBlockersTx(tx, existing.tableId, o.entityId, newType, targetOptions);
      throwIfBlocked(blockers, newType);
      // buildFieldUpdateData 不含 type（在线不支持改类型），此处作为 YN7 专属旁路显式落库。
      (changed as Record<string, unknown>).type = newType;
    }

    const patch = changed as UpdateFieldInput;
    const data = buildFieldUpdateData(existing, patch);
    if (changed.type !== undefined && typeof (changed as Record<string, unknown>).type === "string") {
      data["type"] = (changed as Record<string, unknown>).type;
    }
    const isLinkLike = existing.type === "links" || existing.type === "subtable";
    const backfilled = isLinkLike && !existing.linkFieldId && !existing.isReverse
      && !!patch.relatedTableId && patch.relatedTableId !== existing.relatedTableId;
    // updateFieldTx 的副作用（首次补配双向对、尾部 partner 同步）即目的；返回行不进 oplog。
    await updateFieldTx(tx, o.entityId, existing, patch, data, isLinkLike);
    await resyncTableMaskTx(tx, existing.tableId, userId);
    if (backfilled && patch.relatedTableId) await resyncTableMaskTx(tx, String(patch.relatedTableId), userId);
    return {
      entityType: "field", entityId: o.entityId, tableId: existing.tableId, op: o.op,
      payload: { tableId: existing.tableId, changed },
      resyncMaskTables: backfilled && patch.relatedTableId ? [existing.tableId, String(patch.relatedTableId)] : [existing.tableId],
    };
  },
};

const deleteFieldHandler: StructureOpHandler = {
  entityType: "field",
  async resolve(tx, baseId, o) {
    const existing = await tx.field.findUnique({
      where: { id: o.entityId },
      select: { tableId: true, deletedAt: true, table: { select: { baseId: true } } },
    });
    if (!existing || existing.deletedAt || existing.table.baseId !== baseId) {
      throw new HttpError(400, "字段不存在或不属于该 Base", "SYNC_ENTITY_NOT_FOUND");
    }
    return { tableId: existing.tableId, ref: { resourceType: "table", resourceId: existing.tableId }, action: "manage_schema" };
  },
  async apply(tx, userId, baseId, o) {
    const field = await tx.field.findUnique({ where: { id: o.entityId } });
    if (!field || field.deletedAt) throw new HttpError(400, "字段不存在或已删除", "SYNC_ENTITY_NOT_FOUND");
    await assertTableInBase(tx, field.tableId, baseId);
    const deletedIds = await deleteFieldTx(tx, field);
    const tableIds = new Set<string>([field.tableId]);
    for (const did of deletedIds) {
      const f = await tx.field.findUnique({ where: { id: did }, select: { tableId: true } });
      if (f) tableIds.add(f.tableId);
    }
    for (const tid of tableIds)     await resyncTableMaskTx(tx, tid, userId);
    return {
      entityType: "field", entityId: o.entityId, tableId: field.tableId, op: o.op,
      payload: { tableId: field.tableId, deleted: deletedIds },
      resyncMaskTables: [...tableIds],
    };
  },
};

// 恢复软删字段：目标字段本身可能处于软删态，不能用 alter_field 那套「活字段」解析。权限挂该字段
// 所属表节点判 manage_schema（§19.4）；表已软删时字段恢复随整表恢复（§19.3-4），此处仍按归属校验。
const restoreFieldHandler: StructureOpHandler = {
  entityType: "field",
  async resolve(tx, baseId, o) {
    const existing = await tx.field.findUnique({
      where: { id: o.entityId },
      select: { tableId: true, table: { select: { baseId: true } } },
    });
    if (!existing || existing.table.baseId !== baseId) {
      throw new HttpError(400, "字段不存在或不属于该 Base", "SYNC_ENTITY_NOT_FOUND");
    }
    return { tableId: existing.tableId, ref: { resourceType: "table", resourceId: existing.tableId }, action: "manage_schema" };
  },
  async apply(tx, userId, baseId, o) {
    const field = await tx.field.findUnique({
      where: { id: o.entityId },
      select: { tableId: true, table: { select: { baseId: true } } },
    });
    if (!field || field.table.baseId !== baseId) {
      throw new HttpError(400, "字段不存在或不属于该 Base", "SYNC_ENTITY_NOT_FOUND");
    }
    const r = await restoreFieldTx(tx, o.entityId);
    for (const tid of r.maskTableIds) await resyncTableMaskTx(tx, tid, userId);
    return {
      entityType: "field", entityId: o.entityId, tableId: r.tableId, op: o.op,
      payload: { tableId: r.tableId, name: r.name, renamed: r.renamed },
      resyncMaskTables: r.maskTableIds,
    };
  },
};

// 整表字段重排：entityType=field 但作用对象是整张表，entityId 约定＝tableId（oplog 实体 id 取表），
// 权威顺序以 payload.fieldIds（有序活字段 id 列表）为准；集合一致性由 reorderFieldsTx 强校验。
const reorderFieldsHandler: StructureOpHandler = {
  entityType: "field",
  async resolve(tx, baseId, o) {
    const tableId = str(o.payload.tableId) ?? o.entityId;
    if (!tableId) throw new HttpError(400, "reorder_fields 缺少 tableId", "SYNC_MALFORMED_PAYLOAD");
    await assertTableInBase(tx, tableId, baseId);
    return { tableId, ref: { resourceType: "table", resourceId: tableId }, action: "manage_schema" };
  },
  async apply(tx, _userId, baseId, o) {
    const tableId = str(o.payload.tableId) ?? o.entityId;
    if (!tableId) throw new HttpError(400, "reorder_fields 缺少 tableId", "SYNC_MALFORMED_PAYLOAD");
    await assertTableInBase(tx, tableId, baseId);
    const raw = o.payload.fieldIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((x) => typeof x !== "string" || !x)) {
      throw new HttpError(400, "reorder_fields 需要非空有序 fieldId 列表", "SYNC_MALFORMED_PAYLOAD");
    }
    const fieldIds = raw as string[];
    await reorderFieldsTx(tx, tableId, fieldIds);
    return {
      entityType: "field", entityId: tableId, tableId, op: o.op,
      payload: { tableId, fieldIds }, resyncMaskTables: [],
    };
  },
};

// ───────────────────────── view 族 ─────────────────────────

async function resolveViewTable(tx: DbTx, baseId: string, viewId: string): Promise<string> {
  const v = await tx.view.findUnique({
    where: { id: viewId },
    select: { tableId: true, table: { select: { baseId: true, deletedAt: true } } },
  });
  if (!v || v.table.baseId !== baseId) throw new HttpError(400, "视图不存在或不属于该 Base", "SYNC_ENTITY_NOT_FOUND");
  return v.tableId;
}

const createViewHandler: StructureOpHandler = {
  entityType: "view",
  async resolve(tx, baseId, o) {
    const tableId = str(o.payload.tableId);
    if (!tableId) throw new HttpError(400, "create_view 缺少 tableId", "SYNC_MALFORMED_PAYLOAD");
    await assertTableInBase(tx, tableId, baseId);
    return { tableId, ref: { resourceType: "table", resourceId: tableId }, action: "manage_schema" };
  },
  async apply(tx, _userId, baseId, o) {
    const tableId = str(o.payload.tableId);
    const name = str(o.payload.name);
    const type = str(o.payload.type);
    if (!tableId || !name || !type) {
      throw new HttpError(400, "create_view 缺少 tableId/name/type", "SYNC_MALFORMED_PAYLOAD");
    }
    const config = asRecord(o.payload.config) ?? undefined;
    const v = await createViewTx(tx, { tableId, name, type, config, viewId: o.entityId });
    return {
      entityType: "view", entityId: v.id, tableId, op: o.op,
      payload: { tableId, name, type, ...(config ? { config } : {}) },
      resyncMaskTables: [],
    };
  },
};

const alterViewHandler: StructureOpHandler = {
  entityType: "view",
  async resolve(tx, baseId, o) {
    const tableId = await resolveViewTable(tx, baseId, o.entityId);
    return { tableId, ref: { resourceType: "table", resourceId: tableId }, action: "manage_schema" };
  },
  async apply(tx, _userId, _baseId, o) {
    const existing = await tx.view.findUnique({ where: { id: o.entityId } });
    if (!existing) throw new HttpError(400, "视图不存在", "SYNC_ENTITY_NOT_FOUND");
    const data: Record<string, unknown> = {};
    let affectsNav = false;
    if (o.payload.name !== undefined) {
      const name = str(o.payload.name);
      if (!name) throw new HttpError(400, "视图名不能为空", "SYNC_MALFORMED_PAYLOAD");
      data["name"] = name; affectsNav = true;
    }
    if (o.payload.type !== undefined) {
      const type = str(o.payload.type);
      if (!type) throw new HttpError(400, "视图 type 非法", "SYNC_MALFORMED_PAYLOAD");
      data["type"] = type;
    }
    if (o.payload.order !== undefined) {
      if (typeof o.payload.order !== "number" || !Number.isFinite(o.payload.order)) {
        throw new HttpError(400, "视图 order 非法", "SYNC_MALFORMED_PAYLOAD");
      }
      data["order"] = o.payload.order; affectsNav = true;
    }
    const config = asRecord(o.payload.config);
    if (config) {
      // 与在线 PATCH 同口径：在现有配置上浅合并后落库（保留未提供的默认键）。
      const merged = { ...parseViewConfig(existing.config), ...config };
      data["config"] = JSON.stringify(merged);
    }
    if (Object.keys(data).length === 0) {
      throw new HttpError(400, "alter_view 无可应用变更", "SYNC_MALFORMED_PAYLOAD");
    }
    await updateViewTx(tx, { viewId: o.entityId, data, affectsNav, snapshot: null });
    return {
      entityType: "view", entityId: o.entityId, tableId: existing.tableId, op: o.op,
      payload: { tableId: existing.tableId, ...o.payload },
      resyncMaskTables: [],
    };
  },
};

const deleteViewHandler: StructureOpHandler = {
  entityType: "view",
  async resolve(tx, baseId, o) {
    const tableId = await resolveViewTable(tx, baseId, o.entityId);
    return { tableId, ref: { resourceType: "table", resourceId: tableId }, action: "manage_schema" };
  },
  async apply(tx, _userId, _baseId, o) {
    const existing = await tx.view.findUnique({ where: { id: o.entityId }, select: { tableId: true } });
    if (!existing) throw new HttpError(400, "视图不存在", "SYNC_ENTITY_NOT_FOUND");
    await assertAndPurgeViewTx(tx, o.entityId);
    return {
      entityType: "view", entityId: o.entityId, tableId: existing.tableId, op: o.op,
      payload: { tableId: existing.tableId }, resyncMaskTables: [],
    };
  },
};

// ───────────────────────── 注册表本体（引擎只认它） ─────────────────────────

const REGISTRY = new Map<string, StructureOpHandler>([
  [`table:create_table`, createTableHandler],
  [`table:rename_table`, renameTableHandler],
  [`table:update_table_settings`, updateTableSettingsHandler],
  [`table:delete_table`, deleteTableHandler],
  [`table:restore_table`, restoreTableHandler],
  [`field:add_field`, addFieldHandler],
  [`field:create_link_field`, addFieldHandler], // 同处理器，按 payload 是否成对分流
  [`field:alter_field`, alterFieldHandler],
  [`field:delete_field`, deleteFieldHandler],
  [`field:restore_field`, restoreFieldHandler],
  [`field:reorder_fields`, reorderFieldsHandler],
  [`view:create_view`, createViewHandler],
  [`view:alter_view`, alterViewHandler],
  [`view:delete_view`, deleteViewHandler],
]);

export function registryKey(entityType: string, op: string): string {
  return `${entityType}:${op}`;
}

export function getStructureOpHandler(entityType: string, op: string): StructureOpHandler | null {
  return REGISTRY.get(registryKey(entityType, op)) ?? null;
}

/** 结构轨支持的实体族（供引擎区分结构轨 vs 记录轨；nav/menu 随 YN8 在此登记）。 */
export const STRUCTURE_ENTITY_TYPES: ReadonlySet<string> = new Set(["table", "field", "view"]);

export function isStructureEntityType(entityType: string): boolean {
  return STRUCTURE_ENTITY_TYPES.has(entityType);
}
