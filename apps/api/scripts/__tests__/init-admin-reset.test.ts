// 0.1.7 init-admin --reset【CLI 真 spawn】三分支验收（exit 0 / 65 / 64）。
//
// 为什么必须真 spawn：退出码语义（64 用法缺凭据 / 65 查无此人 / 0 成功）只存在于 CLI 外壳
// （scripts/init-admin.ts 的 main → process.exit），领域层测试覆盖不到。做法与
// src/mcp/transport/__tests__/m6-s6-stdio.test.ts 同款：spawn tsx 跑脚本源码，真临时库落库。
//
// 覆盖：
//  ① 命中 -> exit 0，落库新口令可用 + mustChangePassword=true + tokenVersion+1，
//     且审计 audit.logl 落 admin_password_reset（脱敏邮箱，无密码明文）；
//  ② 邮箱查无此人 -> exit 65 且 stderr 有明确错误，库内用户数/口令不变；
//  ③ 缺 GX_INIT_ADMIN_EMAIL 或 GX_INIT_ADMIN_PASSWORD -> exit 64（不回落默认口令）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// __tests__ -> scripts -> apps/api
const API_ROOT = path.resolve(HERE, "../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");

const EMAIL = "cli@reset.local";
const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";

let tmpDir: string;
let prisma: PrismaClient;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `file:${path.join(tmpDir, "cli.db")}`,
    NODE_ENV: "test",
    GX_DATA_DIR: tmpDir,
    GX_AUDIT_DIR: path.join(tmpDir, ".audit"),
    GX_RATE_LIMIT: "off",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
}

async function runCli(
  args: readonly string[],
  overrides: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const child = spawn(process.execPath, [TSX_CLI, "scripts/init-admin.ts", ...args], {
    cwd: API_ROOT,
    env: childEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", (c) => resolve(c));
  });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-init-admin-cli-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "cli.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: API_ROOT,
    stdio: "ignore",
    env: process.env,
  });
  prisma = new PrismaClient();
  await prisma.user.create({
    data: {
      id: "u-cli",
      email: EMAIL,
      displayName: "待重置管理员",
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 10),
      status: "ACTIVE",
      tokenVersion: 0,
      workspaceId: "ws_default",
    },
  });
  await prisma.$disconnect();
}, 120000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function readUser(): Promise<{
  passwordHash: string;
  mustChangePassword: boolean;
  tokenVersion: number;
  status: string;
}> {
  const p = new PrismaClient();
  try {
    return await p.user.findUniqueOrThrow({
      where: { email: EMAIL },
      select: {
        passwordHash: true,
        mustChangePassword: true,
        tokenVersion: true,
        status: true,
      },
    });
  } finally {
    await p.$disconnect();
  }
}

describe("init-admin --reset 三分支（真 spawn）", () => {
  it("① 命中 -> exit 0，口令/强制改密/tokenVersion 全部生效，且落 admin_password_reset 审计", async () => {
    const res = await runCli(["--reset"], {
      GX_INIT_ADMIN_EMAIL: EMAIL,
      GX_INIT_ADMIN_PASSWORD: NEW_PASSWORD,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("已重置");

    const after = await readUser();
    await expect(bcrypt.compare(NEW_PASSWORD, after.passwordHash)).resolves.toBe(true);
    await expect(bcrypt.compare(OLD_PASSWORD, after.passwordHash)).resolves.toBe(false);
    expect(after.mustChangePassword).toBe(true);
    expect(after.tokenVersion).toBe(1);
    expect(after.status).toBe("ACTIVE");

    // 审计留痕：事件名 + 脱敏邮箱，且整行不含新密码明文。
    const logPath = path.join(tmpDir, ".audit", "audit.logl");
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const hit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "admin_password_reset");
    expect(hit).toBeTruthy();
    expect(hit.detail.emailMasked).toBe("c***@reset.local");
    expect(lines.join("\n")).not.toContain(NEW_PASSWORD);
  }, 120000);

  it("② 邮箱查无此人 -> exit 65，库内口令不变", async () => {
    const before = await readUser();
    const res = await runCli(["--reset"], {
      GX_INIT_ADMIN_EMAIL: "ghost@reset.local",
      GX_INIT_ADMIN_PASSWORD: NEW_PASSWORD,
    });
    expect(res.code).toBe(65);
    expect(res.stderr).toContain("未找到该邮箱对应的账号");

    const after = await readUser();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
  }, 120000);

  it("③ 缺凭据（缺 password / 缺 email / 两者都缺）-> exit 64，且不回落默认口令", async () => {
    const before = await readUser();
    const noPwd = await runCli(["--reset"], { GX_INIT_ADMIN_EMAIL: EMAIL, GX_INIT_ADMIN_PASSWORD: undefined });
    expect(noPwd.code).toBe(64);
    expect(noPwd.stderr).toContain("缺少管理员凭据");
    expect(noPwd.stderr).toContain("password");

    const noMail = await runCli(["--reset"], { GX_INIT_ADMIN_EMAIL: undefined, GX_INIT_ADMIN_PASSWORD: NEW_PASSWORD });
    expect(noMail.code).toBe(64);
    expect(noMail.stderr).toContain("email");

    const none = await runCli(["--reset"], { GX_INIT_ADMIN_EMAIL: undefined, GX_INIT_ADMIN_PASSWORD: undefined });
    expect(none.code).toBe(64);

    const after = await readUser();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
  }, 120000);
});
