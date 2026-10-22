// apps/api/src/middleware/__tests__/securityHeaders.test.ts
// 安全头与请求体上限契约（构造最小 Hono app，不起服务）。

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { secureHeadersMiddleware } from "../secureHeaders.js";
import { bodyLimitDispatch } from "../bodyLimit.js";

function buildApp() {
  const app = new Hono();
  app.use("*", secureHeadersMiddleware);
  app.use("*", bodyLimitDispatch);
  app.post("/api/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    return c.json({ ok: true, got: body });
  });
  app.post("/api/auth/me/avatar", async (c) => {
    await c.req.parseBody().catch(() => null);
    return c.json({ ok: true });
  });
  return app;
}

describe("secureHeaders 中间件", () => {
  it("下发关键安全头，且不发应用层 HSTS", async () => {
    const app = buildApp();
    const res = await app.request("/api/auth/login", { method: "POST", body: "{}" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
    // HSTS 由 Caddy 在 TLS 侧发，应用在 HTTP 反代后不应发
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("secureHeaders 飞牛渠道（GX_DEPLOY_CHANNEL=fnos-fpk）", () => {
  it("不发 X-Frame-Options，允许飞牛门户跨源 iframe 嵌入独立端口", async () => {
    // 模块在 import 时读 GX_DEPLOY_CHANNEL 决定单例，故先置位再重置模块缓存后动态 import。
    vi.stubEnv("GX_DEPLOY_CHANNEL", "fnos-fpk");
    vi.resetModules();
    try {
      const mod = await import("../secureHeaders.js");
      const mw = mod.secureHeadersMiddleware as typeof secureHeadersMiddleware;
      const app = new Hono();
      app.use("*", mw);
      app.get("/", (c) => c.text("ok"));
      const res = await app.request("/");
      // 跨源 iframe 必须完全不带 X-Frame-Options（SAMEORIGIN 也会拦跨源端口）。
      expect(res.headers.get("x-frame-options")).toBeNull();
      // 其余安全头不受影响。
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("bodyLimit 中间件", () => {
  it("普通 JSON 超过 1MB 返 413 且带机器码", async () => {
    const app = buildApp();
    const big = JSON.stringify({ password: "a".repeat(1_100_000) });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error).toContain("超过");
  });

  it("普通 JSON 在 1MB 内正常通过", async () => {
    const app = buildApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "x".repeat(100) }),
    });
    expect(res.status).toBe(200);
  });

  it("头像路由放宽到 6MB：2MB 负载不被 1MB 全局限制拦截", async () => {
    const app = buildApp();
    const form = new FormData();
    // File 构造在 Node 18+ 可用；2MB 内容（低于 6MB，高于 1MB）
    form.append("file", new File(["a".repeat(2 * 1024 * 1024)], "a.png", { type: "image/png" }));
    const res = await app.request("/api/auth/me/avatar", { method: "POST", body: form });
    // 未带鉴权会到业务层（测试桩直接 ok），关键是不是 413
    expect(res.status).not.toBe(413);
  });
});
