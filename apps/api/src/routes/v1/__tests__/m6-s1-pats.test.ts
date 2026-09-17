// M6/S1 /api/v1/pats REST 契约测试（真迁移临时库 + 真 app.ts + 真 JWT）。
//
// 覆盖（M6 计划 §5.2/§9 S1 验收）：201 明文仅一次 / 列表无 token+hash / 400 三码 /
// 本人限定 404 不泄漏存在性 / 未登录 401 / C-5 门控（GX_ENTERPRISE_ORG=off -> 404）/
// 审计 mcp_pat_create|revoke 落盘且不含明文。
//
// 与 m5-search-gate.test.ts 同模式：env 冻结 config -> vi.resetModules + 动态 import app（可按 flag 重建）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = "m6-s1-pats-secret-at-least-16-chars";
const TTL = 7 * 24 * 60 * 60;
const U1 = "pat-user-1";
const U2 = "pat-user-2";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV"] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let auditFile: string;
let prisma: PrismaClient;
let token1: string;

interface BuiltApp { app: { request: (u: string, i?: RequestInit) => Promise<Response> } }

function auth1(): Record<string, string> {
  return { Authorization: `Bearer ${token1}`, "content-type": "application/json" };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s1-pats-"));
  auditFile = path.join(tmpDir, ".audit", "audit.logl");
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "pats.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  for (const id of [U1, U2]) {
    await prisma.user.create({
      data: { id, email: `${id}@x.com`, displayName: id, passwordHash: await bcrypt.hash("password123", 10), status: "ACTIVE", workspaceId: "ws_default" },
    });
  }
  const now = Math.floor(Date.now() / 1000);
  token1 = await sign({ userId: U1, tv: 0, iat: now, exp: now + TTL }, JWT_SECRET, "HS256");
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function buildApp(orgFlag?: string): Promise<BuiltApp> {
  if (orgFlag === undefined) delete process.env.GX_ENTERPRISE_ORG;
  else process.env.GX_ENTERPRISE_ORG = orgFlag;
  vi.resetModules();
  const appMod = await import("../../../app.js");
  return { app: appMod.createApp().app as unknown as BuiltApp["app"] };
}

