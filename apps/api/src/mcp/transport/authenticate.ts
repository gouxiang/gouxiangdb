// M6/S2 MCP 边缘身份认证（Bearer PAT）。
//
// 权威依据：M6-implementation-plan §4.3（校验顺序）、§4.1（401 边缘口径）、§3-4（每请求重认证、无会话信任）。
//
// 校验顺序（全部失败一律表现为同一种 HTTP 401 + JSON-RPC -32001 id:null，仅内部 reason 区分以便测试快照）：
//   1) 无 Authorization / 非 "Bearer " -> unauthorized
//   2) 携带值无 gxpat_ 前缀 -> unauthorized（不查库，防枚举）
//   3) sha256 查不到 -> unauthorized（**对 dummy 摘要做一次等长 timingSafeEqual** 抹平时序）
//   4) revokedAt 非空 -> revoked
//   5) expiresAt 已过 -> expired
//   6) userId 对应用户非 ACTIVE -> account_disabled
// 成功 -> subject{userId, patId, scopes}，并按 patId 节流记 lastUsedAt（fire-and-forget）。
//
// 鉴权语义（P3 定稿）：**令牌只做「认证 + 有效期」**，能力一律按签发者用户实时计算
// （与 Web 端 X-GX-Token 会话同口径）。scopes 仍随 subject 带出仅供审计/老数据兼容，
// 任何授权判定都不再读它（注册层与工具层均已改为按 userId 走 M4 权限端口）。
//
// 未来 OAuth：仅在此函数留 "Bearer PAT 或 Bearer JWT" 分支扩展点（C-9：本期不预埋端点/表）。

import { findByTokenHash, isUserActive, touchLastUsed } from "../pat/patService.js";
import { dummyHashCompare, evaluateTokenState, hashToken, hasPatPrefix, parseScopes, type PatScope } from "../pat/tokens.js";

/** 认证失败原因（仅测试/审计可见；对客户端统一 401）。 */
export type McpAuthFailReason =
  | "missing_bearer" | "not_pat_prefix" | "unknown_token" | "revoked" | "expired" | "account_disabled";

export interface McpSubject {
  userId: string;
  patId: string;
  scopes: PatScope[];
}

export type McpAuthResult =
  | { ok: true; subject: McpSubject }
  | { ok: false; reason: McpAuthFailReason };

/** 从 Authorization 头取 Bearer 值（无/非 Bearer -> 空串）。 */
export function bearerValue(authorization: string | undefined): string {
  const raw = authorization ?? "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : "";
}

export interface AuthenticateOptions {
  /** 时间注入（假时钟测试）。 */
  now?: Date;
  /** 是否记 lastUsedAt（stdio 等场景可关；默认开，fire-and-forget 不阻塞）。 */
  recordUsage?: boolean;
}

/**
 * PAT 边缘认证。纯编排（查库委托 patService，判定委托 tokens 纯函数），无 HTTP 依赖，便于单测。
 */
export async function authenticatePat(
  authorization: string | undefined,
  opts: AuthenticateOptions = {},
): Promise<McpAuthResult> {
  const now = opts.now ?? new Date();
  const token = bearerValue(authorization);
  if (token === "") return { ok: false, reason: "missing_bearer" };
  if (!hasPatPrefix(token)) return { ok: false, reason: "not_pat_prefix" };

  const tokenHash = hashToken(token);
  const row = await findByTokenHash(tokenHash);
  if (!row) {
    dummyHashCompare(tokenHash); // 等长比较抹平时序（spike §3.5）
    return { ok: false, reason: "unknown_token" };
  }

  const state = evaluateTokenState({ revokedAt: row.revokedAt, expiresAt: row.expiresAt }, now);
  if (state === "revoked") return { ok: false, reason: "revoked" };
  if (state === "expired") return { ok: false, reason: "expired" };

  // C-4 纵深防御：即便 PAT 行未置 revokedAt，账号非 ACTIVE 也一律拒。
  if (!(await isUserActive(row.userId))) return { ok: false, reason: "account_disabled" };

  if (opts.recordUsage !== false) {
    void touchLastUsed(row.id, now); // 节流 60s，失败只告警，不影响认证结论
  }
  return { ok: true, subject: { userId: row.userId, patId: row.id, scopes: parseScopes(row.scopes) } };
}
