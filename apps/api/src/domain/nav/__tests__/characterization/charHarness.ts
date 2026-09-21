// M3/S0 特征测试共享夹具：真迁移临时库 + 真 createApp（真 hono/jwt，不 mock auth/守卫）。
//
// 与 M2 orgHarness 同模式：注入临时 DATABASE_URL + globalThis.__gx_prisma 后动态 import app，
// 使 db.ts 单例绑定临时库。三个 characterization 文件共用本夹具：
//   - entity-lifecycle-current：六类实体删除/恢复语义现状（M3-S3 nav 接线后逐值复跑）；
//   - membership-list-current：旧列表接口 membership 过滤与排序现状；
//   - rbac-current：旧资源守卫 requireCan*/requireKb 矩阵现状。
// M3 的 nav_nodes/menu_items/auth_policies 在 S1/S2 才建表，本夹具不引用它们。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

export const JWT_SECRET = "m3-char-secret-at-least-16-chars";
const TTL = 7 * 24 * 60 * 60;

export interface CharHarness {
  tmpDir: string;
  prisma: PrismaClient;
  app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  /** 直接造 ACTIVE 用户（password123），不建任何成员关系。 */
  createUser: (id: string, opts?: { email?: string; displayName?: string }) => Promise<void>;
  /**
   * 直接给用户挂一枚组织角色（权限核心模型落地后，库权限一律走「角色 × 库」，
   * 不再认"谁建的库"/members.role）。纯脚手架用户必须显式拿角色才能建库、进库。
   * 默认挂超级管理员（role_owner）；挂 role_restricted 就是"零权限成员"。
   */
  grantRole: (userId: string, roleId?: string) => Promise<void>;
  /** 生成与 issueToken 同形态的真 JWT（{userId,tv:0}，HS256）。 */
  token: (userId: string) => Promise<string>;
  auth: (userId: string) => Promise<Record<string, string>>;
  cleanup: () => Promise<void>;
}

export async function setupCharHarness(label = "gx-m3-char-"): Promise<CharHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "char.db")}`;
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
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const appMod = await import("../../../../app.js");
  const app = appMod.createApp().app as unknown as CharHarness["app"];

  const createUser: CharHarness["createUser"] = async (id, opts) => {
    const passwordHash = await bcrypt.hash("password123", 10);
    await prisma.user.create({
      data: {
        id,
        email: opts?.email ?? `${id}@example.com`,
        displayName: opts?.displayName ?? id,
        passwordHash,
        status: "ACTIVE",
        workspaceId: "ws_default",
      },
    });
  };

  const grantRole: CharHarness["grantRole"] = async (userId, roleId = "role_owner") => {
    await prisma.roleAssignment.create({
      data: { roleId, subjectType: "user", subjectId: userId, scopeType: "workspace", createdBy: "seed" },
    });
  };

  const token = async (userId: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return sign({ userId, tv: 0, iat: now, exp: now + TTL }, JWT_SECRET, "HS256");
  };
  const auth = async (userId: string) => ({ Authorization: `Bearer ${await token(userId)}` });

  const cleanup = async () => {
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, prisma, app, createUser, grantRole, token, auth, cleanup };
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
