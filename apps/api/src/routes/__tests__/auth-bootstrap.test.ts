// 公开引导状态与注册开关端到端（真迁移临时库 + 真 createApp + 真 hono/jwt，不 mock）。
//
// 有效态（0.2.4）：signupOpen = env GX_ALLOW_PUBLIC_SIGNUP 显式开放 OR 后台 KV
// auth.public_signup="on"；两者皆缺=关闭（默认，与历史一致）；空库首账号自举永远放行。
//
// 覆盖：
//  ① 空库 GET /api/auth/bootstrap-status -> 200 {initialized:false, signupOpen:false}，
//     且**免鉴权**（无 Authorization 头不 401）、响应体只有两个布尔（不泄漏邮箱/数量）；
//  ② 库里有用户后 initialized=true；
//  ③ 关闭（env 未设/off + KV 缺行/off）时 signupOpen=false，非空库 POST signup -> 403
//     code=SIGNUP_CLOSED 且不新增用户；
//  ④ 关闭态**空库仍可注册**（首用户引导必须永远可行）并自举 owner；
//  ⑤ env 开关字面量（fail-closed 口径）：未设置/空值/无法识别的值一律关闭；仅显式 on/true/1 开放；
//  ⑥ KV 开关：KV "on" 非空库注册 200/bootstrap signupOpen=true；KV 只认 on（"true"/"1" 关闭）；
//     env=on 即便 KV 缺行也开放（运维旁路）；每测后清 env 与 KV 行防串测。

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

/** 写后台注册开关 KV 行（auth.public_signup），模拟管理员 PATCH 品牌外观设置。 */
async function setKvSignup(value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { k: "auth.public_signup" },
    create: { k: "auth.public_signup", v: value },
    update: { v: value },
  });
}

async function createSeedUser(id: string, email: string): Promise<void> {
  await prisma.user.create({
    data: {
      id,
      email,
      displayName: "已存在",
      passwordHash: "$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
}

function signupRequest(email: string): Promise<Response> {
  return app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", displayName: "新来的" }),
  });
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
  // 后台注册开关 KV 行也清掉（各测显式 upsert，避免串测）。
  await prisma.appSetting.deleteMany({ where: { k: "auth.public_signup" } });
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

describe("后台 KV 开关 auth.public_signup（与 env 取或）", () => {
  it("⑥a KV=on、env 缺省：非空库 signup 200 且不新增以外行为正常；bootstrap signupOpen=true", async () => {
    await setKvSignup("on");
    await createSeedUser("u-kv-exist", "kv-exist@example.com");

    const status = await json<{ initialized: boolean; signupOpen: boolean }>(
      await app.request("/api/auth/bootstrap-status"),
    );
    expect(status.initialized).toBe(true);
    expect(status.signupOpen).toBe(true);

    const res = await signupRequest("kv-newbie@example.com");
    expect(res.status).toBe(200);
    expect(await prisma.user.count()).toBe(2);
  });

  it("⑥b KV=off 显式行 + env 缺省：非空库 403 SIGNUP_CLOSED（off 与缺行同口径）", async () => {
    await setKvSignup("off");
    await createSeedUser("u-kv-off", "kv-off@example.com");

    const status = await json<{ signupOpen: boolean }>(
      await app.request("/api/auth/bootstrap-status"),
    );
    expect(status.signupOpen).toBe(false);

    const res = await signupRequest("kv-denied@example.com");
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("SIGNUP_CLOSED");
    expect(await prisma.user.count()).toBe(1);
  });

  it("⑥c KV 只认 on：true/1/ON 大小写处理——非 on 字面量一律关闭", async () => {
    await createSeedUser("u-kv-lit", "kv-lit@example.com");
    const closedValues = ["true", "1", "yes", " onn", "opn"];
    for (const [i, v] of closedValues.entries()) {
      await setKvSignup(v);
      const status = await json<{ signupOpen: boolean }>(
        await app.request("/api/auth/bootstrap-status"),
      );
      expect(status.signupOpen, `KV=${JSON.stringify(v)} 应关闭`).toBe(false);
      // 邮箱不能带入 KV 字面量（含空白会先撞 email 校验 400），用序号造合法地址。
      const res = await signupRequest(`kv-lit-${i}@example.com`);
      expect(res.status, `KV=${JSON.stringify(v)} 非空库应 403`).toBe(403);
    }
    // 大小写/空白宽容仅对 on 本身（store 侧 trim+lowercase）。
    for (const v of ["ON", " On "]) {
      await setKvSignup(v);
      const status = await json<{ signupOpen: boolean }>(
        await app.request("/api/auth/bootstrap-status"),
      );
      expect(status.signupOpen, `KV=${JSON.stringify(v)} 应开放`).toBe(true);
    }
    expect(await prisma.user.count()).toBe(1); // 关闭态尝试全部没落号
  });

  it("⑥d env=on 即便 KV 缺行也开放（运维强制旁路；开放态不被后台关闭压过）", async () => {
    setSignupFlag("on");
    await createSeedUser("u-env-exist", "env-exist@example.com");
    // beforeEach 已删 KV 行：env 单独成立。
    const res = await signupRequest("env-newbie@example.com");
    expect(res.status).toBe(200);
    expect(await prisma.user.count()).toBe(2);

    // KV 显式 off 也压不过 env=on。
    await setKvSignup("off");
    const res2 = await signupRequest("env-newbie2@example.com");
    expect(res2.status).toBe(200);
    expect(await prisma.user.count()).toBe(3);
  });

  it("⑥e KV=on 时空库首注册照常自举 owner（开关不影响自举路径）", async () => {
    await setKvSignup("on");
    const res = await signupRequest("kv-first@example.com");
    expect(res.status).toBe(200);
    const body = await json<{ user: { id: string } }>(res);
    const grants = await prisma.roleAssignment.findMany({
      where: { subjectType: "user", subjectId: body.user.id },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.roleId).toBe("role_owner");
  });
});
