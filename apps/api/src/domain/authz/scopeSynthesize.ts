// apps/api/src/domain/authz/scopeSynthesize.ts
// P1/S4 纯提取：libraryPolicy.ts 中【纯合成、零 IO】部分的新住所。
// 只依赖 @gx/shared-types 与 libraryScopeConfig.parseConfig，不 import prisma/db 单例，
// 供零 IO 模块（scopeProjection.projectImplicitAdmin）安全复用；libraryPolicy.ts re-export 本文件，
// 既有 import { synthesizeAccess } from ".../libraryPolicy" 的调用点零改动。行为逐字保持，不重写。

import type {
  FieldAccess,
  LibraryAccessDTO,
  TableAccess,
} from "@gx/shared-types";
import {
  EMPTY_TABLE_ACCESS,
  FIELD_ACCESS_RANK,
  FULL_TABLE_ACCESS,
} from "@gx/shared-types";
import { parseConfig } from "./libraryScopeConfig.js";

/**
 * 通配哨兵：access.tables 里出现这个 key = 对该库【全表】全权限。
 * 由「可管理库」推导而来——管理权是库级的，不逐表展开。
 */
export const WILDCARD_TABLE = "*";

export function permOr(a: TableAccess, b: TableAccess): TableAccess {
  return {
    read: a.read || b.read,
    create: a.create || b.create,
    update: a.update || b.update,
    delete: a.delete || b.delete,
  };
}

export function maxFieldAccess(a: FieldAccess, b: FieldAccess): FieldAccess {
  return FIELD_ACCESS_RANK[a] >= FIELD_ACCESS_RANK[b] ? a : b;
}

/** 由若干条角色视野合成一个人在某个库上的最终裁决（不含超级管理员/管理员短路）。 */
export function synthesizeAccess(
  rows: Array<{ canManage: number; visible: number; canShare: number; config: string }>,
): LibraryAccessDTO {
  const tables: Record<string, TableAccess> = {};
  const fields: Record<string, Record<string, FieldAccess>> = {};
  let visible = false;
  let canManage = false;
  let canShare = false;

  for (const row of rows) {
    visible = visible || row.visible === 1;
    canManage = canManage || row.canManage === 1;
    canShare = canShare || row.canShare === 1;
    const cfg = parseConfig(row.config);
    for (const [tableId, partial] of Object.entries(cfg.tables)) {
      tables[tableId] = permOr(tables[tableId] ?? EMPTY_TABLE_ACCESS, { ...EMPTY_TABLE_ACCESS, ...partial });
    }
    for (const [tableId, perField] of Object.entries(cfg.fields)) {
      const merged = fields[tableId] ?? {};
      for (const [fieldId, mode] of Object.entries(perField)) {
        if (typeof mode !== "string") continue;
        merged[fieldId] = merged[fieldId] ? maxFieldAccess(merged[fieldId]!, mode) : mode;
      }
      fields[tableId] = merged;
    }
  }

  if (canManage) tables[WILDCARD_TABLE] = FULL_TABLE_ACCESS;

  return {
    visible,
    canManage,
    canDeleteLibrary: false, // 硬规则 A：配置永远给不了删库
    canToggleShare: canManage,
    canShare: canManage || canShare,
    source: visible || canManage ? "role_scope" : "none",
    tables,
    fields,
  };
}
