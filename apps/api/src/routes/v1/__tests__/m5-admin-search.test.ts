// M5/S9 admin 六端点 HTTP 端到端（真迁移临时库 + 真 createApp + 真 JWT，cloud 不触网）。
//
// 装配同 m5-search-gate（env 冻结 config，vi.resetModules 后动态 import）；固定 GX_M5_SEARCH=on，
// off 态 404/零建库在 gate 断言。owner 授 role_owner，另造无角色普通用户验 403；真物理 search.db。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = "m5-s9-admin-secret-at-least-16-chars";
const TOKEN_TTL = 7 * 24 * 60 * 60;

const PREV: Record<string, string | undefined> = {};
let tmpDir: string;
let prisma: PrismaClient;
let ownerToken: string;
let userToken: string;
let searchPath: string;
type App = { request: (url: string, init?: RequestInit) => Promise<Response> };
let app: App;

async function tokenFor(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ userId, tv: 0, iat: now, exp: now + TOKEN_TTL }, JWT_SECRET, "HS256");
}

beforeAll(async () => {
  for (const k of ["GX_M5_SEARCH", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "DATABASE_URL",
    "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV", "GX_RATE_LIMIT",
    "GX_SEARCH_DB_PATH", "GX_EMBEDDING_MODE", "GX_EMBEDDING_API_KEY", "GX_EMBEDDING_BASE_URL", "GX_EMBEDDING_MODEL"]) {
    PREV[k] = process.env[k];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m5s9-admin-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "admin.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  searchPath = path.join(tmpDir, "search.db");
  process.env.GX_SEARCH_DB_PATH = searchPath;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_M5_SEARCH = "on";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_ENTERPRISE_NAV;
  delete process.env.GX_EMBEDDING_MODE;
  delete process.env.GX_EMBEDDING_API_KEY;
  delete process.env.GX_EMBEDDING_BASE_URL;
  delete process.env.GX_EMBEDDING_MODEL;

  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  const mk = async (id: string) => {
    await prisma.user.create({
      data: {
        id, email: `${id}@x.com`, displayName: id,
        passwordHash: await bcrypt.hash("password123", 10),
        status: "ACTIVE", workspaceId: "ws_default",
      },
    });
  };
  await mk("s9-owner");
  await mk("s9-user");
  await prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "s9-owner", scopeType: "workspace", createdBy: "seed" },
  });
  ownerToken = await tokenFor("s9-owner");
  userToken = await tokenFor("s9-user");

  vi.resetModules();
  const appMod = await import("../../../app.js");
  app = appMod.createApp().app as unknown as App;
}, 120000);

