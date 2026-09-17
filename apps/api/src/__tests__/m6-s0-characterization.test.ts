// M6/S0 characterization：锁死「M6 不得破坏的既有行为」（零生产改动，只增测试）。
//
// 目的（M6 计划 §3 不能动的契约 / §9 S0）：在 M6 落任何代码前，把下列既有行为用真库真 HTTP 冻结：
//   1) kb PUT content 乐观锁冲突 -> 409 {code:VERSION_CONFLICT, currentVersion}（成功 -> 200 + contentVersion 递增）；
//   2) GET /api/records 旧记录列表 200 形状（默认档 = S0 七键；additive 三键由 records-keyset.test.ts 另锁）；
//   3) GET /api/v1/meta 200 形状；
//   4) 全局 1MB body 上限对 /api 仍 413（M6 会为 /mcp 增 11MB 第三档，【绝不能放宽 /api】——本片是回归护栏）；
//   5) /api/v1/pats 与 /mcp 当前【不存在】（404），作为 M6 加挂前后的对照基线。
//
// 夹具：真迁移临时库 + 真 app.ts（含 bodyLimit/rateLimit/secureHeaders 全链）+ 真 JWT（resolveActiveAuth）。
// 与本仓既有全链测试同模式（m5-search-gate.test.ts）：env 冻结 config -> vi.resetModules + 动态 import app。
// 事实锚点均于 d7ff0ac 实读，详见 docs/baseline/2026-09-18-m6-baseline.md。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = "m6-s0-characterization-secret-at-least-16";
const TOKEN_TTL = 7 * 24 * 60 * 60;
const U = "s0-user";

