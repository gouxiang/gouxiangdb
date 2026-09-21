// apps/api/src/domain/authz/libraryScopeConfig.ts
// 角色库视野配置的【解析与清洗】。
//
// 从 libraryPolicy.ts 拆出，只为守单文件 <=300 行：这一半是纯字符串/JSON 的形状转换，
// 与裁决逻辑没有耦合，单独放也便于直接单测坏输入的容错行为。
//
// 清洗纪律：认不出的值一律【丢弃】而不是静默降级。
// 一个不认识的字段权限档位若被降级成 editable，等于把管理员从没表达过的放权凭空发出去；
// 丢弃最多是"这条没配"，管理员看到不生效会回来重配——错误信息比错误的默认值便宜得多。

import type {
  FieldAccess,
  LibraryKind,
  LibraryScopeConfig,
  PutLibraryScopeInput,
  RoleLibraryScopeDTO,
  TableAccess,
} from "@gx/shared-types";
import { EMPTY_LIBRARY_SCOPE_CONFIG, EMPTY_TABLE_ACCESS } from "@gx/shared-types";

/** 坏 JSON 一律当作"没配"：宁可退回库级只读，也不要让整个请求 500。 */
export function parseConfig(raw: string): LibraryScopeConfig {
  try {
    const parsed = JSON.parse(raw) as LibraryScopeConfig;
    if (!parsed || typeof parsed !== "object") return EMPTY_LIBRARY_SCOPE_CONFIG;
    return {
      tables: parsed.tables && typeof parsed.tables === "object" ? parsed.tables : {},
      fields: parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {},
    };
  } catch {
    return EMPTY_LIBRARY_SCOPE_CONFIG;
  }
}

export function parseScopeInput(input: {
  libraryKind?: unknown;
  libraryId?: unknown;
  canManage?: unknown;
  visible?: unknown;
  config?: unknown;
}): PutLibraryScopeInput {
  const libraryId = typeof input.libraryId === "string" ? input.libraryId.trim() : "";
  if (!libraryId) throw Object.assign(new Error("缺少 libraryId"), { status: 400 });
  return {
    libraryKind: input.libraryKind === "kb" ? "kb" : "base",
    libraryId,
    canManage: input.canManage === true,
    visible: input.visible === true,
    config: normalizeIncomingConfig(input.config),
  };
}

/** 入参清洗：未知字段权限档位直接丢弃，不静默降级成 editable。 */
export function normalizeIncomingConfig(raw: unknown): LibraryScopeConfig {
  if (!raw || typeof raw !== "object") return EMPTY_LIBRARY_SCOPE_CONFIG;
  const o = raw as Record<string, unknown>;
  const out: LibraryScopeConfig = { tables: {}, fields: {} };
  const tableMap = (o.tables && typeof o.tables === "object" ? o.tables : {}) as Record<string, unknown>;
  for (const [tableId, v] of Object.entries(tableMap)) {
    if (!v || typeof v !== "object") continue;
    const p = v as Record<string, unknown>;
    out.tables[tableId] = {
      read: p.read === true,
      create: p.create === true,
      update: p.update === true,
      delete: p.delete === true,
    };
  }
  const fieldMap = (o.fields && typeof o.fields === "object" ? o.fields : {}) as Record<string, unknown>;
  for (const [tableId, v] of Object.entries(fieldMap)) {
    if (!v || typeof v !== "object") continue;
    const perField: Record<string, FieldAccess> = {};
    for (const [fieldId, mode] of Object.entries(v as Record<string, unknown>)) {
      if (mode === "editable" || mode === "visible" || mode === "hidden") perField[fieldId] = mode;
    }
    out.fields[tableId] = perField;
  }
  return out;
}

export function toScopeDTO(row: {
  id: string; roleId: string; libraryKind: string; libraryId: string;
  canManage: number; visible: number; config: string; updatedAt: Date;
}, libraryName: string): RoleLibraryScopeDTO {
  const cfg = parseConfig(row.config);
  const tables: Record<string, TableAccess> = {};
  for (const [tableId, partial] of Object.entries(cfg.tables)) {
    tables[tableId] = { ...EMPTY_TABLE_ACCESS, ...partial };
  }
  return {
    id: row.id,
    roleId: row.roleId,
    libraryKind: row.libraryKind as LibraryKind,
    libraryId: row.libraryId,
    libraryName,
    canManage: row.canManage === 1,
    visible: row.visible === 1,
    tables,
    fields: cfg.fields,
    updatedAt: row.updatedAt.toISOString(),
  };
}
