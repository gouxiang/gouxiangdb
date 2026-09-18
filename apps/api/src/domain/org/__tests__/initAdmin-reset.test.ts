// 0.1.7 init-admin --reset 领域层测试（真迁移临时库；凭据解析为纯函数用例）。
//
// 与 initAdmin.test.ts 同一套建库/迁移/注入方式（先注入临时 DATABASE_URL 与
// globalThis.__gx_prisma，再动态 import）。
//
// 覆盖：
//  ① 按邮箱命中 -> reset，落库新口令可用/旧口令失效 + mustChangePassword=true + tv+1，
//     且不新增用户、不新增角色授予（只重置不建号、不改权限）；
//  ② 邮箱大小写不敏感（库里 Admin@Case.Local，用 admin@case.local 也能命中）；
//  ③ 停用账号（DISABLED + disabledAt）重置后恢复 ACTIVE、disabledAt 清空；
//  ④ 查无此人 -> InitAdminError exitCode=65（外壳据此 exit 65），且不建号；
//  ⑤ 凭据解析纯函数：缺 email/password -> ok=false（不回落本地默认口令）；
//     命令行参数优先于环境变量；邮箱/口令非法 -> ok=false。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

type ResetMod = typeof import("../initAdminReset.js");
type InitMod = typeof import("../initAdmin.js");

let mod: ResetMod;
let initMod: InitMod;
let tmpDir: string;
let prisma: PrismaClient;

const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";

