// apps/api/src/guards.ts
// 路由级权限守卫。
//
// 权限核心模型重构后：库/表/字段级的裁定【只有一个来源】——
// domain/authz/libraryPolicy.ts 的 resolveBaseAccess。本文件不再读 Member.role，
// 也不再自己拼权限位：下面每个 require* 都是对同一份 LibraryAccess 的一次取 shard。
//
// 保留 PermissionSet 这个返回形态：旧调用点（tables/fields/records/views…）按布尔位分支，
// 一次改完它们的入参会牵动十几处路由；保留形态、换掉计算，是零行为漂移的最小改动面。
// 需要表/字段级细粒度时用返回的 access + libraryPolicy 的 tableAccessOf/fieldAccessOf。

import type { Context } from "hono";
import { prisma } from "./db.js";
import { getUserId, type Role } from "./auth.js";
import type { PermissionSet, TableAccess } from "@gx/shared-types";
import { authzShadowActive } from "./configAuthz.js";
import { runShadowCheck } from "./domain/authz/adapter.js";
import type { LibraryAccessDTO } from "@gx/shared-types";
import { HttpError, errorCodeForStatus } from "./httpError.js";
import {
  resolveBaseAccess,
  resolveBaseAccessByRecord,
  resolveBaseAccessByTable,
  resolveBaseAccessByView,
  tableAccessOf,
} from "./domain/authz/libraryPolicy.js";

// 4xx 错误类与状态码映射在 httpError.ts（零依赖）：domain/** 也要抛 4xx，
// 但 domain 不能 import 本文件（会拖入 Hono 的 Context）。这里转出保持既有调用点不变。
export { HttpError };

export async function requireUserId(c: Context): Promise<string> {
  const userId = await getUserId(c);
  if (!userId) throw new HttpError(401, "未登录");
  return userId;
}

// ============ id 反查（纯数据访问，与授权无关） ============

export async function resolveBaseIdByTable(tableId: string): Promise<string | null> {
  const t = await prisma.table.findUnique({ where: { id: tableId }, select: { baseId: true } });
  return t?.baseId ?? null;
}

export async function resolveBaseIdByView(viewId: string): Promise<string | null> {
  const v = await prisma.view.findUnique({
    where: { id: viewId },
    select: { table: { select: { baseId: true } } },
  });
  return v?.table.baseId ?? null;
}

export async function resolveBaseIdByRecord(recordId: string): Promise<string | null> {
  const r = await prisma.record.findUnique({
    where: { id: recordId },
    select: { table: { select: { baseId: true } } },
  });
  return r?.table.baseId ?? null;
}

// ============ 由唯一裁决结果推导旧形态 ============

/** 把 LibraryAccess 投影成旧的五个权限位（供未改造的调用点与列表接口继续使用）。 */
export function permit(access: LibraryAccessDTO): PermissionSet {
  // 库级可管理 = 全表可写；否则看有没有任何一张表被勾了写动作。
  const anyWritable = Object.values(access.tables).some((t: TableAccess) => t.create || t.update || t.delete);
  const canEditData = access.canManage || anyWritable;
  return {
    canManageBase: access.canManage,
    canManageSchema: access.canManage,
    canEditData,
    // 只读可见不等于可评论：旧模型里 viewer 的 canComment 就是 false，评论权跟写权限走。
    // 新模型没有"评论者"这一档库权限，故沿用旧口径——宁可窄，不擅自放宽。
    canComment: canEditData,
    canView: access.visible,
  };
}

/** 展示用角色名。不承载授权语义，答案本身由同一份 LibraryAccess 推出。 */
export function displayRole(access: LibraryAccessDTO): Role {
  if (access.canManage) return "owner";
  if (permit(access).canEditData) return "editor";
  if (access.visible) return "viewer";
  return "viewer";
}

const DENY_PERM: PermissionSet = {
  canManageBase: false,
  canManageSchema: false,
  canEditData: false,
  canComment: false,
  canView: false,
};

/** M4/S3 shadow 对拍缝：仅 shadow 模式下跑引擎对拍，只计数/记日志，不改返回、不抛错。 */
async function shadowBase(
  guard: string,
  userId: string,
  baseId: string,
  action: ResourceActionLiteral,
  oldAllowed: boolean,
): Promise<void> {
  if (!authzShadowActive()) return;
  await runShadowCheck(guard, userId, { resourceType: "base", resourceId: baseId }, action, oldAllowed);
}

type ResourceActionLiteral = "r" | "c" | "u" | "d" | "comment" | "manage_share" | "manage_schema";

/** 加载一次裁决结果（同一个请求里多处复用同一份评估）。 */
export async function baseAccessOf(userId: string, baseId: string): Promise<LibraryAccessDTO> {
  return resolveBaseAccess(userId, baseId);
}

/** 按 tableId 加载裁决结果；表不存在返回 null。 */
export async function baseAccessOfTable(userId: string, tableId: string): Promise<LibraryAccessDTO | null> {
  return resolveBaseAccessByTable(userId, tableId);
}

export async function permissionsOf(userId: string, baseId: string): Promise<PermissionSet> {
  const access = await resolveBaseAccess(userId, baseId);
  if (!access.visible) return DENY_PERM;
  return permit(access);
}

