// apps/api/src/middleware/__tests__/rateLimit.test.ts
// 内存固定窗限流：纯计数窗口/重置 + 中间件第 11 次 429 + Retry-After + 豁免 + test 关闭。

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_RULE,
  FixedWindowCounter,
  STRICT_RULE,
  clientKey,
  createRateLimitMiddleware,
  isExempt,
  selectRule,
} from "../rateLimit.js";

describe("规则选择", () => {
  it("认证端点命中严格档", () => {
    expect(selectRule("/api/auth/login")).toBe(STRICT_RULE);
    expect(selectRule("/api/auth/signup")).toBe(STRICT_RULE);
    expect(selectRule("/api/auth/me/change-password")).toBe(STRICT_RULE);
  });
  it("其余 /api 走兜底档", () => {
    expect(selectRule("/api/records")).toBe(DEFAULT_RULE);
  });
  it("健康/上传路径豁免", () => {
    for (const p of ["/healthz", "/readyz", "/api/health", "/uploads/avatars/x.png"]) {
      expect(isExempt(p)).toBe(true);
      expect(selectRule(p)).toBeNull();
    }
  });
});

describe("FixedWindowCounter 纯计数", () => {
  it("严格档前 10 次放行，第 11 次拒绝，窗口重置后恢复", () => {
    const ctr = new FixedWindowCounter();
    const t0 = 1_000_000;
    for (let i = 1; i <= 10; i += 1) {
      const d = ctr.hit("k", STRICT_RULE, t0);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(10 - i);
    }
    const blocked = ctr.hit("k", STRICT_RULE, t0 + 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);

    // 越过窗口重置时间
    const reset = ctr.hit("k", STRICT_RULE, t0 + STRICT_RULE.windowMs + 1);
    expect(reset.allowed).toBe(true);
    expect(reset.remaining).toBe(9);
  });

  it("不同键互不影响，prune 清理过期桶", () => {
    const ctr = new FixedWindowCounter();
    ctr.hit("a", STRICT_RULE, 0);
    ctr.hit("b", STRICT_RULE, 0);
    expect(ctr.size()).toBe(2);
    ctr.prune(60_001);
    expect(ctr.size()).toBe(0);
  });
});

function buildApp(opts?: { now?: () => number }) {
  const app = new Hono();
  app.use(
    "*",
    createRateLimitMiddleware({
      enabled: () => true,
      now: opts?.now ?? (() => Date.now()),
      counter: new FixedWindowCounter(),
    }),
  );
  app.post("/api/auth/login", (c) => c.json({ ok: true }));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  return app;
}

describe("限流中间件", () => {
  it("连续错误登录第 11 次返回 429 且带 Retry-After，前 10 次放行", async () => {
    const app = buildApp();
    let last: Response | null = null;
    for (let i = 1; i <= 10; i += 1) {
      const r = await app.request("/api/auth/login", { method: "POST" });
      expect(r.status).toBe(200);
    }
    for (let i = 11; i <= 12; i += 1) {
      last = await app.request("/api/auth/login", { method: "POST" });
      expect(last.status).toBe(429);
    }
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await last!.json()) as { error: string; code: string };
    expect(body.code).toBe("TOO_MANY_REQUESTS");
    expect(body.error).toContain("频繁");
  });

  it("健康端点不计入限流", async () => {
    const app = buildApp();
    for (let i = 0; i < 20; i += 1) {
      const r = await app.request("/healthz");
      expect(r.status).toBe(200);
    }
  });
});

describe("clientKey 回环 XFF 信任", () => {
  function ctxWith(remote: string | undefined, xff?: string) {
    return {
      req: { header: (k: string) => (k.toLowerCase() === "x-forwarded-for" ? xff : undefined) },
      env: remote ? { incoming: { socket: { remoteAddress: remote } } } : {},
    } as unknown as Parameters<typeof clientKey>[0];
  }

  it("回环来源采纳合法 XFF 首段", () => {
    expect(clientKey(ctxWith("127.0.0.1", "203.0.113.7, 127.0.0.1"))).toBe("203.0.113.7");
    expect(clientKey(ctxWith("::1", "10.0.0.5"))).toBe("10.0.0.5");
  });
  it("非回环直连忽略 XFF，回落到 socket 地址", () => {
    expect(clientKey(ctxWith("198.51.100.9", "10.0.0.5"))).toBe("198.51.100.9");
  });
  it("非法 XFF 不被采纳", () => {
    expect(clientKey(ctxWith("127.0.0.1", "evil; rm -rf"))).toBe("127.0.0.1");
  });
});
