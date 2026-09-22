// apps/api/src/domain/authz/libraryPolicy.ts
// 权限核心模型（二）：库 / 表 / 字段级放行的【唯一裁决函数】。
//
// 全仓库只有这里算"这个人能不能对这个库/这张表/这个字段做什么"。
// guards.ts、kb/shared.ts、routes/* 一律只读本模块吐出来的 LibraryAccess，
// 不许再自己拼一套判断——旧的三条并行判定（Member.role / kbMember.role / kbDocAcl）
// 正是本次重构要彻底退出的东西。
//
// 治理规则按优先级自上而下短路：
//   1. 超级管理员：全权（可见全部库、管理全部库、删库、开分享），与库视野配置无关。
//   2. 管理员：能进所有库，但对某个库的【管理权】仍必须来自 role_library_scope 的
//      canManage 勾选——"管理员进得去不一定管得了"。不能删库。
//   3. 其余：逐条合成该用户全部有效角色的库视野，多角色取并集（最宽松）。
//   4. 一条都没命中（含受限成员、零角色用户）：什么都看不了。
//
// 四条无论如何都不下放给配置的硬规则，全部在此现算、不落库：
//   A 删库        —— 只有超级管理员；canManage 也不行。
//   B 建库/建知识库 —— 超级管理员、管理员。
//   C 允许分享开关 —— 对该库有管理权者 + 超级管理员 + 管理员。
//   D 分享链接进来的外部人 —— 恒只读（实现在 routes/public.ts，与本模块的"内部成员"无关）。

import { prisma } from "../../db.js";
import type {
  FieldAccess,
  LibraryAccessDTO,
  LibraryKind,
  LibraryScopeConfig,
  PutLibraryScopeInput,
  RoleLibraryScopeDTO,
  TableAccess,
} from "@gx/shared-types";
import {
  EMPTY_LIBRARY_SCOPE_CONFIG,
  EMPTY_TABLE_ACCESS,
  FIELD_ACCESS_RANK,
  FULL_TABLE_ACCESS,
  KB_CONTENT_KEY,
  READONLY_TABLE_ACCESS,
} from "@gx/shared-types";
import { parseConfig } from "./libraryScopeConfig.js";
import { effectiveRoleRows } from "../org/authorization.js";
import { ADMIN_ROLE_ID, SUPER_ADMIN_ROLE_ID } from "../org/roles.js";
import { HttpError } from "../../httpError.js";

/**
 * 通配哨兵：access.tables 里出现这个 key = 对该库【全表】全权限。
 * 由「可管理库」推导而来——管理权是库级的，不逐表展开，"勾了可管理却管不了第五张表"
 * 只会制造无法解释的洞。
 */
const WILDCARD_TABLE = "*";

const SUPER_ACCESS: LibraryAccessDTO = {
  visible: true,
  canManage: true,
  canDeleteLibrary: true, // 硬规则 A：唯一一处把删库置 true 的地方
  canToggleShare: true,
  source: "super_admin",
  tables: { [WILDCARD_TABLE]: FULL_TABLE_ACCESS },
  fields: {},
};

// ---------------------------------------------------------------------------
// 纯合成（不碰库，可直接单测）
// ---------------------------------------------------------------------------

function permOr(a: TableAccess, b: TableAccess): TableAccess {
  return {
    read: a.read || b.read,
    create: a.create || b.create,
    update: a.update || b.update,
    delete: a.delete || b.delete,
  };
}

function maxFieldAccess(a: FieldAccess, b: FieldAccess): FieldAccess {
  return FIELD_ACCESS_RANK[a] >= FIELD_ACCESS_RANK[b] ? a : b;
}

/** 由若干条角色视野合成一个人在某个库上的最终裁决（不含超级管理员/管理员短路）。 */
export function synthesizeAccess(
  rows: Array<{ canManage: number; visible: number; config: string }>,
): LibraryAccessDTO {
  const tables: Record<string, TableAccess> = {};
  const fields: Record<string, Record<string, FieldAccess>> = {};
  let visible = false;
  let canManage = false;

  for (const row of rows) {
    visible = visible || row.visible === 1;
    canManage = canManage || row.canManage === 1;
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
    canToggleShare: canManage, // 硬规则 C：管理员之外，谁能管谁能开
    source: visible || canManage ? "role_scope" : "none",
    tables,
    fields,
  };
}

