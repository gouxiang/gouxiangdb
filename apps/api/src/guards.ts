// apps/api/src/guards.ts
// 路由级权限守卫（RBAC）

import type { Context } from "hono";
import { prisma } from "./db.js";
import { getUserId, type Role } from "./auth.js";
import { permissionsForRole, type PermissionSet, type ResourceAction } from "@gx/shared-types";
import { authzShadowActive } from "./configAuthz.js";
import { runShadowCheck } from "./domain/authz/adapter.js";

export class HttpError extends Error {
  /** 可选机器可读错误码（不传时按状态码回落 BAD_REQUEST/CONFLICT 等）。 */
  code?: string;
  constructor(public status: number, message: string, code?: string) {
    super(message);
    if (code) this.code = code;
  }
}

export async function requireUserId(c: Context): Promise<string> {
  const userId = await getUserId(c);
  if (!userId) throw new HttpError(401, "未登录");
  return userId;
}

/** tableId → baseId */
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

export async function roleOf(userId: string, baseId: string): Promise<Role | undefined> {
  const m = await prisma.member.findUnique({
    where: { baseId_userId: { baseId, userId } },
    select: { role: true },
  });
  return m?.role as Role | undefined;
}

export async function permissionsOf(userId: string, baseId: string): Promise<PermissionSet> {
  const role = await roleOf(userId, baseId);
  if (!role) {
    return { canManageBase: false, canManageSchema: false, canEditData: false, canComment: false, canView: false };
  }
  return permissionsForRole(role);
}

const DENY_PERM: PermissionSet = {
  canManageBase: false,
  canManageSchema: false,
  canEditData: false,
  canComment: false,
  canView: false,
};

/**
 * M4/S3 shadow 对拍缝：仅在 GX_AUTHZ_ENGINE 生效为 shadow 时跑引擎同上下文对拍。
 * off 时 authzShadowActive()=false，本函数空操作，不实例化引擎、零新增 SQL。
 * 旧守卫一律以自身旧逻辑结果为准；对拍只分类计数/脱敏日志，绝不改返回、不抛错。
 * 动作映射：view=r / editData=u（旧 canEditData 同闸 c/u/d，投影 editor 同集，u 作编辑哨兵）/
 * schema=manage_schema / manageBase=manage_share / comment=comment，均落 base 节点（成员权限本就 base 级）。
 */
async function shadowBase(
  guard: string,
  userId: string,
  baseId: string,
  action: ResourceAction,
  oldAllowed: boolean,
): Promise<void> {
  if (!authzShadowActive()) return;
  await runShadowCheck(guard, userId, { resourceType: "base", resourceId: baseId }, action, oldAllowed);
}

/** 加载 base 成员视图（不做 shadow 对拍，供公开守卫在落定旧决策后统一对拍一次）。401 未登录直接抛。 */
async function loadBaseMember(
  c: Context,
  baseId: string,
): Promise<{ userId: string; role: Role | null; perm: PermissionSet }> {
  const userId = await requireUserId(c);
  const role = await roleOf(userId, baseId);
  if (!role) return { userId, role: null, perm: DENY_PERM };
  return { userId, role, perm: permissionsForRole(role) };
}

export async function requireRole(c: Context, baseId: string): Promise<Role> {
  const userId = await requireUserId(c);
  const role = await roleOf(userId, baseId);
  if (!role) throw new HttpError(403, "无权访问该 Base");
  return role;
}

export async function requireCanView(c: Context, baseId: string): Promise<{ userId: string; role: Role; perm: PermissionSet }> {
  const m = await loadBaseMember(c, baseId);
  if (!m.role) {
    await shadowBase("requireCanView", m.userId, baseId, "r", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  await shadowBase("requireCanView", m.userId, baseId, "r", true);
  return { userId: m.userId, role: m.role, perm: m.perm };
}

export async function requireCanEditData(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const m = await loadBaseMember(c, baseId);
  if (!m.role) {
    await shadowBase("requireCanEditData", m.userId, baseId, "u", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!m.perm.canEditData) {
    await shadowBase("requireCanEditData", m.userId, baseId, "u", false);
    throw new HttpError(403, "当前角色无权编辑数据");
  }
  await shadowBase("requireCanEditData", m.userId, baseId, "u", true);
  return { userId: m.userId, role: m.role };
}

export async function requireCanManageSchema(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const m = await loadBaseMember(c, baseId);
  if (!m.role) {
    await shadowBase("requireCanManageSchema", m.userId, baseId, "manage_schema", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!m.perm.canManageSchema) {
    await shadowBase("requireCanManageSchema", m.userId, baseId, "manage_schema", false);
    throw new HttpError(403, "当前角色无权修改表结构");
  }
  await shadowBase("requireCanManageSchema", m.userId, baseId, "manage_schema", true);
  return { userId: m.userId, role: m.role };
}

export async function requireCanManageBase(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const m = await loadBaseMember(c, baseId);
  if (!m.role) {
    await shadowBase("requireCanManageBase", m.userId, baseId, "manage_share", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!m.perm.canManageBase) {
    await shadowBase("requireCanManageBase", m.userId, baseId, "manage_share", false);
    throw new HttpError(403, "只有所有者可管理 Base");
  }
  await shadowBase("requireCanManageBase", m.userId, baseId, "manage_share", true);
  return { userId: m.userId, role: m.role };
}

export async function requireCanComment(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const m = await loadBaseMember(c, baseId);
  if (!m.role) {
    await shadowBase("requireCanComment", m.userId, baseId, "comment", false);
    throw new HttpError(403, "无权访问该 Base");
  }
  if (!m.perm.canComment) {
    await shadowBase("requireCanComment", m.userId, baseId, "comment", false);
    throw new HttpError(403, "当前角色无权评论");
  }
  await shadowBase("requireCanComment", m.userId, baseId, "comment", true);
  return { userId: m.userId, role: m.role };
}

/** 状态码 → 机器可读错误码（仅增补字段，不改变 HTTP 状态码与中文 error 文案）。 */
function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "UNAUTHORIZED";
    case 403: return "FORBIDDEN";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    case 413: return "PAYLOAD_TOO_LARGE";
    case 429: return "TOO_MANY_REQUESTS";
    default: return `HTTP_${status}`;
  }
}

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
