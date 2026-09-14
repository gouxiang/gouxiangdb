// apps/api/src/middleware/rateLimit.ts
// 单实例内存固定时间窗限流（ARCH §4.1 单实例硬约束，无需 Redis）。
// - 严格档：登录/注册/改密 /api/auth/(login|signup|change-password) 10 次/60 秒/键。
// - 兜底档：其余 /api/* 600 次/60 秒/键（宽松到正常使用不触发）。
// - 豁免：/healthz、/readyz、/api/health、/uploads（静态）、非 /api 的根路径。
// - 键：仅信任来自回环（Caddy 同机）的 X-Forwarded-For 首段，否则用 socket 对端地址。
// - 开关：GX_RATE_LIMIT=off 关闭；NODE_ENV=test 默认关闭（保测试稳定）。
// 超限 429 + Retry-After（距窗口重置秒数），周期清理过期键防内存增长。

import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { sourceIp } from "../utils/client-ip.js";
import { effectivePath } from "../utils/request-path.js";

export interface RateRule {
  match: (path: string, method: string) => boolean;
  limit: number;
  windowMs: number;
  name: string;
}

// 严格认证端点：路径以这些结尾即命中（兼容挂在 /api 下的真实路径）。
const STRICT_AUTH_PATTERNS = [
  /\/api\/auth\/login$/,
  /\/api\/auth\/signup$/,
  /\/api\/auth\/me\/change-password$/,
];

// M2 组织管理敏感写：邀请/激活/停用/重新激活收严到 30 次/60 秒（只增命名档，不动旧档）。
const ORG_ADMIN_PATTERNS = [
  /\/api\/v1\/org\/members\/invite$/,
  /\/api\/v1\/auth\/invite\/accept$/,
  /\/api\/v1\/org\/members\/[^/]+\/disable$/,
  /\/api\/v1\/org\/members\/[^/]+\/reactivate$/,
];

// 不计数的路径前缀/精确路径。
const EXEMPT_PATTERNS = [
  /^\/healthz\/?$/,
  /^\/readyz\/?$/,
  /^\/api\/health\/?$/,
  /^\/uploads\//,
];

export const STRICT_RULE: RateRule = {
  name: "auth",
  limit: 10,
  windowMs: 60_000,
  match: (path) => STRICT_AUTH_PATTERNS.some((re) => re.test(path)),
};

// M2 组织敏感动作档：30 次/60 秒（邀请/激活/停用/重新激活）。
export const ORG_ADMIN_RULE: RateRule = {
  name: "org-admin",
  limit: 30,
  windowMs: 60_000,
  match: (path) => ORG_ADMIN_PATTERNS.some((re) => re.test(path)),
};

export const DEFAULT_RULE: RateRule = {
  name: "api",
  limit: 600,
  windowMs: 60_000,
  match: (path) => path.startsWith("/api/"),
};

export function isExempt(path: string): boolean {
  return EXEMPT_PATTERNS.some((re) => re.test(path));
}

export function selectRule(path: string): RateRule | null {
  if (isExempt(path)) return null;
  // 最具体的先匹配：严格认证档 -> M2 组织敏感档 -> /api 兜底档。
  if (STRICT_RULE.match(path, "")) return STRICT_RULE;
  if (ORG_ADMIN_RULE.match(path, "")) return ORG_ADMIN_RULE;
  if (DEFAULT_RULE.match(path, "")) return DEFAULT_RULE;
  return null;
}

interface CounterEntry {
  count: number;
  resetAt: number;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSec: number;
}

// 纯计数存储（不碰请求对象），便于单测固定窗口与重置。
export class FixedWindowCounter {
  private readonly buckets = new Map<string, CounterEntry>();

  hit(key: string, rule: RateRule, now: number): RateDecision {
    const bucketKey = `${rule.name}:${key}`;
    const entry = this.buckets.get(bucketKey);
    if (!entry || now >= entry.resetAt) {
      const resetAt = now + rule.windowMs;
      this.buckets.set(bucketKey, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: rule.limit - 1,
        limit: rule.limit,
        retryAfterSec: Math.ceil(rule.windowMs / 1000),
      };
    }
    entry.count += 1;
    const remaining = Math.max(0, rule.limit - entry.count);
    if (entry.count > rule.limit) {
      return {
        allowed: false,
        remaining: 0,
        limit: rule.limit,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    return {
      allowed: true,
      remaining,
      limit: rule.limit,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  // 删除已过重置时间的桶（周期调用防内存增长）。
  prune(now: number): void {
    for (const [k, v] of this.buckets) {
      if (now >= v.resetAt) this.buckets.delete(k);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

// 限流键与审计来源 IP 共用同一判定（utils/client-ip.ts）。
export { sourceIp as clientKey, sourceIp } from "../utils/client-ip.js";

export interface RateLimiterDeps {
  enabled: () => boolean;
  now: () => number;
  counter: FixedWindowCounter;
}

export function createRateLimitMiddleware(deps: RateLimiterDeps): MiddlewareHandler {
  let lastPrune = deps.now();
  return async (c, next) => {
    if (!deps.enabled()) return next();
    // 去掉网关前缀再做规则匹配：带 /app/gouxiangdb 前缀的部署与根路径部署共享同一限流口径
    // （否则严格认证限流与 /api 兜底规则在网关后会静默失效）。
    const rule = selectRule(effectivePath(c));
    if (!rule) return next();

    const now = deps.now();
    if (now - lastPrune > 30_000) {
      deps.counter.prune(now);
      lastPrune = now;
    }
    const key = sourceIp(c);
    const decision = deps.counter.hit(key, rule, now);
    c.header("X-RateLimit-Limit", String(decision.limit));
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      return c.json(
        { error: "请求过于频繁，请稍后再试", code: "TOO_MANY_REQUESTS" },
        429,
      );
    }
    return next();
  };
}

// 进程级默认实例（单实例部署）。test 环境 config.rateLimitEnabled 默认 false。
export const rateLimitMiddleware: MiddlewareHandler = createRateLimitMiddleware({
  enabled: () => config.rateLimitEnabled,
  now: () => Date.now(),
  counter: new FixedWindowCounter(),
});
