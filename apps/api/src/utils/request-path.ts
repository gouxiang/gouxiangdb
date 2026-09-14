// apps/api/src/utils/request-path.ts
// 网关前缀感知的"有效路径"。
//
// 飞牛 fnOS 网关经 unix socket 转发时请求仍带 config.basePath 前缀
// （如 /app/gouxiangdb/api/auth/login），而 Hono 挂载（app.route(basePath, mount)）
// 不会改写 c.req.path——安全中间件拿到的仍是全路径。直接用 c.req.path 会让
// 基于路径的安全规则（严格认证限流、头像上传放宽 body 上限）在带前缀部署下静默失效。
// 本工具把已知前缀剥掉，得到与根路径部署逐字节一致的逻辑路径：
//   /app/gouxiangdb/api/auth/login → /api/auth/login
//   /api/auth/login                → /api/auth/login
// 未配置前缀或路径不带前缀时原样返回（裸机/Docker 零行为变化）。

import type { Context } from "hono";
import { config } from "../config.js";

export function stripBasePath(fullPath: string): string {
  const p = config.basePath;
  if (p && fullPath === p) return "/";
  if (p && fullPath.startsWith(`${p}/`)) return fullPath.slice(p.length) || "/";
  return fullPath;
}

/** 去掉网关前缀后的请求路径，供安全/路由判定使用。 */
export function effectivePath(c: Context): string {
  return stripBasePath(c.req.path);
}
