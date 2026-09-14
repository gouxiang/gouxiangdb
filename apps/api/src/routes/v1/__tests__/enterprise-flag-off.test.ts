// M2/S2 + M3/S5 双 flag off 摘除测试（独立文件：config 在模块导入期读 env，
// 需在 import app 之前把开关置 off；vitest 每文件独立模块注册表，互不污染 on 档用例）。
//
// 断言：GX_ENTERPRISE_ORG=off 且 GX_ENTERPRISE_NAV=off 时不挂 /api/v1
// （/api/v1/meta、tree、menu -> 404 走既有 notFound），但旧 /api 行为不变
// （GET /api/health 仍 200）。企业表/nav 表已在库中只是闲置。

const PREV_ORG = process.env.GX_ENTERPRISE_ORG;
const PREV_NAV = process.env.GX_ENTERPRISE_NAV;
process.env.GX_ENTERPRISE_ORG = "off";
process.env.GX_ENTERPRISE_NAV = "off";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

let tmpDir: string;
let prisma: PrismaClient;
let app: import("hono").Hono;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m3-flagoff-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "off.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.JWT_SECRET = "m3-flagoff-secret-16+chars";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const appMod = await import("../../../app.js");
  app = appMod.createApp().app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 还原开关，避免同 worker 后续文件继承 off（vitest 同进程内 process.env 不随文件自动重置）。
  if (PREV_ORG === undefined) delete process.env.GX_ENTERPRISE_ORG;
  else process.env.GX_ENTERPRISE_ORG = PREV_ORG;
  if (PREV_NAV === undefined) delete process.env.GX_ENTERPRISE_NAV;
  else process.env.GX_ENTERPRISE_NAV = PREV_NAV;
});

describe("GX_ENTERPRISE_ORG=off + GX_ENTERPRISE_NAV=off", () => {
  it("不挂载 /api/v1：/api/v1/meta 返回 404（既有 notFound 信封）", async () => {
    const res = await app.request("/api/v1/meta");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_FOUND");
  });

  it("不挂载 /api/v1：tree/menu 同样 404（未带认证也先判路由不存在）", async () => {
    for (const p of [
      "/api/v1/workspaces/current/tree",
      "/api/v1/workspaces/current/menu",
    ]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code, p).toBe("NOT_FOUND");
    }
  });

  it("旧 /api 不受影响：GET /api/health 仍 200", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });
});
