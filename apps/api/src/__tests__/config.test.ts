// apps/api/src/__tests__/config.test.ts
// 配置闸门测试：
//  - validateEnv 纯函数：生产聚合错误、test/dev 全放行、黑名单密钥、相对库路径等
//  - 真子进程启动 src/index.ts：验证 fail-closed 退出码 2 且信息含变量名；
//    NODE_ENV=test 下不退出（保 270 基线的结构性保证）。

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnv } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const tsxCli = path.resolve(
  apiRoot,
  "../../node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs",
);
const entry = path.resolve(apiRoot, "src/index.ts");

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runIndex(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, entry], {
      cwd: apiRoot,
      // 干净环境：排除本机 .env 影响之外，也不继承 JWT_SECRET 等；PATH 保留以运行 node。
      env: { PATH: process.env.PATH ?? "", GX_NO_LISTEN: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("validateEnv 纯函数", () => {
  it("test 环境一律放行（无任何问题）", () => {
    expect(validateEnv({ NODE_ENV: "test" })).toEqual([]);
    expect(validateEnv({ NODE_ENV: "test", JWT_SECRET: "" })).toEqual([]);
  });

  it("development 环境一律放行", () => {
    expect(validateEnv({ NODE_ENV: "development" })).toEqual([]);
    expect(validateEnv({})).toEqual([]);
  });

  it("生产缺 JWT_SECRET / DATABASE_URL / CORS_ORIGIN 一次性聚合报告", () => {
    const issues = validateEnv({ NODE_ENV: "production" });
    const vars = issues.map((i) => i.variable);
    expect(vars).toContain("JWT_SECRET");
    expect(vars).toContain("DATABASE_URL");
    expect(vars).toContain("CORS_ORIGIN");
  });

  it("生产拒绝两个开发默认密钥", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "file:/srv/app.db",
      CORS_ORIGIN: "https://gx.example.com",
    };
    for (const bad of [
      "dev-secret-change-me-in-production",
      "dev-secret-change-in-prod-gouxiangdb-v2",
    ]) {
      const issues = validateEnv({ ...base, JWT_SECRET: bad });
      expect(issues.some((i) => i.variable === "JWT_SECRET")).toBe(true);
    }
  });

  it("生产拒绝短密钥与非 file 连接串与相对路径库", () => {
    const issues = validateEnv({
      NODE_ENV: "production",
      JWT_SECRET: "short",
      DATABASE_URL: "./dev.db",
      CORS_ORIGIN: "https://gx.example.com",
    });
    const vars = issues.map((i) => i.variable);
    expect(vars).toContain("JWT_SECRET");
    expect(vars).toContain("DATABASE_URL");
  });

  it("生产合法配置零问题", () => {
    const issues = validateEnv({
      NODE_ENV: "production",
      JWT_SECRET: "x".repeat(40),
      DATABASE_URL: "file:/var/lib/gouxiangdb/app.db",
      CORS_ORIGIN: "https://gx.example.com,https://www.gx.example.com",
      PORT: "3001",
    });
    expect(issues).toEqual([]);
  });

  it("生产非法端口报错", () => {
    const issues = validateEnv({
      NODE_ENV: "production",
      JWT_SECRET: "x".repeat(40),
      DATABASE_URL: "file:/var/lib/gouxiangdb/app.db",
      CORS_ORIGIN: "https://gx.example.com",
      PORT: "70000",
    });
    expect(issues.some((i) => i.variable === "PORT")).toBe(true);
  });
});

describe("启动闸门（真子进程）", () => {
  it("生产缺 JWT_SECRET：退出码 2，错误含变量名 JWT_SECRET", async () => {
    const r = await runIndex({
      NODE_ENV: "production",
      DATABASE_URL: "file:/var/lib/gouxiangdb/app.db",
      CORS_ORIGIN: "https://gx.example.com",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("JWT_SECRET");
  }, 30000);

  it("生产使用拉黑开发默认值：退出码 2（即使其余配置合法）", async () => {
    const r = await runIndex({
      NODE_ENV: "production",
      JWT_SECRET: "dev-secret-change-in-prod-gouxiangdb-v2",
      DATABASE_URL: "file:/var/lib/gouxiangdb/app.db",
      CORS_ORIGIN: "https://gx.example.com",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("JWT_SECRET");
  }, 30000);

  it("NODE_ENV=test：闸门放行，不退出进程", async () => {
    const r = await runIndex({ NODE_ENV: "test" });
    expect(r.code).toBe(0);
  }, 30000);
}, 60000);
