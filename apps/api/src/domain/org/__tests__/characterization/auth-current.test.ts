// M2/S0 特征测试（一）：鉴权现状锁（真迁移临时库 + 真 auth 路由 + 真 hono/jwt）。
//
// 目的：在 M2 S1/S2 落地「users.status / tokenVersion + 鉴权查库」之前，先把对
// ACTIVE 用户保持不变的鉴权契约钉死，作为 S2 改造 getUserId 后的逐值回归基线。
//
// 边界纪律：本文件只锁 M2 前后【都成立】的不变量，保证 S1（加列）/S2（查库）后
// 依旧全绿、不产生"由绿转红"：
//   - 无 token / 坏 token -> getUserId=null、/me=401；
//   - signup/login 成功返回 { token, user }，publicUser 字段集合不变（只许加不许减）；
//   - 签发的 JWT 为 HS256、payload 含 userId、exp-iat=7 天；
//   - 一个已存在用户持合法 token，getUserId 解析回该 userId（S2 对 ACTIVE/tv0 等价）。
// "users 当前无 status 列""迁移目录=12"等会在 S1 改变的事实只写入 baseline 文档，
// 不做会翻转的可执行断言；停用/删除用户后 401 的【新】行为在 S2/S6 另写。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { Hono } from "hono";
import { verify } from "hono/jwt";
import { PrismaClient } from "@prisma/client";

const TOKEN_TTL_SEC = 7 * 24 * 60 * 60;
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me-in-production";

let tmpDir: string;
let prisma: PrismaClient;
let auth: typeof import("../../../../auth.js")["auth"];
let getUserId: typeof import("../../../../auth.js")["getUserId"];

function bearer(token: string) {
  return { req: { header: (k: string) => (k === "Authorization" ? `Bearer ${token}` : undefined) } };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-auth-cur-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "a.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  // 公开注册默认 fail-closed（configSignup.ts），关闭态下"重复邮箱"分支根本走不到
  // （非空库先被 403 SIGNUP_CLOSED 拦掉）。本文件锁的是邮箱重复 -> 409 这条契约，
  // 故显式开注册，让该分支可达；关闭态本身另有 auth-state 测试覆盖。
  process.env.GX_ALLOW_PUBLIC_SIGNUP = "on";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const mod = await import("../../../../auth.js");
  auth = mod.auth;
  getUserId = mod.getUserId;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.comment.deleteMany({});
  await prisma.member.deleteMany({});
  await prisma.user.deleteMany({});
});

async function signup(email: string, password = "password123", displayName = "U") {
  const app = new Hono().route("/auth", auth);
  const res = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  return res;
}

async function login(email: string, password = "password123") {
  const app = new Hono().route("/auth", auth);
  return app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

describe("getUserId 现状（验签形态）", () => {
  it("无 Authorization 头 -> null", async () => {
    const c = { req: { header: () => undefined } };
    expect(await getUserId(c as never)).toBeNull();
  });

  it("非 Bearer / 空 token -> null", async () => {
    const c = { req: { header: () => "Basic abc" } };
    expect(await getUserId(c as never)).toBeNull();
  });

  it("坏签名 token -> null（不抛错）", async () => {
    const c = bearer("aaa.bbb.ccc");
    expect(await getUserId(c as never)).toBeNull();
  });

  it("已存在用户持合法登录 token -> 解析回 userId（S2 对 ACTIVE/tv0 必须等价）", async () => {
    const res = await signup("alice@example.com");
    const { token, user } = (await res.json()) as { token: string; user: { id: string } };
    expect(await getUserId(bearer(token) as never)).toBe(user.id);
  });
});

describe("JWT 签发形态", () => {
  it("HS256、payload 含 userId、有效期 7 天", async () => {
    const res = await signup("bob@example.com");
    const { token } = (await res.json()) as { token: string };
    const payload = await verify(token, JWT_SECRET, "HS256");
    expect(payload.userId).toEqual(expect.any(String));
    expect(Number(payload.exp) - Number(payload.iat)).toBe(TOKEN_TTL_SEC);
  });
});

describe("signup / login 响应契约（字段只许增不许减）", () => {
  // 只许加不许减：迁移 #24（users.mustChangePassword）后 publicUser 增加该键，
  // 属"加"而非契约破坏，故同步入基线集合（移除/改名即红）。
  const PUBLIC_USER_KEYS = [
    "avatarUrl", "bio", "createdAt", "displayName", "email", "id",
    "mustChangePassword", "phone", "updatedAt", "username",
  ].sort();

  it("signup -> 200 { token, user }，publicUser 键集合不变", async () => {
    const res = await signup("carol@example.com", "password123", "Carol");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: Record<string, unknown> };
    expect(typeof body.token).toBe("string");
    expect(Object.keys(body.user).sort()).toEqual(PUBLIC_USER_KEYS);
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.user.email).toBe("carol@example.com");
  });

  it("login 正确口令 -> 200 { token, user }；错误口令 -> 401；未知邮箱 -> 401", async () => {
    await signup("dave@example.com", "password123", "Dave");
    const ok = await login("dave@example.com", "password123");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; user: Record<string, unknown> };
    expect(typeof body.token).toBe("string");
    expect(Object.keys(body.user).sort()).toEqual(PUBLIC_USER_KEYS);

    const bad = await login("dave@example.com", "wrong-password");
    expect(bad.status).toBe(401);
    const ghost = await login("ghost@example.com", "password123");
    expect(ghost.status).toBe(401);
  });

  it("signup 非法输入 -> 400；重复邮箱 -> 409", async () => {
    const first = await signup("eve@example.com", "short", "Eve");
    expect(first.status).toBe(400);
    await signup("frank@example.com");
    const dup = await signup("frank@example.com");
    expect(dup.status).toBe(409);
  });
});

describe("GET /auth/me 现状", () => {
  it("无 token -> 401；坏 token -> 401", async () => {
    const app = new Hono().route("/auth", auth);
    const none = await app.request("/auth/me");
    expect(none.status).toBe(401);
    const bad = await app.request("/auth/me", { headers: { Authorization: "Bearer x.y.z" } });
    expect(bad.status).toBe(401);
  });

  it("合法 token 且用户存在 -> 200 返回 publicUser", async () => {
    const signed = await signup("gina@example.com");
    const { token } = (await signed.json()) as { token: string };
    const app = new Hono().route("/auth", auth);
    const res = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe("gina@example.com");
  });
});