// ============ 守卫 ============

export interface BaseGuardResult {
  userId: string;
  /** 展示用角色名，不承载授权语义。 */
  role: Role;
  perm: PermissionSet;
  access: LibraryAccessDTO;
}

async function loadBaseAccess(c: Context, baseId: string): Promise<BaseGuardResult> {
  const userId = await requireUserId(c);
  const access = await resolveBaseAccess(userId, baseId);
  return {
    userId,
    role: access.visible ? displayRole(access) : ("viewer" as Role),
    perm: access.visible ? permit(access) : DENY_PERM,
    access,
  };
}

export async function requireRole(c: Context, baseId: string): Promise<Role> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) throw new HttpError(403, "无权访问该 Base");
  return g.role;
}

export async function requireCanView(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) {
    await shadowBase("requireCanView", g.userId, baseId, "r", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  await shadowBase("requireCanView", g.userId, baseId, "r", true);
  return g;
}

export async function requireCanEditData(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) {
    await shadowBase("requireCanEditData", g.userId, baseId, "u", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!g.perm.canEditData) {
    await shadowBase("requireCanEditData", g.userId, baseId, "u", false);
    throw new HttpError(403, "当前角色无权编辑数据");
  }
  await shadowBase("requireCanEditData", g.userId, baseId, "u", true);
  return g;
}

export async function requireCanManageSchema(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) {
    await shadowBase("requireCanManageSchema", g.userId, baseId, "manage_schema", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!g.perm.canManageSchema) {
    await shadowBase("requireCanManageSchema", g.userId, baseId, "manage_schema", false);
    throw new HttpError(403, "当前角色无权修改表结构");
  }
  await shadowBase("requireCanManageSchema", g.userId, baseId, "manage_schema", true);
  return g;
}

export async function requireCanManageBase(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) {
    await shadowBase("requireCanManageBase", g.userId, baseId, "manage_share", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!g.perm.canManageBase) {
    await shadowBase("requireCanManageBase", g.userId, baseId, "manage_share", false);
    throw new HttpError(403, "只有对本库有管理权限的角色可管理该库");
  }
  await shadowBase("requireCanManageBase", g.userId, baseId, "manage_share", true);
  return g;
}

/** 硬规则：删除库只有超级管理员（管理权不含删库，故单独成守卫，别挂到 requireCanManageBase）。 */
export async function requireCanDeleteBase(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) throw new HttpError(403, "无权访问该 Base");
  if (!g.access.canDeleteLibrary) {
    throw new HttpError(403, "只有超级管理员可以删除库");
  }
  return g;
}

/** 硬规则 C：开关某个库的「允许分享」——对该库有管理权者 + 超级管理员 + 管理员。 */
export async function requireCanToggleShare(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) throw new HttpError(403, "无权访问该 Base");
  if (!g.access.canToggleShare) {
    throw new HttpError(403, "只有对本库有管理权限的角色、超级管理员或管理员可开关分享");
  }
  return g;
}

export async function requireCanComment(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  if (!g.access.visible) {
    await shadowBase("requireCanComment", g.userId, baseId, "comment", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!g.perm.canComment) {
    await shadowBase("requireCanComment", g.userId, baseId, "comment", false);
    throw new HttpError(403, "当前角色无权评论");
  }
  await shadowBase("requireCanComment", g.userId, baseId, "comment", true);
  return g;
}

// ============ 表级细粒度（拿到 tableId 的路由应当使用这一组） ============

/** 表不存在 -> 404；不可见 -> 403。返回该表的四枚数据动作。 */
export async function requireTableAccess(
  c: Context,
  tableId: string,
): Promise<{ userId: string; access: LibraryAccessDTO; table: ReturnType<typeof tableAccessOf> }> {
  const userId = await requireUserId(c);
  const access = await resolveBaseAccessByTable(userId, tableId);
  if (!access) throw new HttpError(404, "表不存在");
  const table = tableAccessOf(access, tableId);
  if (!table.read) throw new HttpError(403, "无权查看该表");
  return { userId, access, table };
}

/** 按 recordId / viewId 反查所在库后裁决（无单表语义，走库级并集）。 */
export async function baseAccessOfRecord(userId: string, recordId: string): Promise<LibraryAccessDTO | null> {
  return resolveBaseAccessByRecord(userId, recordId);
}

export async function baseAccessOfView(userId: string, viewId: string): Promise<LibraryAccessDTO | null> {
  return resolveBaseAccessByView(userId, viewId);
}

// ============ 统一错误出口 ============

/** 统一错误出口 */
export function errorResponse(c: Context, e: unknown) {
  if (e instanceof HttpError) {
    return c.json(
      { error: e.message, code: e.code ?? errorCodeForStatus(e.status) },
      e.status as 400 | 401 | 403 | 404 | 409,
    );
  }
  console.error("[api error]", e);
  // U-10：500 不回传内部错误消息（可能含 SQL/路径/堆栈信息），仅开发环境附带便于调试
  const isDev = process.env.NODE_ENV === "development";
  const msg = e instanceof Error ? e.message : String(e);
  return c.json(
    { error: "服务器内部错误", code: "INTERNAL", ...(isDev ? { message: msg } : {}) },
    500,
  );
}
