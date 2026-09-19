// M6-FE PAT 展示纯映射（无 IO、无 React）：scope 中文标签、有效期选项、令牌状态判定、
// 错误码中性文案、一次性弹窗警示语。全部可表驱动单测。
//
// 依据：M6-implementation-plan §8（M6-FE 输入清单）、C-2（scope 六位）、C-3（有效期 30/90/365/null、前缀 14）；
// 后端契约见 apps/api/src/mcp/pat/tokens.ts + routes/v1/pats.ts。
//
// P3：scope 六位【降级为库内历史字段】——鉴权不再读它（能力按签发者账号实时计算）。
// 下面的标签/顺序映射保留：令牌响应仍带 scopes（老数据兼容），这些映射是它的只读词典，
// 但界面已不再用它做权限说明（唯一口径是 PAT_SCOPE_INHERIT_*）。
import type { PatScope } from "../../api/client";

/** scope 分组标题（数据表 / 文档 / 画布）。 */
export const PAT_SCOPE_GROUPS = ["数据表", "文档", "画布"] as const;
export type PatScopeGroup = (typeof PAT_SCOPE_GROUPS)[number];

export interface PatScopeMeta {
  value: PatScope;
  /** 中文可读标签（面向普通用户，不出现 scope 原文）。 */
  label: string;
  group: PatScopeGroup;
}

/** 六位 scope 的中文标签，保持后端 PAT_SCOPES 顺序。 */
export const PAT_SCOPE_META: readonly PatScopeMeta[] = [
  { value: "record:read", label: "读取数据表", group: "数据表" },
  { value: "record:write", label: "写入数据表", group: "数据表" },
  { value: "doc:read", label: "读取文档", group: "文档" },
  { value: "doc:write", label: "写入文档", group: "文档" },
  { value: "canvas:read", label: "读取画布", group: "画布" },
  { value: "canvas:write", label: "写入画布", group: "画布" },
];

const SCOPE_LABEL = new Map<PatScope, string>(PAT_SCOPE_META.map((m) => [m.value, m.label]));

/** scope → 中文标签；未知 scope 原样回落（后端若增位也不至于渲染空白）。 */
export function scopeLabel(scope: PatScope | string): string {
  return SCOPE_LABEL.get(scope as PatScope) ?? String(scope);
}

/** 默认勾选：仅三个只读档（含 canvas:read）；三个写入档默认不勾（C-2 最小权限）。 */
export const DEFAULT_READ_SCOPES: readonly PatScope[] = [
  "record:read",
  "doc:read",
  "canvas:read",
];

/** 按 PAT_SCOPE_META 固定顺序整理 scope 去重集（提交前归一，避免 UI 勾选顺序影响入参）。 */
export function orderScopes(scopes: readonly PatScope[]): PatScope[] {
  const set = new Set(scopes);
  return PAT_SCOPE_META.map((m) => m.value).filter((v) => set.has(v));
}

export type PatExpiryDays = 30 | 90 | 365 | null;

/** 有效期下拉值（Select 只能字符串，never 为哨兵）。 */
export const EXPIRY_NEVER = "never" as const;

export interface PatExpiryOption {
  value: string;
  label: string;
  days: PatExpiryDays;
}

/** 有效期选项；默认 90 天（C-3）。 */
export const PAT_EXPIRY_OPTIONS: readonly PatExpiryOption[] = [
  { value: "30", label: "30 天", days: 30 },
  { value: "90", label: "90 天", days: 90 },
  { value: "365", label: "365 天", days: 365 },
  { value: EXPIRY_NEVER, label: "永不过期", days: null },
];

/** 默认有效期（C-3）：90 天。 */
export const PAT_DEFAULT_EXPIRY_VALUE = "90";

/** 下拉值 → 天数（null = 永不过期）；未知值回落默认 90。 */
export function parseExpiryValue(value: string): PatExpiryDays {
  const opt = PAT_EXPIRY_OPTIONS.find((o) => o.value === value);
  return opt ? opt.days : 90;
}

/** 选「永不过期」必须二次强警示确认（C-3）。 */
export function requiresNeverExpiryConfirm(days: PatExpiryDays): boolean {
  return days === null;
}

