// M2 组织路由端到端测试共享夹具：真迁移临时库 + 真 createApp + 真 hono/jwt（不 mock auth）。
//
// 每个测试文件在 beforeAll 调 setupOrgHarness()：注入临时 DATABASE_URL/globalThis.__gx_prisma
// 后动态 import app/db，使它们绑定临时库（静态 import 会在注入前 new client 绑错库）。
// 干净库迁移后无任何用户（owner 自举只在迁移时库已有用户才发生），故测试内显式授予角色。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { sign } from "hono/jwt";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

export const JWT_SECRET = "m2-org-secret-at-least-16-chars";
const TTL = 7 * 24 * 60 * 60;

export interface OrgHarness {
  tmpDir: string;
  prisma: PrismaClient;
  app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  /** 建用户（默认 ACTIVE/ws_default/tv0）；不授任何组织角色。 */
  createUser: (id: string, opts?: { status?: string; email?: string; displayName?: string }) => Promise<{ id: string }>;
  /** 给用户授系统角色（默认 owner）。 */
  grantSystemRole: (userId: string, systemKey?: string, createdBy?: string) => Promise<void>;
  /** 授任意角色（可 dept 主体）。 */
  grant: (roleId: string, subjectType: "user" | "dept", subjectId: string, createdBy?: string) => Promise<void>;
  revoke: (roleId: string, subjectType: "user" | "dept", subjectId: string) => Promise<void>;
  token: (userId: string, tv?: number) => Promise<string>;
  auth: (userId: string, tv?: number) => Promise<Record<string, string>>;
  /** 清全部组织业务数据（保留 ws_default/系统角色）；关 FK 后清表以绕开自引用 RESTRICT。 */
  reset: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function setupOrgHarness(): Promise<OrgHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-org-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "org.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = JWT_SECRET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const appMod = await import("../../../../app.js");
  const app = appMod.createApp().app as unknown as OrgHarness["app"];

  const createUser: OrgHarness["createUser"] = async (id, opts) => {
    const passwordHash = await bcrypt.hash("password123", 10);
    await prisma.user.create({
      data: {
        id,
        email: opts?.email ?? `${id}@x.com`,
        displayName: opts?.displayName ?? id,
        passwordHash,
        status: opts?.status ?? "ACTIVE",
        workspaceId: "ws_default",
      },
    });
    return { id };
  };

  const grant: OrgHarness["grant"] = async (roleId, subjectType, subjectId, createdBy = "test-admin") => {
    await prisma.roleAssignment.create({
      data: { roleId, subjectType, subjectId, scopeType: "workspace", createdBy },
    });
  };
  const revoke: OrgHarness["revoke"] = async (roleId, subjectType, subjectId) => {
    await prisma.roleAssignment.deleteMany({ where: { roleId, subjectType, subjectId } });
  };
  const grantSystemRole: OrgHarness["grantSystemRole"] = async (userId, systemKey = "owner", createdBy) => {
    await grant(`role_${systemKey}`, "user", userId, createdBy);
  };

  const token = async (userId: string, tv = 0): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return sign({ userId, tv, iat: now, exp: now + TTL }, JWT_SECRET, "HS256");
  };
  const auth = async (userId: string, tv = 0) => ({ Authorization: `Bearer ${await token(userId, tv)}` });

  const reset: OrgHarness["reset"] = async () => {
    // departments 自引用 ON DELETE RESTRICT，直接 deleteMany 会撞外键；临时关 FK 清表。
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
    for (const t of [
      "role_assignments",
      "dept_members",
      "departments",
      "comments",
      "kb_doc_acls",
      "kb_members",
      "members",
      "users",
    ]) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  };

  const cleanup = async () => {
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, prisma, app, createUser, grant, revoke, grantSystemRole, token, auth, reset, cleanup };
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
