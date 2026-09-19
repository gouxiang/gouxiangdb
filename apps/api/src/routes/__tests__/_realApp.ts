// 共享「真迁移临时库 + 真 Hono records 路由」夹具（仅 mock JWT getUserId）。
// RC-09 CSV 行级事务 / RC-12 软删硬删级联 / RC-35 反向默认值重算三处 HTTP 对抗测试复用。
//
// 纪律：db/guards/records 依赖 db.ts 单例，必须在设置 globalThis.__gx_prisma 之后【动态 import】，
// 故 buildApp() 在 setupHarness() 完成后调用。身份固定为 owner：调用方测试文件须在顶部 hoist：
//   vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve("u1") }));
// （vi.mock 按模块路径全局生效，放测试文件而非本夹具，保证在任何 import 前提升。）

import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export const OWNER_ID = "u1";

export interface Harness {
  tmpDir: string;
  prisma: PrismaClient;
  request: (method: string, url: string, body?: unknown) => ReturnType<Hono["request"]>;
  /** 新建一个 Base 并把固定身份 u1 加为 owner（权限守卫查 members 行）。 */
  makeBase: (name?: string) => Promise<string>;
  makeTable: (baseId: string, name: string) => Promise<{ id: string; primaryFieldId: string }>;
  /** 新建一个知识库并把固定身份 u1 加为 owner（kb 守卫查 kb_members 行）。 */
  makeKb: (name?: string) => Promise<string>;
  teardown: () => Promise<void>;
}

/**
 * 挂载哪一组路由：
 *   "records"（默认）—— records + fields，供 RC-09/RC-12/RC-35 复用；
 *   "entities"        —— bases + tables + kb，供实体自定义图标（icon/iconColor）契约测试用。
 */
export type HarnessRoutes = "records" | "entities";

export async function setupHarness(prefix: string, routes: HarnessRoutes = "records"): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  // 关闭 sidecar 读写：本夹具只验证记录写事务/级联/默认值，不引入派生索引 DDL 与噪声。
  process.env.GX_M1_SIDECAR = "off";
  process.env.GX_M1_SIDECAR_READ = "off";
  delete process.env.GX_M1_KEYSET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });

  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({
    data: { id: OWNER_ID, email: "u1@example.com", displayName: "U1", passwordHash: "x" },
  });

  // 动态 import：各路由此刻才解析 db.ts 单例（= 上面注入的 prisma）。
  const guardsMod = await import("../../guards.js");
  const app = new Hono();
  if (routes === "entities") {
    const [basesMod, tablesMod, kbMod] = await Promise.all([
      import("../bases.js"),
      import("../tables.js"),
      import("../kb/index.js"),
    ]);
    app.route("/bases", basesMod.bases);
    app.route("/tables", tablesMod.tables);
    app.route("/kb", kbMod.kb);
  } else {
    const [recordsMod, fieldsMod] = await Promise.all([
      import("../records.js"),
      import("../fields.js"),
    ]);
    app.route("/records", recordsMod.records);
    app.route("/fields", fieldsMod.fields);
  }
  app.onError((err, c) => guardsMod.errorResponse(c, err));

  const request: Harness["request"] = (method, url, body) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return app.request(url, init);
  };

  async function makeBase(name = "b"): Promise<string> {
    const base = await prisma.base.create({ data: { name, createdBy: OWNER_ID } });
    await prisma.member.create({ data: { baseId: base.id, userId: OWNER_ID, role: "owner" } });
    return base.id;
  }

  async function makeTable(
    baseId: string,
    name: string,
  ): Promise<{ id: string; primaryFieldId: string }> {
    const table = await prisma.table.create({
      data: { baseId, name, primaryFieldId: "", createdBy: OWNER_ID },
    });
    const primary = await prisma.field.create({
      data: { tableId: table.id, name: "名称", type: "singleLineText", order: 0 },
    });
    await prisma.table.update({ where: { id: table.id }, data: { primaryFieldId: primary.id } });
    return { id: table.id, primaryFieldId: primary.id };
  }

  async function makeKb(name = "kb"): Promise<string> {
    const kb = await prisma.knowledgeBase.create({ data: { name, createdBy: OWNER_ID } });
    await prisma.kbMember.create({ data: { kbId: kb.id, userId: OWNER_ID, role: "owner" } });
    return kb.id;
  }

  return {
    tmpDir,
    prisma,
    request,
    makeBase,
    makeTable,
    makeKb,
    teardown: async () => {
      await prisma.$disconnect();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