const ENV_KEYS = [
  "DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "GX_M5_SEARCH",
  "GX_M1_SIDECAR", "GX_M1_SIDECAR_READ", "GX_M1_KEYSET",
] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let prisma: PrismaClient;
let token: string;
let app: { request: (url: string, init?: RequestInit) => Promise<Response> };
let tableId: string;
let docId: string;

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
function jsonAuth(): Record<string, string> {
  return { ...auth(), "content-type": "application/json" };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s0-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s0.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  // 企业面默认（GX_ENTERPRISE_ORG 未设置 = 开）；M5 默认 off；M1 flags 默认（keyset 关）。
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  delete process.env.GX_M5_SEARCH;
  delete process.env.GX_M1_SIDECAR;
  delete process.env.GX_M1_SIDECAR_READ;
  delete process.env.GX_M1_KEYSET;

  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({
    data: {
      id: U, email: "s0@x.com", displayName: "s0",
      passwordHash: await bcrypt.hash("password123", 10),
      status: "ACTIVE", workspaceId: "ws_default",
    },
  });
  // 记录列表夹具：base + member(editor) + table + field + 3 行。
  const base = await prisma.base.create({ data: { name: "b", createdBy: U } });
  await prisma.member.create({ data: { baseId: base.id, userId: U, role: "editor" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: U },
  });
  tableId = table.id;
  const field = await prisma.field.create({
    data: { tableId, name: "名称", type: "singleLineText", order: 0 },
  });
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: field.id } });
  await prisma.record.createMany({
    data: [0, 1, 2].map((i) => ({
      tableId, fields: JSON.stringify({ [field.id]: `行${i}` }), createdBy: U, updatedBy: U,
    })),
  });
  // 文档乐观锁夹具：kb + kb_member(editor) + kb_doc(contentVersion=2)。
  const kb = await prisma.knowledgeBase.create({ data: { name: "kb", createdBy: U } });
  await prisma.kbMember.create({ data: { kbId: kb.id, userId: U, role: "editor" } });
  const doc = await prisma.kbDoc.create({
    data: { kbId: kb.id, kind: "doc", title: "d", content: "# v2", contentVersion: 2, createdBy: U, updatedBy: U },
  });
  docId = doc.id;

  const now = Math.floor(Date.now() / 1000);
  token = await sign({ userId: U, tv: 0, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");

  vi.resetModules();
  const appMod = await import("../app.js");
  app = appMod.createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("S0-1 kb PUT content 乐观锁（409 VERSION_CONFLICT + 成功 200）", () => {
  it("baseVersion 不符 -> 409 {code:VERSION_CONFLICT, currentVersion:2}（形状冻结）", async () => {
    const res = await app.request(`/api/kb/docs/${docId}/content`, {
      method: "PUT", headers: jsonAuth(), body: JSON.stringify({ content: "stale", baseVersion: 1 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; code: string; currentVersion: number };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.currentVersion).toBe(2);
    expect(typeof body.error).toBe("string");
  });

  it("baseVersion 相符 -> 200 {ok:true, contentVersion:3}（版本自增）", async () => {
    const res = await app.request(`/api/kb/docs/${docId}/content`, {
      method: "PUT", headers: jsonAuth(), body: JSON.stringify({ content: "# v3", baseVersion: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; contentVersion: number; savedAt: string };
    expect(body.ok).toBe(true);
    expect(body.contentVersion).toBe(3);
    expect(typeof body.savedAt).toBe("string");
  });
});

describe("S0-2 GET /api/records 旧记录列表 200 形状", () => {
  it("默认档（keyset 关）：S0 七键，行数与 total 一致", async () => {
    const res = await app.request(`/api/records?tableId=${tableId}`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // additive（nextCursor/hasMore/degraded）仅在 keyset 生效路径出现（records-keyset.test.ts 已锁）。
    expect(Object.keys(body).sort()).toEqual(
      ["aggregations", "allFields", "fields", "filteredTotal", "groups", "records", "total"],
    );
    expect((body.records as unknown[])).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.filteredTotal).toBe(3);
  });
});

describe("S0-3 GET /api/v1/meta 200 形状", () => {
  it("返回 {apiVersion, enterpriseOrg, auth:{userId,status,workspaceId}}", async () => {
    const res = await app.request("/api/v1/meta", { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      apiVersion: "v1",
      enterpriseOrg: true,
      auth: { userId: U, status: "ACTIVE", workspaceId: "ws_default" },
    });
  });
});

describe("S0-4 全局 1MB body 上限对 /api 仍 413（M6 不得放宽 /api）", () => {
  it(">1MB 请求体 -> 413 PAYLOAD_TOO_LARGE（bodyLimit 先于路由）", async () => {
    const big = JSON.stringify({ pad: "x".repeat(1_200_000) });
    const res = await app.request(`/api/records?tableId=${tableId}`, {
      method: "POST", headers: jsonAuth(), body: big,
    });
    expect(res.status).toBe(413);
    expect((await res.json() as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("对照：同路由小体 POST 正常到处理器（证明 413 由体积而非方法/路由造成）", async () => {
    const res = await app.request(`/api/records?tableId=${tableId}`, {
      method: "POST", headers: jsonAuth(), body: JSON.stringify({ fields: {} }),
    });
    expect(res.status).toBe(201);
  });
});

describe("S0-5 M6 新增面加挂前后对照", () => {
  // S0 落地时 /api/v1/pats 与 /mcp 均为 404（M6 加挂前对照，见 m6-baseline §3）。
  // S1 挂载 /api/v1/pats、S2 挂载 /mcp，故此处按"S2 之后"的既有行为更新：
  // 两者都已存在（无 token -> 401；有 token -> 200）。属 M6 的**有意增量**，非回归。
  it("/api/v1/pats 已挂载（S1 起）：无 token -> 401、带 token -> 200（不再 404）", async () => {
    const noAuth = await app.request("/api/v1/pats");
    expect(noAuth.status).toBe(401);
    const withAuth = await app.request("/api/v1/pats", { headers: auth() });
    expect(withAuth.status).toBe(200);
    expect(Array.isArray(await withAuth.json())).toBe(true);
  });

  it("/mcp 已挂载（S2 起）：无 token -> 401（WWW-Authenticate + -32001）、带协议头不再是 404", async () => {
    const noAuth = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Bearer");
    expect(await noAuth.json()).toEqual({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  });
});
