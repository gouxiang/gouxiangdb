// apps/api/src/guards.ts
// 路由级权限守卫（RBAC）

import type { Context } from "hono";
import { prisma } from "./db.js";
import { getUserId, type Role } from "./auth.js";
import { permissionsForRole, type PermissionSet } from "@gx/shared-types";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
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

export async function requireRole(c: Context, baseId: string): Promise<Role> {
  const userId = await requireUserId(c);
  const role = await roleOf(userId, baseId);
  if (!role) throw new HttpError(403, "无权访问该 Base");
  return role;
}

export async function requireCanView(c: Context, baseId: string): Promise<{ userId: string; role: Role; perm: PermissionSet }> {
  const userId = await requireUserId(c);
  const role = await roleOf(userId, baseId);
  if (!role) throw new HttpError(403, "无权访问该 Base");
  return { userId, role, perm: permissionsForRole(role) };
}

export async function requireCanEditData(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const r = await requireCanView(c, baseId);
  if (!r.perm.canEditData) throw new HttpError(403, "当前角色无权编辑数据");
  return { userId: r.userId, role: r.role };
}

export async function requireCanManageSchema(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const r = await requireCanView(c, baseId);
  if (!r.perm.canManageSchema) throw new HttpError(403, "当前角色无权修改表结构");
  return { userId: r.userId, role: r.role };
}

export async function requireCanManageBase(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const r = await requireCanView(c, baseId);
  if (!r.perm.canManageBase) throw new HttpError(403, "只有所有者可管理 Base");
  return { userId: r.userId, role: r.role };
}

export async function requireCanComment(c: Context, baseId: string): Promise<{ userId: string; role: Role }> {
  const r = await requireCanView(c, baseId);
  if (!r.perm.canComment) throw new HttpError(403, "当前角色无权评论");
  return { userId: r.userId, role: r.role };
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
      { error: e.message, code: errorCodeForStatus(e.status) },
      e.status as 400 | 401 | 403 | 404 | 409,
    );
  }
  // eslint-disable-next-line no-console
  console.error("[api error]", e);
  // U-10：500 不回传内部错误消息（可能含 SQL/路径/堆栈信息），仅开发环境附带便于调试
  const isDev = process.env.NODE_ENV === "development";
  const msg = e instanceof Error ? e.message : String(e);
  return c.json(
    { error: "服务器内部错误", code: "INTERNAL", ...(isDev ? { message: msg } : {}) },
    500,
  );
}
