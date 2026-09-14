// apps/api/src/__tests__/deploy-config.test.ts
// 部署适配三可选配置（GX_SOCKET_PATH / GX_BASE_PATH / GX_WEB_DIST）测试：
//   - 缺省三值为空（与历史行为一致，默认关闭）
//   - 设置后归一（basePath 去末尾斜杠/非法回落）
//   - 生产环境下这三项缺失不触发 fail-closed（模块可正常求值且字段为空）
// config 在模块求值时按当时 process.env 冻结，因此用 resetModules + 动态 import 构造隔离求值。

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBasePath } from "../config.js";

const MANAGED_KEYS = [
  "NODE_ENV",
  "GX_SOCKET_PATH",
  "GX_BASE_PATH",
  "GX_WEB_DIST",
  "JWT_SECRET",
  "DATABASE_URL",
  "CORS_ORIGIN",
];

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const k of MANAGED_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import("../config.js");
  return mod.config as {
    socketPath: string;
    basePath: string;
    webDist: string;
  };
}

describe("normalizeBasePath 纯函数", () => {
  it("undefined/空串/纯空白 → 空", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("   ")).toBe("");
  });

  it("根 '/' → 空（根挂载已覆盖）", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("去末尾斜杠", () => {
    expect(normalizeBasePath("/app/gouxiangdb")).toBe("/app/gouxiangdb");
    expect(normalizeBasePath("/app/gouxiangdb/")).toBe("/app/gouxiangdb");
    expect(normalizeBasePath("/app/gouxiangdb///")).toBe("/app/gouxiangdb");
  });

  it("trim 外层空白", () => {
    expect(normalizeBasePath("  /app/gouxiangdb/  ")).toBe("/app/gouxiangdb");
  });

  it("非法（不以 / 开头、含穿越段、NUL）→ 空", () => {
    expect(normalizeBasePath("app/gouxiangdb")).toBe("");
    expect(normalizeBasePath("../etc")).toBe("");
    expect(normalizeBasePath("/app/../etc")).toBe("");
  });
});

describe("部署适配配置（冻结值）", () => {
  afterEach(() => {
    vi.resetModules();
    for (const k of MANAGED_KEYS) delete process.env[k];
  });

  it("缺省：三值均为空字符串（默认关闭，行为与现状一致）", async () => {
    const cfg = await loadConfig({ NODE_ENV: "development" });
    expect(cfg.socketPath).toBe("");
    expect(cfg.basePath).toBe("");
    expect(cfg.webDist).toBe("");
  });

  it("设置后正确解析与归一", async () => {
    const cfg = await loadConfig({
      NODE_ENV: "development",
      GX_SOCKET_PATH: "  /tmp/gx.sock  ",
      GX_BASE_PATH: "/app/gouxiangdb/",
      GX_WEB_DIST: "  /srv/web/dist  ",
    });
    expect(cfg.socketPath).toBe("/tmp/gx.sock");
    expect(cfg.basePath).toBe("/app/gouxiangdb");
    expect(cfg.webDist).toBe("/srv/web/dist");
  });

  it("非法 GX_BASE_PATH 回落为空，其余照常", async () => {
    const cfg = await loadConfig({
      NODE_ENV: "development",
      GX_SOCKET_PATH: "/tmp/gx.sock",
      GX_BASE_PATH: "no-leading-slash",
    });
    expect(cfg.basePath).toBe("");
    expect(cfg.socketPath).toBe("/tmp/gx.sock");
  });

  it("生产环境缺这三项不导致启动校验失败，且字段为空", async () => {
    const cfg = await loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "x".repeat(40),
      DATABASE_URL: "file:/var/lib/gouxiangdb/app.db",
      CORS_ORIGIN: "https://gx.example.com",
    });
    expect(cfg.socketPath).toBe("");
    expect(cfg.basePath).toBe("");
    expect(cfg.webDist).toBe("");
  });

  it("生产环境设置这三项仍可正常解析（可选项被接受）", async () => {
    const cfg = await loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "x".repeat(40),
      DATABASE_URL: "file:/var/lib/gouxiangdb/app.db",
      CORS_ORIGIN: "https://gx.example.com",
      GX_SOCKET_PATH: "/tmp/gx.sock",
      GX_BASE_PATH: "/app/gouxiangdb",
      GX_WEB_DIST: "/srv/gouxiangdb/web",
    });
    expect(cfg.socketPath).toBe("/tmp/gx.sock");
    expect(cfg.basePath).toBe("/app/gouxiangdb");
    expect(cfg.webDist).toBe("/srv/gouxiangdb/web");
  });
});
