// 首次部署超级管理员初始化领域层测试（真迁移临时库；凭据解析为纯函数用例，不发请求）。
//
// 与 last-owner-bypass.test.ts 同一套建库/迁移/注入方式：先注入临时 DATABASE_URL 与
// globalThis.__gx_prisma，再动态 import（静态 import 会在 beforeAll 前 new client 绑错库）。
//
// 覆盖：
//  ① 空库首次调用 -> created，且落库 mustChangePassword=true / status=ACTIVE / owner 授予行存在；
//  ② 幂等：紧接着第二次调用 -> skipped 且 user.count() 仍为 1（绝不重复创建）；
//  ③ 已有任意用户（无 owner 授予）的库直接调用 -> skipped；
//  ④ 凭据解析纯函数：production 缺凭据 -> ok=false（对应 exit 64）；非 production 回落默认值；
//     命令行参数优先于环境变量；密码长度非法 -> ok=false。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

type InitAdminMod = typeof import("../initAdmin.js");
type RolesMod = typeof import("../roles.js");

let mod: InitAdminMod;
let OWNER_ROLE_ID: string;
let tmpDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-init-admin-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "init.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  mod = await import("../initAdmin.js");
  OWNER_ROLE_ID = (await import("../roles.js") as RolesMod).OWNER_ROLE_ID;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("initAdmin 建号与幂等", () => {
  it("① 空库首次调用 -> created，落库 ACTIVE + 强制改密 + owner 授予行", async () => {
    const result = await mod.initAdmin(
      { email: "Admin@Init.Local", password: "init12345", displayName: "测试管理员" },
      prisma,
    );
    expect(result.status).toBe("created");
    expect(result.userId).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId! } });
    // 邮箱归一化小写、状态 ACTIVE、强制改密闸门打开、归属默认工作区。
    expect(user.email).toBe("admin@init.local");
    expect(user.status).toBe("ACTIVE");
    expect(user.mustChangePassword).toBe(true);
    expect(user.workspaceId).toBe("ws_default");
    // 密码确实以 bcrypt 摘要存储（不落明文），且能与原密码比对通过。
    expect(user.passwordHash).not.toBe("init12345");
    expect(user.passwordHash.startsWith("$2")).toBe(true);

    const grants = await prisma.roleAssignment.findMany({
      where: { subjectType: "user", subjectId: result.userId! },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].roleId).toBe(OWNER_ROLE_ID);
    expect(grants[0].createdBy).toBe("system-init-admin");
  });

  it("② 幂等：紧接着第二次调用 -> skipped，且用户数仍为 1", async () => {
    const result = await mod.initAdmin(
      { email: "other@init.local", password: "init12345", displayName: "另一次" },
      prisma,
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("已有 1 个用户");
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.roleAssignment.count({ where: { roleId: OWNER_ROLE_ID } })).toBe(1);
  });

  it("③ 已有任意用户（无 owner 授予）的库 -> skipped，不为它补授 owner", async () => {
    await prisma.user.create({
      data: {
        id: "u-plain",
        email: "plain@init.local",
        displayName: "普通用户",
        passwordHash: "$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "ACTIVE",
        workspaceId: "ws_default",
      },
    });
    expect(await prisma.roleAssignment.count({ where: { roleId: OWNER_ROLE_ID } })).toBe(1);

    const result = await mod.initAdmin(
      { email: "third@init.local", password: "init12345", displayName: "第三个" },
      prisma,
    );
    expect(result.status).toBe("skipped");
    expect(await prisma.user.count()).toBe(2);
    // 未新增授予：跳过时绝不触碰 role_assignments。
    expect(await prisma.roleAssignment.count({ where: { roleId: OWNER_ROLE_ID } })).toBe(1);
  });
});

