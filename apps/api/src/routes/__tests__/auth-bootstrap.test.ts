// 0.1.7 公开引导状态与注册开关端到端（真迁移临时库 + 真 createApp + 真 hono/jwt，不 mock）。
//
// 覆盖：
//  ① 空库 GET /api/auth/bootstrap-status -> 200 {initialized:false, signupOpen:false}，
//     且**免鉴权**（无 Authorization 头不 401）、响应体只有两个布尔（不泄漏邮箱/数量）；
//  ② 库里有用户后 initialized=true；
//  ③ 开关关闭（GX_ALLOW_PUBLIC_SIGNUP=off，含未设置的默认值）时 signupOpen=false，非空库 POST signup -> 403
//     code=SIGNUP_CLOSED 且不新增用户；
//  ④ 关闭态**空库仍可注册**（首用户引导必须永远可行）并自举 owner；
//  ⑤ 开关字面量（fail-closed 口径）：未设置/空值/无法识别的值一律关闭；仅显式 on/true/1 开放。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const JWT_SECRET = "bootstrap-status-secret-at-least-16";

let tmpDir: string;
let prisma: PrismaClient;
let app: { request: (url: string, init?: RequestInit) => Promise<Response> };
const prevSignupFlag = process.env.GX_ALLOW_PUBLIC_SIGNUP;

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function setSignupFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.GX_ALLOW_PUBLIC_SIGNUP;
  else process.env.GX_ALLOW_PUBLIC_SIGNUP = value;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-bootstrap-status-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "boot.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const appMod = await import("../../app.js");
  app = appMod.createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  setSignupFlag(prevSignupFlag);
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // 用户与组织授予均清干净（授予行 subjectId 无 FK，须显式清）。
  await prisma.roleAssignment.deleteMany({});
  await prisma.user.deleteMany({});
  setSignupFlag(undefined);
});

afterEach(() => {
  setSignupFlag(undefined);
});

describe("GET /api/auth/bootstrap-status", () => {
  it("① 空库：免鉴权 200，initialized=false / signupOpen=false（未设置即关闭），响应体只有两个布尔", async () => {
    const res = await app.request("/api/auth/bootstrap-status");
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    // 免鉴权：不带任何 Authorization 头也不 401/403（登录/注册同级公开端点）。
    expect(Object.keys(body).sort()).toEqual(["initialized", "signupOpen"]);
    expect(body.initialized).toBe(false);
    expect(body.signupOpen).toBe(false);
    // 绝不泄漏账号信息：整份响应体不含邮箱/数量等任何用户字段。
    expect(JSON.stringify(body)).not.toContain("@");
  });

  it("② 有用户后 initialized=true（仍只有两个布尔，无鉴权要求）", async () => {
    await prisma.user.create({
      data: {
        id: "u-boot",
        email: "boot@example.com",
        displayName: "首个用户",
        passwordHash: "$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    const res = await app.request("/api/auth/bootstrap-status");
    expect(res.status).toBe(200);
    const body = await json<{ initialized: boolean; signupOpen: boolean }>(res);
    expect(body.initialized).toBe(true);
    // 未显式开放 -> 关闭（企业部署口径，fail-closed）。
    expect(body.signupOpen).toBe(false);
    expect(JSON.stringify(body)).not.toContain("boot@example.com");
  });

  it("⑤ fail-closed：未设置/空值/无法识别的值一律关闭，仅显式 on/true/1 开放", async () => {
    for (const closed of ["off", "OFF", " Off ", "false", "FALSE", "0", "", "yes", "open", "opne"]) {
      setSignupFlag(closed);
      const res = await app.request("/api/auth/bootstrap-status");
      const body = await json<{ signupOpen: boolean }>(res);
      expect(body.signupOpen, `GX_ALLOW_PUBLIC_SIGNUP=${JSON.stringify(closed)} 应关闭`).toBe(false);
    }
    for (const open of ["on", "ON", " On ", "1", "true", "TRUE"]) {
      setSignupFlag(open);
      const res = await app.request("/api/auth/bootstrap-status");
      const body = await json<{ signupOpen: boolean }>(res);
      expect(body.signupOpen, `GX_ALLOW_PUBLIC_SIGNUP=${JSON.stringify(open)} 应开放`).toBe(true);
    }
    setSignupFlag(undefined);
    const unset = await json<{ signupOpen: boolean }>(
      await app.request("/api/auth/bootstrap-status"),
    );
    // 未设置 = 关闭：企业部署不应允许自助注册，账号统一由管理员建立或邀请。
    expect(unset.signupOpen).toBe(false);
  });
});

describe("公开注册开关与注册闸门（fail-closed 默认值）", () => {
  it("③ 非空库注册 -> 403 SIGNUP_CLOSED，且不新增用户", async () => {
    await prisma.user.create({
      data: {
        id: "u-exist",
        email: "exist@example.com",
        displayName: "已存在",
        passwordHash: "$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    setSignupFlag("off");

    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "newbie@example.com",
        password: "password123",
        displayName: "新来的",
      }),
    });
    expect(res.status).toBe(403);
    const body = await json<{ error: string; code: string }>(res);
    expect(body.code).toBe("SIGNUP_CLOSED");
    expect(await prisma.user.count()).toBe(1);
  });

  it("④ 关闭态空库仍可注册（首用户引导永不死锁），并自举 workspace owner", async () => {
    setSignupFlag("off");
    const status = await json<{ initialized: boolean; signupOpen: boolean }>(
      await app.request("/api/auth/bootstrap-status"),
    );
    expect(status.initialized).toBe(false);
    expect(status.signupOpen).toBe(false);

    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "first@example.com",
        password: "password123",
        displayName: "首个管理员",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ token: string; user: { id: string } }>(res);
    expect(body.token).toBeTruthy();
    expect(await prisma.user.count()).toBe(1);
    // 首位注册者自举 owner（members.bootstrapFirstOwnerTx，与开关无关）。
    const grants = await prisma.roleAssignment.findMany({
      where: { subjectType: "user", subjectId: body.user.id },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.roleId).toBe("role_owner");
  });

  it("显式开放（GX_ALLOW_PUBLIC_SIGNUP=on）时非空库注册照旧 200（开关未变，仅默认值翻转）", async () => {
    setSignupFlag("on");
    await prisma.user.create({
      data: {
        id: "u-exist2",
        email: "exist2@example.com",
        displayName: "已存在2",
        passwordHash: "$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "second@example.com",
        password: "password123",
        displayName: "第二个",
      }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.user.count()).toBe(2);
  });
});
