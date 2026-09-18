// M2/S2 鉴权共享核心：JWT 签发（带 tv claim）+ 验签后的用户状态解析（status/tokenVersion）。
//
// 旧 /api 的 auth.getUserId 与新 /api/v1 的 requireActiveUser 都复用本模块，保证两条链
// 对 ACTIVE 用户判定一致、对停用/版本不符同样拒绝。默认零缓存（GX_AUTH_STATE_TTL_MS=0）：
// 每次解析按主键点查 users 一行，严格满足"停用后下一次请求即 401"。
//
// 本模块只依赖 config/db 与无依赖的 authStateCache，不反向依赖 auth.ts/guards.ts，避免环。

import { sign, verify } from "hono/jwt";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { createAuthStateCache } from "./authStateCache.js";

const JWT_SECRET = config.jwtSecret;

// token 有效期 7 天（秒），与升级前一致（M2 不改 TTL）。
export const TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

// 账号生命周期状态（与 users.status 对齐）
export const USER_STATUS = { INVITED: "INVITED", ACTIVE: "ACTIVE", DISABLED: "DISABLED" } as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export interface ResolvedAuth {
  userId: string;
  status: string;
  tokenVersion: number;
  workspaceId: string | null;
  // 首次部署超级管理员强制改密标记（users.mustChangePassword）；改密成功后置 false。
  mustChangePassword: boolean;
}

interface BearerHeader {
  req: { header: (k: string) => string | undefined };
}

// 鉴权用户状态缓存：仅 GX_AUTH_STATE_TTL_MS>0 时真正读写；TTL=0 时 resolve 完全旁路它。
const authStateCache = createAuthStateCache();

/** 供停用/激活等写路径在同进程事务后主动失效（开短缓存时也能下一次请求即 401）。 */
export function invalidateAuthState(userId: string): void {
  authStateCache.invalidate(userId);
}

/** 签发 JWT。payload 携带 tv（用户 tokenVersion）；新注册/登录 tv 取自 users 行（默认 0）。 */
export function issueToken(userId: string, tokenVersion = 0): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ userId, tv: tokenVersion, iat: now, exp: now + TOKEN_TTL_SEC }, JWT_SECRET, "HS256");
}

/**
 * 取请求中的 JWT：优先标准 `Authorization: Bearer <jwt>`，其次自定义头 `X-GX-Token`。
 *
 * 为什么需要 X-GX-Token：飞牛 fnOS 的第三方应用 CGI 网关（/usr/trim/bin/trim_http_cgi）
 * 会把请求里的 `Authorization` 头当作**它自己的 fnOS 令牌**校验，非 fnOS 令牌一律返回
 * `200 invalid token` 并把请求吞掉（2026-09-18 在 fnOS 1.2.0604 实测：signup 无该头可穿过，
 * 登录后所有带 Bearer 的 XHR 全被拦，界面永久 loading）。因此 Web 端改用 X-GX-Token 携带同一 JWT
 * 绕开该校验；MCP/PAT 等外部客户端仍可用 Authorization（保留向后兼容）。
 */
function readBearerToken(c: BearerHeader): string {
  const authHeader = c.req.header("Authorization") ?? "";
  const fromAuth = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (fromAuth) return fromAuth;
  const gx = (c.req.header("X-GX-Token") ?? "").trim();
  return gx.startsWith("Bearer ") ? gx.slice(7).trim() : gx;
}

/**
 * 鉴权共享解析核心：
 *   1) 取 Bearer token；2) 验签 HS256，无 tv claim 视为 tv=0（平滑升级，不踢存量登录）；
 *   3) 按 PK 查 users（status/tokenVersion/workspaceId/mustChangePassword），TTL>0 时先走有界缓存；
 *   4) 用户不存在 / status 非 ACTIVE（DISABLED 或 INVITED）/ tv 不匹配 -> null。
 * 不向调用方区分失败原因（端点侧统一 401）。
 */
export async function resolveActiveAuth(c: BearerHeader): Promise<ResolvedAuth | null> {
  const token = readBearerToken(c);
  if (!token) return null;

  let payloadUserId: string;
  let payloadTv = 0;
  try {
    const payload = await verify(token, JWT_SECRET, "HS256");
    if (typeof payload.userId !== "string") return null;
    payloadUserId = payload.userId;
    // 存量 7 天 token 无 tv claim：按 0 处理，与 users.tokenVersion 默认 0 相等即通过。
    payloadTv = typeof payload.tv === "number" ? payload.tv : 0;
  } catch {
    return null;
  }

  const ttl = config.authStateTtlMs;
  if (ttl > 0) {
    const cached = authStateCache.get(payloadUserId);
    if (cached && cached.tokenVersion === payloadTv && cached.status === USER_STATUS.ACTIVE) {
      return { ...cached };
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: payloadUserId },
    select: { id: true, status: true, tokenVersion: true, workspaceId: true, mustChangePassword: true },
  });
  if (!user) return null;
  if (user.status !== USER_STATUS.ACTIVE) return null;
  if (user.tokenVersion !== payloadTv) return null;

  const resolved: ResolvedAuth = {
    userId: user.id,
    status: user.status,
    tokenVersion: user.tokenVersion,
    workspaceId: user.workspaceId,
    mustChangePassword: user.mustChangePassword,
  };
  if (ttl > 0) authStateCache.set(resolved, ttl);
  return resolved;
}