afterAll(async () => {
  const { closeSearchStore } = await import("../../../domain/search/searchStore.js");
  closeSearchStore();
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const owner = () => ({ Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" });
const user = () => ({ Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" });

async function readAppSetting(k: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { k } });
  return row?.v ?? null;
}

describe("M5/S9 admin 六端点：鉴权", () => {
  it("未登录 -> 401", async () => {
    const res = await app.request("/api/v1/admin/search/status");
    expect(res.status).toBe(401);
  });
  it("非 owner 全部管理端点 -> 403", async () => {
    const cases: Array<[string, RequestInit?]> = [
      ["/api/v1/admin/search/status", { headers: user() }],
      ["/api/v1/admin/embedding/config", { headers: user() }],
      ["/api/v1/admin/reindex", { method: "POST", headers: user(), body: "{}" }],
      ["/api/v1/admin/embedding/config", { method: "PATCH", headers: user(), body: "{}" }],
      ["/api/v1/admin/embedding/api-key/rotate", { method: "POST", headers: user(), body: JSON.stringify({ apiKey: "k" }) }],
      ["/api/v1/admin/embedding/api-key", { method: "DELETE", headers: user() }],
    ];
    for (const [url, init] of cases) {
      const res = await app.request(url, init);
      expect(res.status, url).toBe(403);
    }
  });
});

describe("M5/S9 GET status / embedding config", () => {
  it("search.db 尚未建 -> index=null、零建库姿态；embedding 默认 off", async () => {
    expect(fs.existsSync(searchPath)).toBe(false);
    const res = await app.request("/api/v1/admin/search/status", { headers: owner() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vec.extPathKind).toMatch(/^(builtin|env-override|platform)$/);
    expect(body.embedding.mode).toBe("off");
    expect(body.embedding.healthy).toBe(true);
    expect(body.embedding.reindexRequired).toBe(false);
    expect(body.index).toBeNull();
    // 只读 status 不建库。
    expect(fs.existsSync(searchPath)).toBe(false);
  });

  it("GET embedding/config 默认形状（apiKey none、dim=0）", async () => {
    const res = await app.request("/api/v1/admin/embedding/config", { headers: owner() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["apiKey", "baseURL", "batchSize", "dim", "fieldChunkCap", "mode", "model", "timeoutMs"].sort(),
    );
    expect(body.mode).toBe("off");
    expect(body.dim).toBe(0);
    expect(body.apiKey).toEqual({ configured: false, source: "none", maskedLast4: null });
  });
});

describe("M5/S9 PATCH embedding config 校验", () => {
  it("出现 dim/dimensions -> 400 EMBEDDING_CONFIG_INVALID；reindex:true 同样 400", async () => {
    for (const bad of [{ dim: 1024 }, { dimensions: 1024 }, { reindex: true }]) {
      const res = await app.request("/api/v1/admin/embedding/config", {
        method: "PATCH", headers: owner(), body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("EMBEDDING_CONFIG_INVALID");
    }
  });

  it("cap 越界/坏 URL/batch·timeout 非正整数 -> 400", async () => {
    const bad = [
      { fieldChunkCap: 0 }, { fieldChunkCap: 1001 }, { fieldChunkCap: 1.5 },
      { baseURL: "not a url" }, { baseURL: "ftp://x.example" },
      { batchSize: 0 }, { batchSize: -1 }, { timeoutMs: 1.5 }, { timeoutMs: 0 },
      { apiKey: 123 }, { apiKey: "" },
    ];
    for (const b of bad) {
      const res = await app.request("/api/v1/admin/embedding/config", {
        method: "PATCH", headers: owner(), body: JSON.stringify(b),
      });
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await res.json()).code).toBe("EMBEDDING_CONFIG_INVALID");
    }
  });

  it("off->cloud 缺 confirmCloud -> 409 NEED_CLOUD_CONFIRM；带确认成功且 reindexRequired=true", async () => {
    const noConfirm = await app.request("/api/v1/admin/embedding/config", {
      method: "PATCH", headers: owner(),
      body: JSON.stringify({ mode: "cloud", baseURL: "https://embed.example/v1", model: "m1", apiKey: "secret-key-1234" }),
    });
    expect(noConfirm.status).toBe(409);
    expect((await noConfirm.json()).code).toBe("NEED_CLOUD_CONFIRM");

    const ok = await app.request("/api/v1/admin/embedding/config", {
      method: "PATCH", headers: owner(),
      body: JSON.stringify({
        mode: "cloud", confirmCloud: true, baseURL: "https://embed.example/v1",
        model: "m1", apiKey: "secret-key-1234", batchSize: 32, timeoutMs: 9000, fieldChunkCap: 80,
      }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.mode).toBe("cloud");
    expect(body.reindexRequired).toBe(true);
    expect(body.apiKey.configured).toBe(true);
    expect(body.apiKey.source).toBe("db");
    expect(body.apiKey.maskedLast4).toBe("1234");
  });

  it("cloud->off 不需确认，200 成功", async () => {
    const res = await app.request("/api/v1/admin/embedding/config", {
      method: "PATCH", headers: owner(), body: JSON.stringify({ mode: "off" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("off");
  });
});

describe("M5/S9 apiKey rotate / 加密落库 / GET / DELETE", () => {
  it("rotate 回存在性形状；库中只存 AES-GCM 密文（v1:）不含明文", async () => {
    const res = await app.request("/api/v1/admin/embedding/api-key/rotate", {
      method: "POST", headers: owner(), body: JSON.stringify({ apiKey: "plaintext-magic-9876" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, source: "db", maskedLast4: "9876" });

    const stored = await readAppSetting("embedding.api_key_cipher");
    expect(stored).toBeTruthy();
    expect(stored!.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("plaintext-magic-9876");

    const g = await app.request("/api/v1/admin/embedding/config", { headers: owner() });
    const body = await g.json();
    expect(body.apiKey).toMatchObject({ configured: true, source: "db", maskedLast4: "9876" });
  });

  it("rotate 缺 apiKey/空 -> 400", async () => {
    const r1 = await app.request("/api/v1/admin/embedding/api-key/rotate", {
      method: "POST", headers: owner(), body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request("/api/v1/admin/embedding/api-key/rotate", {
      method: "POST", headers: owner(), body: JSON.stringify({ apiKey: "  " }),
    });
    expect(r2.status).toBe(400);
  });

  it("DELETE -> 204 清 db key（回落 none）", async () => {
    const del = await app.request("/api/v1/admin/embedding/api-key", { method: "DELETE", headers: owner() });
    expect(del.status).toBe(204);
    expect(await readAppSetting("embedding.api_key_cipher")).toBeNull();
    const g = await app.request("/api/v1/admin/embedding/config", { headers: owner() });
    expect((await g.json()).apiKey).toEqual({ configured: false, source: "none", maskedLast4: null });
  });
});

describe("M5/S9 reindex 202 + 409 + 真机灌库/status", () => {
  it("全量 reindex：202；进行中第二次 409；完成后 status 有 index 且 coverage 一致", async () => {
    // 造一个活 table+nav+record（reindex 抽取需要 table/field 存活）。
    await prisma.base.create({ data: { id: "s9_b", name: "s9 库", createdBy: "o" } });
    await prisma.table.create({
      data: { id: "s9_t", baseId: "s9_b", name: "s9 表", primaryFieldId: "s9_f0", createdBy: "o" },
    });
    await prisma.field.create({ data: { id: "s9_f0", tableId: "s9_t", name: "标题", type: "singleLineText", order: 0 } });
    await prisma.record.create({
      data: { id: "s9_r1", tableId: "s9_t", createdBy: "o", updatedBy: "o", fields: JSON.stringify({ s9_f0: "重建唯一词阿尔法" }) },
    });
    const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));

    const reindexMod = await import("../../../domain/search/reindex.js");
    const first = await app.request("/api/v1/admin/reindex", {
      method: "POST", headers: owner(), body: JSON.stringify({}),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ job: "reindex", status: "started" });

    // 同模块图实例：重建在飞时立即再打 -> 409（极小库也可能已完成，故先确认 inflight，否则跳过竞态断言）。
    if (reindexMod.currentReindex()) {
      const second = await app.request("/api/v1/admin/reindex", {
        method: "POST", headers: owner(), body: JSON.stringify({}),
      });
      expect(second.status).toBe(409);
      expect((await second.json()).code).toBe("REINDEX_IN_PROGRESS");
    }
    await reindexMod.currentReindex();

    // 完成后 status.index 非空、含该 record、coverage A=0、无 rebuild 残留。
    const res = await app.request("/api/v1/admin/search/status", { headers: owner() });
    const body = await res.json();
    expect(body.index).not.toBeNull();
    expect(body.index.chunks.records).toBeGreaterThanOrEqual(1);
    expect(body.index.coverage.a).toBe(0);
    expect(body.index.rebuilding).toBe(false);
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes(".rebuild-"));
    expect(leftovers).toEqual([]);
  });

  it("单实体 reindex：202 原地重建（不产生 rebuild 文件）", async () => {
    const res = await app.request("/api/v1/admin/reindex", {
      method: "POST", headers: owner(), body: JSON.stringify({ type: "record", entityId: "s9_r1" }),
    });
    expect(res.status).toBe(202);
    const reindexMod = await import("../../../domain/search/reindex.js");
    await reindexMod.currentReindex();
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".rebuild-"))).toEqual([]);
  });
});
