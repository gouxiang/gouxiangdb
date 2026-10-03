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
import type { PermissionSet, ResourceAction, TableAccess } from "@gx/shared-types";
import { enforceOrLegacy, type EnforceSemantics } from "./domain/authz/enforceGate.js";
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

/**
 * M4/R1 七守统一接线缝：先由第二代 libraryPolicy 算出旧决策，再交 enforceOrLegacy 定权威结论。
 *
 * 三态（ADR-0037 / AUTHZ-LEGACY-GUARD-CLEANUP 阶段 R1）：
 *   off    —— 原样返回旧决策，零引擎 IO；
 *   shadow —— 原样返回旧决策 + 正向对拍（旧为准，引擎只对比）；
 *   on     —— 引擎结论为权威（conjunction 时为「旧 ∧ 引擎」），旧决策反向对拍。
 * 403 文案与状态码一律由【调用方】按旧口径挑选（见各守卫），本函数只回答"放不放行"，
 * 故 off/shadow 两态响应与接线前逐字节一致。
 */
async function enforceBase(
  guard: string,
  userId: string,
  baseId: string,
  action: ResourceAction,
  legacyAllowed: boolean,
  semantics?: EnforceSemantics,
): Promise<boolean> {
  const out = await enforceOrLegacy({
    guard,
    userId,
    action,
    legacyAllowed,
    semantics,
    ref: { resourceType: "base", resourceId: baseId },
  });
  return out.allowed;
}

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
  const allowed = await enforceBase("requireCanView", g.userId, baseId, "r", g.access.visible);
  if (!allowed) throw new HttpError(403, "无权访问该 Base");
  return g;
}

export async function requireCanEditData(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  const legacyAllowed = g.access.visible && g.perm.canEditData;
  const allowed = await enforceBase("requireCanEditData", g.userId, baseId, "u", legacyAllowed);
  if (!allowed) {
    throw new HttpError(403, g.access.visible ? "当前角色无权编辑数据" : "无权访问该 Base");
  }
  return g;
}

export async function requireCanManageSchema(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  const legacyAllowed = g.access.visible && g.perm.canManageSchema;
  const allowed = await enforceBase("requireCanManageSchema", g.userId, baseId, "manage_schema", legacyAllowed);
  if (!allowed) {
    throw new HttpError(403, g.access.visible ? "当前角色无权修改表结构" : "无权访问该 Base");
  }
  return g;
}

export async function requireCanManageBase(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  const legacyAllowed = g.access.visible && g.perm.canManageBase;
  const allowed = await enforceBase("requireCanManageBase", g.userId, baseId, "manage_share", legacyAllowed);
  if (!allowed) {
    throw new HttpError(403, g.access.visible ? "只有对本库有管理权限的角色可管理该库" : "无权访问该 Base");
  }
  return g;
}

/**
 * 硬规则 A：删除库只有超级管理员（管理权不含删库，故单独成守卫，别挂到 requireCanManageBase）。
 *
 * 接线语义取 conjunction（不是 authority）：引擎动作词汇里没有"删库"这一枚，借 "d" 作
 * 必要条件——删库必然包含删数据，故「引擎允许 d」是必要而非充分；若按 authority 放行，
 * 任何在数据上拿了 d 的人（编辑者、库管理员）都能删库，那是实打实的越权。
 * conjunction 只减不增：超级管理员（workspace owner 兜底）照删，其余一律仍由硬规则 A 拒。
 */
export async function requireCanDeleteBase(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  const legacyAllowed = g.access.visible && g.access.canDeleteLibrary;
  const allowed = await enforceBase(
    "requireCanDeleteBase", g.userId, baseId, "d", legacyAllowed, "conjunction",
  );
  if (!allowed) {
    throw new HttpError(403, g.access.visible ? "只有超级管理员可以删除库" : "无权访问该 Base");
  }
  return g;
}

/** 硬规则 C：开关某个库的「允许分享」——对该库有管理权者 + 超级管理员 + 管理员。 */
export async function requireCanToggleShare(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  const legacyAllowed = g.access.visible && g.access.canToggleShare;
  const allowed = await enforceBase("requireCanToggleShare", g.userId, baseId, "manage_share", legacyAllowed);
  if (!allowed) {
    throw new HttpError(
      403,
      g.access.visible
        ? "只有对本库有管理权限的角色、超级管理员或管理员可开关分享"
        : "无权访问该 Base",
    );
  }
  return g;
}

export async function requireCanComment(c: Context, baseId: string): Promise<BaseGuardResult> {
  const g = await loadBaseAccess(c, baseId);
  const legacyAllowed = g.access.visible && g.perm.canComment;
  const allowed = await enforceBase("requireCanComment", g.userId, baseId, "comment", legacyAllowed);
  if (!allowed) {
    throw new HttpError(403, g.access.visible ? "当前角色无权评论" : "无权访问该 Base");
  }
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
