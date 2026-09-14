// M2/S2 v1 鉴权中间件：登录且账号 ACTIVE/tv 匹配才放行（requireActiveUser），
// 组织管理动作鉴权 requireOrgAction 本片仅骨架（三枚动作的真正求值在 S5/S6 接 effectiveOrgRoles）。
//
// 与旧 /api 的关系：旧路由继续用 auth.getUserId（内部已与本中间件共享 resolveActiveAuth 核心），
// 签名/行为对 ACTIVE 用户等价；v1 额外在失败时直接以统一 {error,code} 信封拒绝。

import type { Context, Next } from "hono";
import { resolveActiveAuth, type ResolvedAuth } from "../domain/org/authState.js";
import { HttpError } from "../guards.js";

export type OrgAction = "manage_departments" | "manage_members" | "manage_roles";

declare module "hono" {
  interface ContextVariableMap {
    auth: ResolvedAuth;
  }
}

/** v1 必需登录且账号可用：失败抛 401（由 errorResponse 统一成 {error,code:UNAUTHORIZED}）。 */
export async function requireActiveUser(c: Context, next: Next): Promise<void | Response> {
  const resolved = await resolveActiveAuth(c);
  if (!resolved) throw new HttpError(401, "未登录或登录态已失效");
  c.set("auth", resolved);
  return next();
}

/**
 * 组织管理动作鉴权（S2 骨架）。
 * S5 接入 effectiveOrgRoles 前，本片没有任何写端点挂它；保留中间件工厂与动作白名单校验，
 * 以便 S3/S5 直接 `app.post(..., requireOrgAction("manage_departments"), handler)`。
 * 真正判定逻辑在 S5 用 hasOrgAction(c.var.auth.userId, action) 填充（当前先要求已登录）。
 */
export function requireOrgAction(action: OrgAction) {
  const allowed: OrgAction[] = ["manage_departments", "manage_members", "manage_roles"];
  if (!allowed.includes(action)) {
    throw new Error(`未知组织管理动作: ${action}`);
  }
  return async (c: Context, next: Next): Promise<void | Response> => {
    // S2：仅确认是活跃登录用户；动作位判定在 S5 落地（此处不临时放开/硬编码 owner）。
    const resolved = c.get("auth");
    if (!resolved) throw new HttpError(401, "未登录或登录态已失效");
    // TODO(M2-S5): resolved.userId -> hasOrgAction(userId, action)，不足抛 403。
    void action;
    return next();
  };
}