async function seedUser(
  id: string,
  email: string,
  opts: { status?: string; disabledAt?: Date | null; tokenVersion?: number } = {},
): Promise<void> {
  await prisma.user.create({
    data: {
      id,
      email,
      displayName: `昵称-${id}`,
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 10),
      status: opts.status ?? "ACTIVE",
      disabledAt: opts.disabledAt ?? null,
      tokenVersion: opts.tokenVersion ?? 0,
      workspaceId: "ws_default",
    },
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-init-admin-reset-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "reset.db")}`;
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
  mod = await import("../initAdminReset.js");
  initMod = await import("../initAdmin.js");
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.roleAssignment.deleteMany({});
  await prisma.user.deleteMany({});
});

describe("resetAdminPassword 命中", () => {
  it("① 改密生效 + 强制改密 + tokenVersion+1，且不建号不改权限", async () => {
    await seedUser("u-reset", "admin@reset.local", { tokenVersion: 3 });
    await prisma.roleAssignment.create({
      data: {
        roleId: "role_owner",
        subjectType: "user",
        subjectId: "u-reset",
        scopeType: "workspace",
        createdBy: "system-init-admin",
      },
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: "u-reset" } });

    const result = await mod.resetAdminPassword(
      { email: "admin@reset.local", password: NEW_PASSWORD },
      prisma,
    );
    expect(result.status).toBe("reset");
    expect(result.userId).toBe("u-reset");
    expect(result.tokenVersion).toBe(4);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: "u-reset" } });
    expect(after.passwordHash).not.toBe(before.passwordHash);
    // 新密码可用、旧密码立即失效（重置的唯一目的就是"换一把能进去的钥匙"）。
    await expect(bcrypt.compare(NEW_PASSWORD, after.passwordHash)).resolves.toBe(true);
    await expect(bcrypt.compare(OLD_PASSWORD, after.passwordHash)).resolves.toBe(false);
    expect(after.mustChangePassword).toBe(true);
    expect(after.status).toBe("ACTIVE");
    // 单事务：只重置不建号、不新增/不动角色授予。
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.roleAssignment.count()).toBe(1);
  });

  it("② 邮箱大小写不敏感（库内大写 -> 用小写也能命中）", async () => {
    await seedUser("u-case", "Admin@Case.Local");
    const result = await mod.resetAdminPassword(
      { email: "admin@case.local", password: NEW_PASSWORD },
      prisma,
    );
    expect(result.userId).toBe("u-case");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: "u-case" } });
    await expect(bcrypt.compare(NEW_PASSWORD, after.passwordHash)).resolves.toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });

  it("③ 停用账号重置后恢复 ACTIVE 且 disabledAt 清空", async () => {
    await seedUser("u-disabled", "disabled@reset.local", {
      status: "DISABLED",
      disabledAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await mod.resetAdminPassword(
      { email: "disabled@reset.local", password: NEW_PASSWORD },
      prisma,
    );
    expect(result.status).toBe("reset");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: "u-disabled" } });
    expect(after.status).toBe("ACTIVE");
    expect(after.disabledAt).toBeNull();
    expect(after.mustChangePassword).toBe(true);
  });
});

describe("resetAdminPassword 查无此人", () => {
  it("④ 抛 InitAdminError 且 exitCode=65，绝不建号", async () => {
    await seedUser("u-only", "only@reset.local");
    await expect(
      mod.resetAdminPassword({ email: "ghost@reset.local", password: NEW_PASSWORD }, prisma),
    ).rejects.toMatchObject({ name: "InitAdminError", exitCode: 65 });
    // 空库同样 65：--reset 只重置，不代劳建号。
    await prisma.user.deleteMany({});
    await expect(
      mod.resetAdminPassword({ email: "ghost@reset.local", password: NEW_PASSWORD }, prisma),
    ).rejects.toMatchObject({ name: "InitAdminError", exitCode: 65 });
    expect(await prisma.user.count()).toBe(0);
  });

  it("邮箱/口令非法时抛 exitCode=64（与建号路径同口径）", async () => {
    await expect(
      mod.resetAdminPassword({ email: "not-an-email", password: NEW_PASSWORD }, prisma),
    ).rejects.toMatchObject({ name: "InitAdminError", exitCode: 64 });
    await expect(
      mod.resetAdminPassword({ email: "a@reset.local", password: "123" }, prisma),
    ).rejects.toMatchObject({ name: "InitAdminError", exitCode: 64 });
  });
});

describe("resolveResetAdminCredentials 纯函数", () => {
  it("⑤a 缺 email / 缺 password / 两者都缺 -> ok=false（不回落本地默认口令）", () => {
    const none = mod.resolveResetAdminCredentials({ NODE_ENV: "test" }, []);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.missing).toEqual(["email", "password"]);

    const noPwd = mod.resolveResetAdminCredentials(
      { NODE_ENV: "test", GX_INIT_ADMIN_EMAIL: "a@reset.local" },
      [],
    );
    expect(noPwd.ok).toBe(false);
    if (!noPwd.ok) expect(noPwd.missing).toEqual(["password"]);

    const noMail = mod.resolveResetAdminCredentials(
      { NODE_ENV: "test", GX_INIT_ADMIN_PASSWORD: "envpass123" },
      [],
    );
    expect(noMail.ok).toBe(false);
    if (!noMail.ok) expect(noMail.missing).toEqual(["email"]);

    // 关键：非 production 也不得套用 initAdmin 的默认口令（admin@gouxiang.local/admin12345）。
    const nonProd = mod.resolveResetAdminCredentials({ NODE_ENV: "development" }, ["--reset"]);
    expect(nonProd.ok).toBe(false);
    if (!nonProd.ok) {
      expect(nonProd.reason).not.toContain("admin@gouxiang.local");
      expect(nonProd.reason).toContain("--reset");
    }
  });

  it("⑤b 环境变量提供 -> ok，命令行参数优先（--email=x 与 --email x 两种写法）", () => {
    const env = {
      NODE_ENV: "test",
      GX_INIT_ADMIN_EMAIL: "env@reset.local",
      GX_INIT_ADMIN_PASSWORD: "envpass123",
    };
    const fromEnv = mod.resolveResetAdminCredentials(env, ["--reset"]);
    expect(fromEnv.ok).toBe(true);
    if (fromEnv.ok) {
      expect(fromEnv.input).toEqual({ email: "env@reset.local", password: "envpass123" });
      expect(fromEnv.source).toEqual({ email: "env", password: "env" });
    }
    const fromArgv = mod.resolveResetAdminCredentials(env, [
      "--reset",
      "--email=argv@reset.local",
      "--password",
      "argvpass123",
    ]);
    expect(fromArgv.ok).toBe(true);
    if (fromArgv.ok) {
      expect(fromArgv.input).toEqual({ email: "argv@reset.local", password: "argvpass123" });
      expect(fromArgv.source).toEqual({ email: "argv", password: "argv" });
    }
  });

  it("⑤c 邮箱格式 / 口令长度非法 -> ok=false（调用方 exit 64）", () => {
    const badEmail = mod.resolveResetAdminCredentials(
      { NODE_ENV: "test" },
      ["--email", "nope", "--password", "envpass123"],
    );
    expect(badEmail.ok).toBe(false);
    if (!badEmail.ok) expect(badEmail.reason).toContain("邮箱格式不正确");

    const shortPwd = mod.resolveResetAdminCredentials(
      { NODE_ENV: "test" },
      ["--email", "a@reset.local", "--password", "123"],
    );
    expect(shortPwd.ok).toBe(false);
    if (!shortPwd.ok) expect(shortPwd.reason).toContain("初始密码长度");
  });
});

describe("--reset 与建号路径互不串台", () => {
  it("⑥ reset 不会把 initAdmin 的建号幂等判定顶掉：带 --reset 解析出的凭据仍走 reset 语义", async () => {
    // 空库上 initAdmin 会建号（created），而 --reset 必须 65——两者语义互不相同，
    // 此处只断言领域层不共享状态：reset 失败后 initAdmin 仍照常建号。
    await expect(
      mod.resetAdminPassword({ email: "nobody@reset.local", password: NEW_PASSWORD }, prisma),
    ).rejects.toMatchObject({ exitCode: 65 });
    const created = await initMod.initAdmin(
      { email: "nobody@reset.local", password: NEW_PASSWORD, displayName: "首个" },
      prisma,
    );
    expect(created.status).toBe("created");
    // 建完之后再 reset 就命中了（同一邮箱）。
    const reset = await mod.resetAdminPassword(
      { email: "nobody@reset.local", password: "another-pass-789" },
      prisma,
    );
    expect(reset.status).toBe("reset");
    expect(await prisma.user.count()).toBe(1);
  });
});
