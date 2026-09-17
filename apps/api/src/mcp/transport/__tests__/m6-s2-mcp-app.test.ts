// M6/S2 /mcp 传输骨架契约测试（真迁移库 + 真 app.ts + 真 PAT）。
//
// 覆盖：initialize / tools(list|call) 打通；根路径与 basePath 双路径；五态 401 文案快照（含
// WWW-Authenticate 与 JSON-RPC -32001 id:null）；2MB payload 在 /mcp 200 而在 /api 仍 413（双断言）；
// C-5 门控（GX_ENTERPRISE_ORG=off -> /mcp 404）。限流 429 见 m6-s2-mcp-rate-limit.test.ts。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "GX_BASE_PATH", "GX_MCP_BODY_LIMIT",
  "GX_M5_SEARCH"] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let prisma: PrismaClient;
let patSvc: typeof import("../../pat/patService.js");
let okToken: string;
let expiredToken: string;
let revokedToken: string;
let disabledToken: string;

type Req = (u: string, i?: RequestInit) => Promise<Response>;
let app: { request: Req };

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function mcpPost(body: unknown, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s2-test", version: "1" } } };

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s2-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s2.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s2-secret-at-least-16-chars";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  delete process.env.GX_BASE_PATH;
  delete process.env.GX_MCP_BODY_LIMIT;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  for (const id of ["s2-active", "s2-disabled"]) {
    await prisma.user.create({
      data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
    });
  }
  patSvc = await import("../../pat/patService.js");
  const mk = async (userId: string, name: string): Promise<{ id: string; token: string }> => {
    const r = await patSvc.createPat(userId, { name, scopes: ["record:read"], expiresInDays: 90 });
    return { id: r.pat.id, token: r.plaintext };
  };
  okToken = (await mk("s2-active", "ok")).token;
  const exp = await mk("s2-active", "expired");
  await prisma.personalAccessToken.update({ where: { id: exp.id }, data: { expiresAt: new Date("2020-01-01T00:00:00Z") } });
  expiredToken = exp.token;
  const rev = await mk("s2-active", "revoked");
  await patSvc.revokePat("s2-active", rev.id);
  revokedToken = rev.token;
  disabledToken = (await mk("s2-disabled", "disabled")).token;
  await prisma.user.update({ where: { id: "s2-disabled" }, data: { status: "DISABLED" } });

  vi.resetModules();
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("S2 协议打通（initialize / tools.list / tools.call）", () => {
  it("POST /mcp initialize -> 200，返回 serverInfo 与协议版本（JSON 响应非 SSE）", async () => {
    const res = await mcpPost(INIT, okToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = await res.json() as { jsonrpc: string; id: number; result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe("gouxiangdb-mcp");
    expect(typeof body.result.protocolVersion).toBe("string");
  });

  it("tools/list -> 200 且含 S2 冒烟工具 ping_echo（无状态模式无需会话）", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, okToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toContain("ping_echo");
  });

  it("tools/call ping_echo -> 200 且回显一致", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "ping_echo", arguments: { text: "hello" } },
    }, okToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(body.result.isError ?? false).toBe(false);
    expect(body.result.content[0]!.text).toBe("pong:hello");
  });

  it("basePath 双路径：{basePath}/mcp 与 /mcp 同源可达（spike §2.1 路径不参与协议）", async () => {
    process.env.GX_BASE_PATH = "/app/gouxiangdb";
    vi.resetModules();
    const baseApp = (await import("../../../app.js")).createApp().app as unknown as typeof app;
    const res = await baseApp.request("/app/gouxiangdb/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${okToken}` }, body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
    const root = await baseApp.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${okToken}` }, body: JSON.stringify(INIT),
    });
    expect(root.status).toBe(200);
    delete process.env.GX_BASE_PATH;
    vi.resetModules();
    app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
  });
});

describe("S2 边缘认证：五态 401 文案快照（统一 -32001 + id:null + WWW-Authenticate）", () => {
  // 注意：令牌在 beforeAll 才产生，故此处用 thunk 延迟取值（数组在 collect 期就求值，直接引用会是空串）。
  const cases: Array<[string, () => string | undefined, string]> = [
    ["无 Bearer", () => undefined, "Unauthorized"],
    ["非 gxpat_ 前缀（伪造型）", () => "not-a-pat-token", "Unauthorized"],
    ["gxpat_ 前缀但查不到（伪造随机段）", () => `gxpat_${"x".repeat(32)}`, "Unauthorized"],
    ["已过期", () => expiredToken, "Token expired"],
    ["已吊销", () => revokedToken, "Token revoked"],
    ["账号停用", () => disabledToken, "Account disabled"],
  ];
  for (const [label, token, message] of cases) {
    it(`${label} -> 401 {code:-32001, message:"${message}"} + WWW-Authenticate`, async () => {
      const res = await mcpPost(INIT, token());
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      const body = await res.json() as { jsonrpc: string; id: unknown; error: { code: number; message: string } };
      expect(Object.keys(body).sort()).toEqual(["error", "id", "jsonrpc"]);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBeNull();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toBe(message);
    });
  }
});

describe("S2 bodyLimit 第三档：/mcp 11MB 放宽而 /api 1MB 不变", () => {
  it("2MB payload 在 /mcp -> 200（< 11MB 上限；非 413）", async () => {
    // 用合法 JSON-RPC 结构携带 2MB（ping_echo.text 超 200 上限 -> 工具层 isError，HTTP 仍 200）
    const big = {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "ping_echo", arguments: { text: "x".repeat(2 * 1024 * 1024) } },
    };
    const res = await mcpPost(big, okToken);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(413);
  });

  it("回归护栏：2MB payload 在 /api 仍 413 PAYLOAD_TOO_LARGE（S0 锁定的 1MB 档未放宽）", async () => {
    const res = await app.request("/api/records?tableId=none", {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${okToken}` },
      body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json() as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("S2 C-5 门控：GX_ENTERPRISE_ORG=off -> /mcp 404", () => {
  it("/mcp 不挂载（顶层 404）", async () => {
    process.env.GX_ENTERPRISE_ORG = "off";
    vi.resetModules();
    const offApp = (await import("../../../app.js")).createApp().app as unknown as typeof app;
    const res = await offApp.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${okToken}` }, body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(404);
    delete process.env.GX_ENTERPRISE_ORG;
    vi.resetModules();
    app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
  });
});