// ---------------------------------------------------------------------------
// 读取器：路由/守卫一律通过这些函数取裁决结果
// ---------------------------------------------------------------------------

/** 某张表的四枚数据动作。通配优先 → 精确配置 → 库级默认（可见即只读）。 */
export function tableAccessOf(access: LibraryAccessDTO, tableId: string): TableAccess {
  const wildcard = access.tables[WILDCARD_TABLE];
  if (wildcard) return wildcard;
  const exact = access.tables[tableId];
  if (exact) return exact;
  return access.visible ? READONLY_TABLE_ACCESS : EMPTY_TABLE_ACCESS;
}

/**
 * 某字段对"人"的三档权限。缺省 editable：只在被明确配过时才降级。
 * 收权方向错了没人会发现，放权方向错了马上有人来报，所以默认取后者。
 */
export function fieldAccessOf(access: LibraryAccessDTO, tableId: string, fieldId: string): FieldAccess {
  return access.fields[tableId]?.[fieldId] ?? "editable";
}

/** 知识库没有"表"，文档与画布共用 content 这个对象的四枚动作。 */
export function contentAccessOf(access: LibraryAccessDTO): TableAccess {
  return tableAccessOf(access, KB_CONTENT_KEY);
}

/** 人能不能写这个字段：'仅可见'与'隐藏'都不能写。系统自动计算不受此限制。 */
export function humanCanWriteField(access: LibraryAccessDTO, tableId: string, fieldId: string): boolean {
  return fieldAccessOf(access, tableId, fieldId) === "editable";
}

/** 造一个"字段写闸"交给 recordWrite 事务体：落盘前挡住人对仅可见/隐藏字段的写入。 */
export function fieldWriteGate(
  access: LibraryAccessDTO,
  tableId: string,
  fieldNameOf: (fieldId: string) => string,
): (fieldIds: readonly string[]) => void {
  return (fieldIds) => {
    const bad = firstUnwritableField(access, tableId, fieldIds);
    if (!bad) return;
    // 用 HttpError 而不是 `Object.assign(new Error, {status})`：后者只有 .status 字段，
    // 统一错误出口按 instanceof 判定，会把它当未知错误吞成 500「服务器内部错误」——
    // 「管理员配了仅可见/隐藏字段、写入被拒」明明是一次正常拒绝，却报成故障。
    throw new HttpError(403, `字段「${fieldNameOf(bad)}」为仅可见或已隐藏，不可编辑`);
  };
}