describe("resolveInitAdminCredentials 纯函数", () => {
  it("④a 生产环境未提供凭据 -> ok=false（调用方 exit 64），且不带默认口令", () => {
    const r = mod.resolveInitAdminCredentials({ NODE_ENV: "production" }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual(["email", "password"]);
      expect(r.reason).toContain("生产环境");
    }
  });

  it("④b 生产环境只给 email 仍判缺失 password", () => {
    const r = mod.resolveInitAdminCredentials(
      { NODE_ENV: "production", GX_INIT_ADMIN_EMAIL: "a@b.com" },
      ["--password", "prodpass123"],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.email).toBe("a@b.com");
      expect(r.input.password).toBe("prodpass123");
      expect(r.source.email).toBe("env");
      expect(r.source.password).toBe("argv");
    }

    const missingPwd = mod.resolveInitAdminCredentials(
      { NODE_ENV: "production", GX_INIT_ADMIN_EMAIL: "a@b.com" },
      [],
    );
    expect(missingPwd.ok).toBe(false);
    if (!missingPwd.ok) expect(missingPwd.missing).toEqual(["password"]);
  });

  it("④c 非 production 未配置 -> 回落本地默认值", () => {
    const r = mod.resolveInitAdminCredentials({ NODE_ENV: "development" }, []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.email).toBe("admin@gouxiang.local");
      expect(r.input.password).toBe("admin12345");
      expect(r.input.displayName).toBe("超级管理员");
      expect(r.source.email).toBe("default");
    }
  });

  it("④d 命令行参数优先于环境变量（--email=x 与 --email x 两种写法）", () => {
    const env = {
      NODE_ENV: "test",
      GX_INIT_ADMIN_EMAIL: "env@example.com",
      GX_INIT_ADMIN_PASSWORD: "envpass123",
      GX_INIT_ADMIN_NAME: "env昵称",
    };
    const eq = mod.resolveInitAdminCredentials(env, ["--email=argv@example.com", "--password=argvpass123"]);
    expect(eq.ok).toBe(true);
    if (eq.ok) {
      expect(eq.input.email).toBe("argv@example.com");
      expect(eq.input.password).toBe("argvpass123");
      expect(eq.input.displayName).toBe("env昵称"); // 名字未用参数 -> 取环境变量
      expect(eq.source.email).toBe("argv");
    }

    const sp = mod.resolveInitAdminCredentials(env, ["--email", "argv2@example.com", "--name", "参数昵称"]);
    expect(sp.ok).toBe(true);
    if (sp.ok) {
      expect(sp.input.email).toBe("argv2@example.com");
      expect(sp.input.password).toBe("envpass123");
      expect(sp.input.displayName).toBe("参数昵称");
    }
  });

  it("④e 邮箱格式/密码长度非法 -> ok=false（调用方 exit 64）", () => {
    const badEmail = mod.resolveInitAdminCredentials(
      { NODE_ENV: "test" },
      ["--email", "not-an-email", "--password", "init12345"],
    );
    expect(badEmail.ok).toBe(false);
    if (!badEmail.ok) expect(badEmail.reason).toContain("邮箱格式不正确");

    const shortPwd = mod.resolveInitAdminCredentials(
      { NODE_ENV: "test" },
      ["--email", "a@b.com", "--password", "123"],
    );
    expect(shortPwd.ok).toBe(false);
    if (!shortPwd.ok) expect(shortPwd.reason).toContain("初始密码长度");

    const longPwd = mod.resolveInitAdminCredentials(
      { NODE_ENV: "test" },
      ["--email", "a@b.com", "--password", "x".repeat(73)],
    );
    expect(longPwd.ok).toBe(false);
  });
});

describe("initAdmin 防御", () => {
  it("邮箱/密码非法时抛 InitAdminError 且 exitCode=64", async () => {
    await expect(
      mod.initAdmin({ email: "bad", password: "init12345", displayName: "x" }, prisma),
    ).rejects.toMatchObject({ name: "InitAdminError", exitCode: 64 });
    await expect(
      mod.initAdmin({ email: "a@b.com", password: "123", displayName: "x" }, prisma),
    ).rejects.toMatchObject({ name: "InitAdminError", exitCode: 64 });
  });

  it("maskInitAdminEmail 保留首字符与域名", () => {
    expect(mod.maskInitAdminEmail("admin@example.com")).toBe("a***@example.com");
    expect(mod.maskInitAdminEmail("nodot")).toBe("***");
  });
});
