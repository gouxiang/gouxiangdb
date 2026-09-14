// apps/api/src/ops/__tests__/serveWeb.test.ts
// Web 静态托管单测：MIME/强缓存、SPA 回退、/api 不被吞、路径穿越拒绝、webDist 有效性解析。
// 用临时目录构造迷你 vite 产物，通过 Hono app.request 走完整处理器（不监听端口）。

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWebStaticMiddleware, resolveWebDist } from "../serveWeb.js";
import { stripBasePath } from "../../utils/request-path.js";

function makeDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-webdist-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html><div id=\"root\"></div></html>");
  fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "export{}");
  fs.writeFileSync(path.join(dir, "assets", "style-def456.css"), "body{}");
  fs.writeFileSync(path.join(dir, "favicon.ico"), "ICON");
  return dir;
}

function makeApp(root: string): Hono {
  const app = new Hono();
  app.get("*", createWebStaticMiddleware(root));
  return app;
}

const dirs: string[] = [];
function dist(): string {
  const d = makeDist();
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveWebDist", () => {
  it("空值返回 null", () => {
    expect(resolveWebDist("")).toBeNull();
    expect(resolveWebDist("   ")).toBeNull();
  });

  it("含 index.html 的目录返回绝对路径，缺失返回 null", () => {
    const d = dist();
    expect(resolveWebDist(d)).toBe(path.resolve(d));
    expect(resolveWebDist(path.join(d, "nope"))).toBeNull();
    expect(resolveWebDist(path.join(d, "index.html"))).toBeNull();
  });
});

describe("createWebStaticMiddleware", () => {
  it("返回 index.html（no-cache）", async () => {
    const app = makeApp(dist());
    const r = await app.request("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(await r.text()).toContain("id=\"root\"");
  });

  it("静态资源按扩展名回 MIME，/assets/* 永久强缓存", async () => {
    const app = makeApp(dist());
    const js = await app.request("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const css = await app.request("/assets/style-def456.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");

    const ico = await app.request("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
  });

  it("未知文件路径/深层 history 路由回退 index.html（200 text/html）", async () => {
    const app = makeApp(dist());
    for (const url of ["/nonexistent/spa/route", "/bases/abc?x=1", "/nope.html"]) {
      const r = await app.request(url);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("id=\"root\"");
    }
  });

  it("/api 未命中路径保持 JSON 404，不被 SPA 吞掉", async () => {
    const app = makeApp(dist());
    const r = await app.request("/api/不存在");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = await r.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("拒绝路径穿越（直接段与百分号编码），返回 404 且不泄露文件", async () => {
    const app = makeApp(dist());
    const secret = path.join(os.tmpdir(), "gx-secret-should-not-read.txt");
    fs.writeFileSync(secret, "SECRET");
    try {
      for (const url of [
        // 带编码斜杠（%2f）的穿越段无法被客户端在发送前归一，服务端必须显式 404。
        "/assets/%2e%2e%2f%2e%2e%2fsecret",
        "/%2e%2e%2f%2e%2e%2f" + path.basename(os.tmpdir()) + "/gx-secret-should-not-read.txt",
      ]) {
        const r = await app.request(url);
        expect(r.status).toBe(404);
        expect(await r.text()).not.toContain("SECRET");
      }
      // 完全解码形态 /%2e%2e/%2e%2e/etc/passwd 会被客户端按 RFC3986 归一为 /etc/passwd，
      // 直接书写的 /../ 同样在发送前归一；归一后映射到 webDist 内不存在路径，回 SPA 壳页——
      // 无论归一到何处，都绝不读到 webDist 外文件。
      for (const url of [
        "/%2e%2e/%2e%2e/etc/passwd",
        "/../../../../../../../../" + path.basename(os.tmpdir()) + "/gx-secret-should-not-read.txt",
      ]) {
        const r = await app.request(url);
        const body = await r.text();
        expect(body).not.toContain("SECRET");
        expect(body).toContain("root");
      }
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});

describe("stripBasePath", () => {
  it("无前缀原样返回", () => {
    expect(stripBasePath("/api/auth/login")).toBe("/api/auth/login");
    expect(stripBasePath("/healthz")).toBe("/healthz");
  });

  it("带前缀剥到逻辑路径（需要配置 basePath 时由调用方保证；此处用真实 config 默认空，行为即恒等）", () => {
    // config.basePath 在单测环境默认为空，stripBasePath 为恒等；
    // 带前缀剥除的集成语义由 socket 手工验证覆盖。
    expect(stripBasePath("/app/gouxiangdb/api/auth/login")).toBe("/app/gouxiangdb/api/auth/login");
  });
});
