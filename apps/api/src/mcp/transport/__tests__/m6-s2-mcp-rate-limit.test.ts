// M6/S2 两段式限流测试（§5.3，C-1 默认经 env 改小以确定性验证）。
//
// 覆盖：
//   ① patId 正式桶超限 -> 429 + Retry-After + X-RateLimit-* + JSON-RPC -32029（认证之后计）；
//   ② IP 预桶超限 -> 429（**认证之前**即拦，未认证请求也吃 IP 桶，防打爆）。
// 每段用独立 env + 独立 import（mcpApp 的 FixedWindowCounter 为模块级，resetModules 后即新桶）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_MCP_RATE_WINDOW_SEC", "GX_MCP_RATE_PAT_MAX",
  "GX_MCP_RATE_IP_MAX"] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let prisma: PrismaClient;
let token: string;

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rl", version: "1" } } };

type Req = (u: string, i?: RequestInit) => Promise<Response>;

async function buildApp(env: { patMax?: string; ipMax?: string }): Promise<{ request: Req }> {
  process.env.GX_RATE_LIMIT = "on"; // test 环境需显式 on 才启用限流
  process.env.GX_MCP_RATE_WINDOW_SEC = "60";
  if (env.patMax === undefined) delete process.env.GX_MCP_RATE_PAT_MAX; else process.env.GX_MCP_RATE_PAT_MAX = env.patMax;
  if (env.ipMax === undefined) delete process.env.GX_MCP_RATE_IP_MAX; else process.env.GX_MCP_RATE_IP_MAX = env.ipMax;
  vi.resetModules();
  const app = (await import("../../../app.js")).createApp().app as unknown as { request: Req };
  return app;
}

function call(app: { request: Req }, tok?: string): Promise<Response> {
  const headers: Record<string, string> = { ...H };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return app.request("/mcp", { method: "POST", headers, body: JSON.stringify(INIT) });
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s2-rl-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "rl.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s2-rl-secret-at-least-16-chars";
  process.env.NODE_ENV = "test";
  delete process.env.GX_ENTERPRISE_ORG;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  await prisma.user.create({ data: { id: "rl-user", email: "rl@x.com", displayName: "rl", passwordHash: "x", status: "ACTIVE" } });
  const svc = await import("../../pat/patService.js");
  token = (await svc.createPat("rl-user", { name: "rl", scopes: ["record:read"], expiresInDays: 90 })).plaintext;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("S2 限流：patId 正式桶（认证后）", () => {
  it("超过 GX_MCP_RATE_PAT_MAX -> 429 + Retry-After + X-RateLimit-* + -32029", async () => {
    const app = await buildApp({ patMax: "2", ipMax: "100" });
    expect((await call(app, token)).status).toBe(200);
    expect((await call(app, token)).status).toBe(200);
    const third = await call(app, token);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(third.headers.get("x-ratelimit-limit")).toBe("2");
    expect(await third.json()).toEqual({ jsonrpc: "2.0", error: { code: -32029, message: "RATE_LIMITED" }, id: null });
  });
});

describe("S2 限流：IP 预桶（认证前，未认证请求也计数）", () => {
  it("超 GX_MCP_RATE_IP_MAX 即在认证前 429（不进入 401 分支）", async () => {
    const app = await buildApp({ patMax: "100", ipMax: "3" });
    for (let i = 0; i < 3; i++) {
      const r = await call(app); // 无 token -> 401（且各吃一次 IP 桶）
      expect(r.status).toBe(401);
    }
    const fourth = await call(app);
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("www-authenticate")).toBeNull(); // 认证前拦截，无 401 头
    expect(await fourth.json()).toEqual({ jsonrpc: "2.0", error: { code: -32029, message: "RATE_LIMITED" }, id: null });
  });
});
