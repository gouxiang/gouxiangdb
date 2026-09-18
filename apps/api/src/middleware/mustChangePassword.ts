// 首次部署超级管理员「强制改密」闸门。
//
// 部署链路在迁移完成后用 init-admin 脚本创建首个超级管理员（ACTIVE 用户 + 系统 owner 授予），
// 该账号 users.mustChangePassword=true。若不在服务端拦截，"知道初始密码即可直接进系统改任何
// 东西"，初始密码在部署文档/镜像里是半公开的，等同于后门。故登录后对 **除白名单外的全部
// /api 请求** 一律 403 PASSWORD_CHANGE_REQUIRED，前端据此渲染改密页；改密成功后闸门解除
// （auth.ts 的 POST /api/auth/me/change-password 同写置 false 并失效 authStateCache）。
//
// 设计取舍：
//   - 未解析到身份（无令牌/坏令牌/停用/tv 不符）一律 next() 放行，401 交给各路由自己返回，
//     本中间件不重复造鉴权语义，也不对匿名请求泄漏"某账号处于待改密"这一事实。
//   - 白名单用 effectivePath(c)（剥 config.basePath 后的逻辑路径）+ method 精确判定，
//     不用宽泛正则/前缀，避免顺带放过 /api/auth/me/avatar 之类相邻路径。
//   - 必须在业务路由之前挂载（app.ts），否则路由已执行完再拦没有意义。

import type { Context, MiddlewareHandler, Next } from "hono";
import { resolveActiveAuth } from "../domain/org/authState.js";
import { effectivePath } from "../utils/request-path.js";

/** 前端据 body.code 判定渲染改密页的机器码（与 401/403 其它语义区分）。 */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

// 闸门白名单：{ method, path } 精确对（method 为 "*" 表示该路径全方法放行）。
const ALLOWLIST: ReadonlyArray<{ method: string; path: string }> = [
  // 前端靠它拿到 mustChangePassword 才能渲染改密页。
  { method: "GET", path: "/api/auth/me" },
  // 解除闸门的唯一出口。
  { method: "POST", path: "/api/auth/me/change-password" },
  // 登录本身不能拦，否则持初始密码也登不进去。
  { method: "*", path: "/api/auth/login" },
  // 健康检查（部署探活/负载探针）不鉴权，不受闸门影响。
  { method: "*", path: "/api/health" },
];

function isAllowed(c: Context): boolean {
  const path = effectivePath(c);
  if (!path.startsWith("/api/")) return true;
  const method = c.req.method;
  return ALLOWLIST.some((e) => e.path === path && (e.method === "*" || e.method === method));
}

async function gate(c: Context, next: Next): Promise<Response | void> {
  const resolved = await resolveActiveAuth(c);
  if (!resolved) return next();
  if (!resolved.mustChangePassword) return next();
  if (isAllowed(c)) return next();
  return c.json({ error: "请先修改初始密码", code: PASSWORD_CHANGE_REQUIRED }, 403);
}

export const mustChangePasswordMiddleware: MiddlewareHandler = (c, next) => gate(c, next);