/** humanCanWriteField 的复数形式：一次判断整批键，任一键不可写返回该字段名。 */
export function firstUnwritableField(
  access: LibraryAccessDTO,
  tableId: string,
  fieldIds: readonly string[],
): string | null {
  for (const fieldId of fieldIds) {
    if (!humanCanWriteField(access, tableId, fieldId)) return fieldId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 裁决出口
// ---------------------------------------------------------------------------

async function resolve(userId: string, kind: LibraryKind, libraryId: string): Promise<LibraryAccessDTO> {
  const roles = await effectiveRoleRows(userId);
  const roleIds = roles.map((r) => r.roleId);
  if (roleIds.includes(SUPER_ADMIN_ROLE_ID)) return SUPER_ACCESS;

  const rows = await prisma.roleLibraryScope.findMany({
    where: { roleId: { in: roleIds }, libraryKind: kind, libraryId },
    select: { canManage: true, visible: true, config: true },
  });
  const merged = synthesizeAccess(rows);
  // 硬规则短路 2：管理员进得了所有库，管理权仍在配置里，永不持删库权。
  if (roleIds.includes(ADMIN_ROLE_ID)) {
    return { ...merged, visible: true, canToggleShare: true, source: "admin" };
  }
  return merged;
}

/** Base（数据表库）裁决入口。 */
export function resolveBaseAccess(userId: string, baseId: string): Promise<LibraryAccessDTO> {
  return resolve(userId, "base", baseId);
}

/** 知识库裁决入口。 */
export function resolveKbAccess(userId: string, kbId: string): Promise<LibraryAccessDTO> {
  return resolve(userId, "kb", kbId);
}

async function baseIdBy(tableIdField: "table" | "view" | "record", id: string): Promise<string | null> {
  if (tableIdField === "table") {
    const t = await prisma.table.findUnique({ where: { id }, select: { baseId: true } });
    return t?.baseId ?? null;
  }
  if (tableIdField === "view") {
    const v = await prisma.view.findUnique({ where: { id }, select: { table: { select: { baseId: true } } } });
    return v?.table.baseId ?? null;
  }
  const r = await prisma.record.findUnique({
    where: { id },
    select: { table: { select: { baseId: true } } },
  });
  return r?.table.baseId ?? null;
}

/** 手上只有 tableId 时的裁决入口。 */
export async function resolveBaseAccessByTable(userId: string, tableId: string): Promise<LibraryAccessDTO | null> {
  const baseId = await baseIdBy("table", tableId);
  return baseId ? resolve(userId, "base", baseId) : null;
}

/** 手上只有 viewId 时的裁决入口。 */
export async function resolveBaseAccessByView(userId: string, viewId: string): Promise<LibraryAccessDTO | null> {
  const baseId = await baseIdBy("view", viewId);
  return baseId ? resolve(userId, "base", baseId) : null;
}

/** 手上只有 recordId 时的裁决入口。 */
export async function resolveBaseAccessByRecord(userId: string, recordId: string): Promise<LibraryAccessDTO | null> {
  const baseId = await baseIdBy("record", recordId);
  return baseId ? resolve(userId, "base", baseId) : null;
}

/** 硬规则 B：能不能新建库/知识库（超级管理员或管理员）。 */
export async function canCreateLibrary(userId: string): Promise<boolean> {
  const roles = await effectiveRoleRows(userId);
  return roles.some((r) => r.roleId === SUPER_ADMIN_ROLE_ID || r.roleId === ADMIN_ROLE_ID);
}

/**
 * 列表场景：一次算出这个人在一批库上的裁决（避免逐库 N+1 求值）。
 * 超级管理员/管理员对所有库可见，故返回 all=true 让调用方直接全表查。
 */
export async function visibleLibraryIds(
  userId: string,
  kind: LibraryKind,
): Promise<{ all: boolean; ids: string[] }> {
  const roles = await effectiveRoleRows(userId);
  const roleIds = roles.map((r) => r.roleId);
  if (roleIds.includes(SUPER_ADMIN_ROLE_ID) || roleIds.includes(ADMIN_ROLE_ID)) {
    return { all: true, ids: [] };
  }
  const rows = await prisma.roleLibraryScope.findMany({
    where: { roleId: { in: roleIds }, libraryKind: kind, OR: [{ visible: 1 }, { canManage: 1 }] },
    select: { libraryId: true },
  });
  return { all: false, ids: [...new Set(rows.map((r) => r.libraryId))] };
}

/** 批量裁决：一次查询合成多个库的访问结果（列表页用，避免逐库求值）。 */
export async function resolveManyAccess(
  userId: string,
  kind: LibraryKind,
  libraryIds: readonly string[],
): Promise<Map<string, LibraryAccessDTO>> {
  const roles = await effectiveRoleRows(userId);
  const roleIds = roles.map((r) => r.roleId);
  const isSuper = roleIds.includes(SUPER_ADMIN_ROLE_ID);
  const isAdmin = roleIds.includes(ADMIN_ROLE_ID);
  const out = new Map<string, LibraryAccessDTO>();
  if (isSuper) {
    for (const id of libraryIds) out.set(id, SUPER_ACCESS);
    return out;
  }
  const rows = await prisma.roleLibraryScope.findMany({
    where: { roleId: { in: roleIds }, libraryKind: kind, libraryId: { in: [...libraryIds] } },
    select: { libraryId: true, canManage: true, visible: true, config: true },
  });
  const grouped = new Map<string, Array<{ canManage: number; visible: number; config: string }>>();
  for (const r of rows) {
    const arr = grouped.get(r.libraryId) ?? [];
    arr.push(r);
    grouped.set(r.libraryId, arr);
  }
  for (const id of libraryIds) {
    const merged = synthesizeAccess(grouped.get(id) ?? []);
    out.set(id, isAdmin ? { ...merged, visible: true, canToggleShare: true, source: "admin" } : merged);
  }
  return out;
}

