// M2/S2 鉴权收口端到端（真迁移临时库 + 真 auth/app 路由 + 真 hono/jwt，不 mock auth）。
//
// 覆盖 AC-M2-1 机制与平滑升级：
//  - 存量无 tv claim 的旧 token（用户 ACTIVE/tv0）平滑通过：getUserId、/me、/api/v1/meta 均可用；
//  - DISABLED -> 旧 token 下一次请求 getUserId=null、/me 401、/api/v1/meta 401；
//  - tokenVersion+1（停用/reactivate 同事务 bump）-> 旧 tv token 立即 401，新 tv token 恢复；
//  - INVITED 持合法 token 也被解析核心拒绝（401）；登录 INVITED=403、DISABLED=401；
//  - signup 直接 ACTIVE 且签发 token 带 tv=0；login ACTIVE 200；
//  - 默认 TTL=0（零缓存），状态写库后下一次请求立即生效，无 sleep。
//
// 与 records-keyset 同模式：beforeAll 注入临时 DATABASE_URL/globalThis.__gx_prisma 后动态 import，
// 使 config/db 绑定到临时库。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = "m2-s2-secret-at-least-16-chars";
const TTL = 7 * 24 * 60 * 60;

let tmpDir: string;
let prisma: PrismaClient;
let auth: typeof import("../../../auth.js")["auth"];
let getUserId: typeof import("../../../auth.js")["getUserId"];
let createApp: typeof import("../../../app.js")["createApp"];

async function makeToken(userId: string, tv?: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { userId, iat: now, exp: now + TTL };
  if (tv !== undefined) payload.tv = tv;
  return sign(payload, JWT_SECRET, "HS256");
}

function ctxFor(token: string | null) {
  return { req: { header: (k: string) => (k === "Authorization" && token ? `Bearer ${token}` : undefined) } };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-s2-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s2.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [authMod, appMod] = await Promise.all([
    import("../../../auth.js"),
    import("../../../app.js"),
  ]);
  auth = authMod.auth;
  getUserId = authMod.getUserId;
  createApp = appMod.createApp;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // 仅清业务用户相关（组织角色自举授予随 user cascade 清）；保留 ws_default/系统角色。
  await prisma.roleAssignment.deleteMany({});
  await prisma.deptMember.deleteMany({});
  await prisma.comment.deleteMany({});
  await prisma.member.deleteMany({});
  await prisma.user.deleteMany({});
});

async function createUser(id: string, status: string, tokenVersion = 0, password = "password123") {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: { id, email: `${id}@x.com`, displayName: id, passwordHash, status, tokenVersion, workspaceId: "ws_default" },
  });
}