/**
 * P3 权限继承说明：令牌只做「认证 + 有效期」，能力一律按签发者账号实时计算
 * （与 Web 端 X-GX-Token 会话同口径）。这两句是界面上唯一允许出现的"权限"表述，
 * 取代原先的六位 scope 勾选与列表徽标——那些控件在新语义下点了不改变任何实际能力。
 */
export const PAT_SCOPE_INHERIT_TITLE = "权限跟随签发者账号";
export const PAT_SCOPE_INHERIT_HINT =
  "令牌不再单独设置权限范围：它能做什么，等于签发它的这个账号当下能做什么（与网页端登录会话同口径）。账号权限被调整、或令牌被吊销/到期，即刻生效。";

/**
 * 提交前校验：名称 1–60 字符（后端上限 60）。
 * 语义变更（P3）：原"至少一个 scope"条件随勾选区一并下线——权限由签发者账号决定，
 * 用户在表单里选什么都不会改变能力，留着只会造成"选了才让提交"的假约束。
 */
export function canSubmitCreate(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 60;
}

export type PatTokenState = "active" | "expired" | "revoked";

export const PAT_STATE_LABEL: Record<PatTokenState, string> = {
  active: "有效",
  expired: "已过期",
  revoked: "已吊销",
};

/** 令牌状态（吊销优先于过期，与后端 evaluateTokenState 同序）。 */
export function patTokenState(
  pat: { revokedAt: string | null; expiresAt: string | null },
  now: number = Date.now(),
): PatTokenState {
  if (pat.revokedAt) return "revoked";
  if (pat.expiresAt && new Date(pat.expiresAt).getTime() <= now) return "expired";
  return "active";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 通用时间展示（null → 破折号）。 */
export function fmtPatTime(iso: string | null): string {
  return iso ? fmtDate(iso) : "—";
}

/** 过期列可读文案（永不过期 / 具体到期时间，过期则标注）。 */
export function patExpiryLabel(expiresAt: string | null, now: number = Date.now()): string {
  if (!expiresAt) return "永不过期";
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return expiresAt;
  return t <= now ? `已于 ${fmtDate(expiresAt)} 过期` : fmtDate(expiresAt);
}

/** 已吊销行不可再吊销。 */
export function canRevoke(pat: { revokedAt: string | null }): boolean {
  return !pat.revokedAt;
}

/** 归一后的错误输入（由 pat-hooks 从 ApiError 提取）。 */
export interface PatErrorInfo {
  status: number;
  code: string | null;
  /** 后端中文 message（error 字段）。 */
  message: string | null;
  retryAfterSec?: number | null;
}

/**
 * 错误 → 用户可读中文：
 *  - 429/限流：尊重 Retry-After，提示退避秒数（绝不自动重试，防重试风暴）；
 *  - 404：令牌不存在或已被吊销（后端不泄漏存在性，前端也中性化）；
 *  - 400：直接采用后端中文校验消息（PAT_NAME_INVALID / PAT_SCOPE_INVALID / PAT_EXPIRY_INVALID）；
 *  - 403：环境未开放（MCP 门控 fail-closed）。
 */
export function patErrorText(e: PatErrorInfo, fallback = "操作失败，请稍后重试"): string {
  const { status, code, message } = e;
  if (status === 429 || code === "MCP_RATE_LIMITED") {
    const s = e.retryAfterSec ?? null;
    return s && s > 0 ? `操作过于频繁，请 ${s} 秒后重试` : "操作过于频繁，请稍后重试";
  }
  if (status === 404 || code === "PAT_NOT_FOUND") {
    return message ?? "令牌不存在或已被吊销";
  }
  if (status === 403) return "当前环境未开放此功能";
  if (status === 400) return message ?? "请求有误，请检查填写内容";
  return message ?? fallback;
}

/** 一次性明文弹窗强提示（关闭即焚）。 */
export const TOKEN_ONCE_WARNING =
  "为安全起见，完整令牌仅在此处显示一次，关闭后将无法再次查看。请立即复制并妥善保存。";

/** 永不过期强警示文案。 */
export const NEVER_EXPIRY_WARNING =
  "永不过期的令牌一旦泄露将长期有效、无法自动失效。除非确有必要，建议改为选择固定的有效期。";

/** 吊销二次确认文案。 */
export const REVOKE_WARNING =
  "吊销后，正在使用该令牌的客户端会立即失去访问权限，且无法恢复。如仍需使用，请重新签发新令牌。";