function auditEvents(): Array<{ event: string; detail: Record<string, unknown>; actorId: string | null }> {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("M6/S1 /api/v1/pats 契约", () => {
  it("POST 201：返回明文一次；库内只存 hash+前缀；响应含 token/tokenPrefix/expiresAt", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/v1/pats", {
      method: "POST", headers: auth1(),
      body: JSON.stringify({ name: "cursor-工作机", scopes: ["record:read", "doc:read"], expiresInDays: 90 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; token: string; tokenPrefix: string; expiresAt: string; scopes: string[] };
    expect(body.token.startsWith("gxpat_")).toBe(true);
    expect(body.tokenPrefix).toBe(body.token.slice(0, 14));
    expect(body.scopes).toEqual(["record:read", "doc:read"]);
    expect(typeof body.expiresAt).toBe("string");
    // 明文随机段不入库
    const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: body.id } });
    expect(JSON.stringify(row)).not.toContain(body.token.slice(14));
    expect(row.tokenPrefix).toBe(body.tokenPrefix);
  });

  it("GET 列表：只回元数据（无 token / tokenHash），且响应全文不含任何完整明文", async () => {
    const { app } = await buildApp();
    const created = await (await app.request("/api/v1/pats", {
      method: "POST", headers: auth1(), body: JSON.stringify({ name: "list-check", scopes: ["doc:write"] }),
    })).json() as { token: string };
    const res = await app.request("/api/v1/pats", { headers: auth1() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(created.token); // 明文仅创建响应一次
    expect(text).not.toContain("tokenHash");
    const list = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(list[0]!).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "revokedAt", "scopes", "tokenPrefix"],
    );
  });

  it("POST 400 三码：scopes 空/未知 -> PAT_SCOPE_INVALID；name 超长 -> PAT_NAME_INVALID；expiry 7 -> PAT_EXPIRY_INVALID", async () => {
    const { app } = await buildApp();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: "x", scopes: [] }, "PAT_SCOPE_INVALID"],
      [{ name: "x", scopes: ["doc:admin"] }, "PAT_SCOPE_INVALID"],
      [{ name: "x".repeat(61), scopes: ["doc:read"] }, "PAT_NAME_INVALID"],
      [{ scopes: ["doc:read"] }, "PAT_NAME_INVALID"],
      [{ name: "x", scopes: ["doc:read"], expiresInDays: 7 }, "PAT_EXPIRY_INVALID"],
      [{ name: "x", scopes: ["doc:read"], expiresInDays: "90" }, "PAT_EXPIRY_INVALID"],
    ];
    for (const [body, code] of cases) {
      const res = await app.request("/api/v1/pats", { method: "POST", headers: auth1(), body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe(code);
    }
    // 显式 null = 永不过期 -> 201 且 expiresAt null
    const ok = await app.request("/api/v1/pats", {
      method: "POST", headers: auth1(), body: JSON.stringify({ name: "forever", scopes: ["doc:read"], expiresInDays: null }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json() as { expiresAt: string | null }).expiresAt).toBeNull();
  });

  it("DELETE 本人 -> 204；他人 patId / 不存在 / 已吊销 -> 404 PAT_NOT_FOUND（不泄漏存在性）", async () => {
    const { app } = await buildApp();
    const mine = await (await app.request("/api/v1/pats", {
      method: "POST", headers: auth1(), body: JSON.stringify({ name: "mine", scopes: ["record:read"] }),
    })).json() as { id: string };
    // u2 名下另建一行（直接入库，等价另一账号签发）
    const other = await prisma.personalAccessToken.create({
      data: { userId: U2, name: "other", tokenPrefix: "gxpat_other12", tokenHash: "deadbeef".repeat(8), scopes: "[]" },
    });
    for (const [id, expected] of [[other.id, 404], ["nonexistent-id", 404]] as const) {
      const res = await app.request(`/api/v1/pats/${id}`, { method: "DELETE", headers: auth1() });
      expect(res.status).toBe(expected);
      expect((await res.json() as { code: string }).code).toBe("PAT_NOT_FOUND");
    }
    const del = await app.request(`/api/v1/pats/${mine.id}`, { method: "DELETE", headers: auth1() });
    expect(del.status).toBe(204);
    const again = await app.request(`/api/v1/pats/${mine.id}`, { method: "DELETE", headers: auth1() });
    expect(again.status).toBe(404);
  });

  it("未登录 -> 401（v1 requireActiveUser 先于处理器）", async () => {
    const { app } = await buildApp();
    const res = await app.request("/api/v1/pats");
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("C-5 门控：GX_ENTERPRISE_ORG=off -> /api/v1/pats 整体 404（不挂载）", async () => {
    const { app } = await buildApp("off");
    const res = await app.request("/api/v1/pats", { headers: auth1() });
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("NOT_FOUND");
  });

  it("审计：mcp_pat_create / mcp_pat_revoke 落盘且 detail 无明文 token", async () => {
    const { app } = await buildApp();
    const created = await (await app.request("/api/v1/pats", {
      method: "POST", headers: auth1(), body: JSON.stringify({ name: "audited", scopes: ["record:read"] }),
    })).json() as { id: string; token: string };
    await app.request(`/api/v1/pats/${created.id}`, { method: "DELETE", headers: auth1() });
    const events = auditEvents();
    const create = events.find((e) => e.event === "mcp_pat_create" && e.detail.patId === created.id);
    const revoke = events.find((e) => e.event === "mcp_pat_revoke" && e.detail.patId === created.id);
    expect(create).toBeTruthy();
    expect(revoke).toBeTruthy();
    expect(create!.actorId).toBe(U1);
    expect(create!.detail.prefix).toBe(created.token.slice(0, 14));
    // 审计全文不含完整明文
    expect(fs.readFileSync(auditFile, "utf8")).not.toContain(created.token);
  });
});