async function loginRaw(email: string, password: string) {
  const app = new (await import("hono")).Hono().route("/auth", auth);
  return app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

describe("存量无 tv 旧 token 平滑升级（ACTIVE/tv0）", () => {
  it("getUserId、/me、/api/v1/meta 全部可用", async () => {
    await createUser("u1", "ACTIVE", 0);
    const legacy = await makeToken("u1"); // 无 tv claim
    expect(await getUserId(ctxFor(legacy) as never)).toBe("u1");

    const app = new (await import("hono")).Hono().route("/auth", auth);
    const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${legacy}` } });
    expect(me.status).toBe(200);

    const full = createApp().app;
    const meta = await full.request("/api/v1/meta", { headers: { Authorization: `Bearer ${legacy}` } });
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { apiVersion: string; auth: { userId: string; status: string } };
    expect(body.apiVersion).toBe("v1");
    expect(body.auth.userId).toBe("u1");
    expect(body.auth.status).toBe("ACTIVE");
  });
});

describe("AC-M2-1：停用即时失效（默认零缓存）", () => {
  it("DISABLED 后旧 token 下一次请求：getUserId null、/me 401、/v1/meta 401", async () => {
    await createUser("u2", "ACTIVE", 0);
    const legacy = await makeToken("u2");
    expect(await getUserId(ctxFor(legacy) as never)).toBe("u2");

    await prisma.user.update({ where: { id: "u2" }, data: { status: "DISABLED", disabledAt: new Date() } });

    expect(await getUserId(ctxFor(legacy) as never)).toBeNull();
    const app = new (await import("hono")).Hono().route("/auth", auth);
    const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${legacy}` } });
    expect(me.status).toBe(401);
    const full = createApp().app;
    const meta = await full.request("/api/v1/meta", { headers: { Authorization: `Bearer ${legacy}` } });
    expect(meta.status).toBe(401);
  });

  it("tokenVersion+1：旧 tv token 立即 401，带新 tv 的 token 恢复 200", async () => {
    await createUser("u3", "ACTIVE", 1);
    const oldTv0 = await makeToken("u3", 0);
    const newTv1 = await makeToken("u3", 1);
    expect(await getUserId(ctxFor(oldTv0) as never)).toBeNull();
    expect(await getUserId(ctxFor(newTv1) as never)).toBe("u3");
  });

  it("INVITED 即便持有合法 token 也被解析核心拒绝（业务端点 401）", async () => {
    await createUser("u4", "INVITED", 0);
    const tok = await makeToken("u4", 0);
    expect(await getUserId(ctxFor(tok) as never)).toBeNull();
    const full = createApp().app;
    const meta = await full.request("/api/v1/meta", { headers: { Authorization: `Bearer ${tok}` } });
    expect(meta.status).toBe(401);
  });

  it("v1 /meta 无 token 与坏 token -> 401", async () => {
    const full = createApp().app;
    expect((await full.request("/api/v1/meta")).status).toBe(401);
    expect((await full.request("/api/v1/meta", { headers: { Authorization: "Bearer a.b.c" } })).status).toBe(401);
  });
});

describe("登录/注册状态分支", () => {
  it("login：ACTIVE 200；INVITED 403；DISABLED 401；错误口令仍 401", async () => {
    await createUser("ok", "ACTIVE", 0);
    await createUser("inv", "INVITED", 0);
    await createUser("dis", "DISABLED", 0);

    expect((await loginRaw("ok@x.com", "password123")).status).toBe(200);
    expect((await loginRaw("inv@x.com", "password123")).status).toBe(403);
    expect((await loginRaw("dis@x.com", "password123")).status).toBe(401);
    expect((await loginRaw("ok@x.com", "wrongpass")).status).toBe(401);
  });

  it("signup 直接 ACTIVE，签发 token 解码含 tv=0 且可访问 v1", async () => {
    const app = new (await import("hono")).Hono().route("/auth", auth);
    const res = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fresh@x.com", password: "password123", displayName: "Fresh" }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const { verify } = await import("hono/jwt");
    const payload = (await verify(token, JWT_SECRET, "HS256")) as { tv?: number };
    expect(payload.tv).toBe(0);

    const dbUser = await prisma.user.findUnique({ where: { email: "fresh@x.com" } });
    expect(dbUser?.status).toBe("ACTIVE");
    const meta = await createApp().app.request("/api/v1/meta", { headers: { Authorization: `Bearer ${token}` } });
    expect(meta.status).toBe(200);
  });
});

describe("头像路由迁移后仍挂在 /api/auth/me/avatar（契约路径不变）", () => {
  it("未登录 -> 401；ACTIVE 登录 DELETE -> 200；POST 缺 file -> 400", async () => {
    await createUser("av", "ACTIVE", 0);
    const tok = await makeToken("av");
    const full = createApp().app;

    expect((await full.request("/api/auth/me/avatar", { method: "DELETE" })).status).toBe(401);

    const del = await full.request("/api/auth/me/avatar", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { user: { avatarUrl: string | null } };
    expect(body.user.avatarUrl).toBeNull();

    const post = await full.request("/api/auth/me/avatar", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(post.status).toBe(400);
  });
});
