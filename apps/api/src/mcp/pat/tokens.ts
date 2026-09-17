// M6/S1 PAT 原语（生成 / hash / 常量时间比对 / scope 解析校验 / 过期计算）。
//
// 纯函数 + node:crypto，零 IO、零 db 依赖（可表驱动单测）。
// 权威依据：M6-implementation-plan §4.3（数据模型与校验顺序）、§5.2（REST 与 scope 六位）、
//           C-2（scope 六位含 canvas:write）、C-3（默认 90 天 / 30-90-365 / null；前缀不可认证）。
//
// 密钥纪律：明文只在创建响应返回一次；库存 sha256(明文)；tokenPrefix 仅明文前 14 字符（不可认证）。

import crypto from "node:crypto";

/** 明文固定前缀（认证边缘据此快速分流：非此前缀直接 401，不查库）。 */
export const PAT_PREFIX = "gxpat_";
/** 随机段字节数（base64url 后 32 字符，熵 192 bit）。 */
export const PAT_RANDOM_BYTES = 24;
/** 列表辨识用前缀长度：`gxpat_`（6）+ 8 随机字符 = 14；暴露 8 字符不足以猜中 32 字符随机段（C-3）。 */
export const PAT_PREFIX_DISPLAY_LEN = 14;

/** scope 六位单一真源（C-2 定稿；与 M4 RESOURCE_ACTIONS 命名空间刻意分离，不混用）。 */
export const PAT_SCOPES = [
  "record:read", "record:write",
  "doc:read", "doc:write",
  "canvas:read", "canvas:write",
] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

/** 有效期可选天数（C-3）；null 语义 = 永不过期，由调用方显式传入。 */
export const PAT_EXPIRY_DAYS = [30, 90, 365] as const;
/** 未携带 expiresInDays 时的默认有效期（C-3 定稿：默认 90 天）。 */
export const PAT_DEFAULT_EXPIRY_DAYS = 90;

const DAY_MS = 86_400_000;

/** 校验失败（路由映射：PAT_SCOPE_INVALID / PAT_NAME_INVALID / PAT_EXPIRY_INVALID -> 400）。 */
export class PatValidationError extends Error {
  constructor(public code: "PAT_SCOPE_INVALID" | "PAT_NAME_INVALID" | "PAT_EXPIRY_INVALID", message: string) {
    super(message);
    this.name = "PatValidationError";
  }
}

export interface GeneratedToken {
  /** 完整明文（仅创建响应返回一次，绝不入库/入日志）。 */
  token: string;
  /** 明文前 14 字符，列表辨识用。 */
  tokenPrefix: string;
  /** sha256(明文) hex。 */
  tokenHash: string;
}

/** sha256(明文) hex —— 与库内 tokenHash 等值查同口径。 */
export function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

/** 生成一枚 PAT：`gxpat_` + 24 字节随机 base64url。 */
export function generateToken(): GeneratedToken {
  const secret = crypto.randomBytes(PAT_RANDOM_BYTES).toString("base64url");
  const token = `${PAT_PREFIX}${secret}`;
  return { token, tokenPrefix: token.slice(0, PAT_PREFIX_DISPLAY_LEN), tokenHash: hashToken(token) };
}

/** 是否带 PAT 前缀（认证边缘分流用；非此前缀不查库）。 */
export function hasPatPrefix(raw: string): boolean {
  return raw.startsWith(PAT_PREFIX);
}

/**
 * 常量时间比较两个 hex 摘要。
 * 长度不等直接 false（长度本身非秘密：sha256 hex 恒 64）；等长走 crypto.timingSafeEqual。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 恒定的 dummy 摘要（进程内随机生成一次）：查不到 token 行时对等长比较，抵消时序侧信道。 */
export const DUMMY_TOKEN_HASH = hashToken(`gxpat_dummy_${crypto.randomBytes(16).toString("hex")}`);

/**
 * hash 查不到时的统一回落：对 dummy 摘要做一次等长 timingSafeEqual（成本忽略），
 * 返回 false。「hash 不存在」与「前缀不携带 PAT 前缀」在**响应口径**上同为 401（见 §4.3 校验顺序），
 * 本函数只抹平时序差异。
 */
export function dummyHashCompare(candidateHash: string): false {
  timingSafeEqualHex(candidateHash, DUMMY_TOKEN_HASH);
  return false;
}

export function isPatScope(v: unknown): v is PatScope {
  return typeof v === "string" && (PAT_SCOPES as readonly string[]).includes(v);
}

/** scope 数组校验：非空、全部合法、去重；保持入参顺序。 */
export function validateScopes(input: unknown): PatScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new PatValidationError("PAT_SCOPE_INVALID", "scopes 必须为非空的六位 scope 子集");
  }
  const out: PatScope[] = [];
  for (const s of input) {
    if (!isPatScope(s)) throw new PatValidationError("PAT_SCOPE_INVALID", `未知 scope: ${String(s)}`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** 名称校验：trim 后非空且 ≤60 字符。 */
export function validateName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (name.length === 0) throw new PatValidationError("PAT_NAME_INVALID", "名称为必填项");
  if (name.length > 60) throw new PatValidationError("PAT_NAME_INVALID", "名称不超过 60 字符");
  return name;
}

/**
 * 过期时间计算（C-3）：30/90/365 -> now + N 天；**null -> null（永不过期）**；其它 -> 抛错。
 * 未携带该字段的默认值（90 天）由调用方在路由层补，故此处不接受 undefined。
 */
export function expiresAtFromDays(days: 30 | 90 | 365 | null, now: Date): Date | null {
  if (days === null) return null;
  if (typeof days !== "number" || !(PAT_EXPIRY_DAYS as readonly number[]).includes(days)) {
    throw new PatValidationError("PAT_EXPIRY_INVALID", "有效期仅支持 30 / 90 / 365 天或 null（永不过期）");
  }
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * 有效期取值校验（路由层用，产出精确错误码）：30/90/365 -> 原值；**null -> null（永不过期）**；
 * 其它（含 undefined/字符串/0/7/400）-> PAT_EXPIRY_INVALID。
 * 缺省（未携带 expiresInDays 键）由调用方补 PAT_DEFAULT_EXPIRY_DAYS，不走本函数。
 */
export function validateExpiry(input: unknown): 30 | 90 | 365 | null {
  if (input === null) return null;
  if (typeof input === "number" && (PAT_EXPIRY_DAYS as readonly number[]).includes(input)) {
    return input as 30 | 90 | 365;
  }
  throw new PatValidationError("PAT_EXPIRY_INVALID", "有效期仅支持 30 / 90 / 365 天或 null（永不过期）");
}

/** scopes 的 JSON 串（入库形态）与解析（出参形态）。 */
export function serializeScopes(scopes: readonly PatScope[]): string {
  return JSON.stringify(scopes);
}
export function parseScopes(stored: string): PatScope[] {
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPatScope) : [];
  } catch {
    return [];
  }
}

/**
 * 认证判定（S2 边缘与 stdio 共用；纯函数，时间可注入）。
 * 顺序固定（§4.3）：revoked -> expired -> 其余交由调用方判（用户 status）。
 * @returns "ok" | "revoked" | "expired"
 */
export function evaluateTokenState(
  row: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date,
): "ok" | "revoked" | "expired" {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ok";
}
