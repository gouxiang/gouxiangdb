// M2/S2 v1 鉴权中间件：登录且账号 ACTIVE/tv 匹配才放行（requireActiveUser），
// 组织管理动作鉴权 requireOrgAction 本片仅骨架（三枚动作的真正求值在 S5/S6 接 effectiveOrgRoles）。
//
// 与旧 /api 的关系：旧路由继续用 auth.getUserId（内部已与本中间件共享 resolveActiveAuth 核心），
// 签名/行为对 ACTIVE 用户等价；v1 额外在失败时直接以统一 {error,code} 信封拒绝。

import type { Context, Next } from "hono";
import { resolveActiveAuth, type ResolvedAuth } from "../domain/org/authState.js";
import { hasOrgAction, ORG_ACTIONS, type OrgActionString } from "../domain/org/authorization.js";
import { HttpError } from "../guards.js";

export type OrgAction = OrgActionString;

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
 * 组织管理动作鉴权：经 effectiveRoleRows 判定当前用户的有效组织角色（直接授予 ∪ 活部门
 * 祖先闭包上的部门授予）中是否有角色持有该动作；不足抛 403。
 * 必须挂在 requireActiveUser 之后（c.var.auth 已设置）。动作白名单非法直接视为服务端接线错误。
 */
export function requireOrgAction(action: OrgAction) {
  if (!ORG_ACTIONS.includes(action)) {
    throw new Error(`未知组织管理动作: ${action}`);
  }
  return async (c: Context, next: Next): Promise<void | Response> => {
    const resolved = c.get("auth");
    if (!resolved) throw new HttpError(401, "未登录或登录态已失效");
    const allowed = await hasOrgAction(resolved.userId, action);
    if (!allowed) throw new HttpError(403, "无执行该组织管理操作的权限");
    return next();
  };
}
