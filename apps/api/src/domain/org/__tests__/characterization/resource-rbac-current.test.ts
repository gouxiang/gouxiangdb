// M2/S0 特征测试（二）：资源 RBAC 五角色矩阵现状锁（真迁移临时库 + 真 guards + 真 JWT）。
//
// M2 最高回归红线（计划 §3.1）：组织层接入前后，任意用户对 base 的资源权限
// requireCanView/EditData/ManageSchema/ManageBase/Comment 结果逐值不变。
// 本文件钉死两层事实：
//   1. shared-types permissionsForRole 的五角色布尔矩阵（每次返回副本）；
//   2. guards 真库 + 真 JWT 求值：requireCan* 对五角色放行/403、非成员 403、无 token 401。
// 用 hono/jwt 以同一 HS256 密钥直接签发 {userId} token（与 auth.issueToken 同形态，
// 但不依赖其导出），从而走通 getUserId 验签 -> 真库 roleOf -> 权限判定整条链。
// M2 的 roles/role_assignments 组织角色不接入这些判定，S9 必须复跑本文件且逐值绿。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { Hono, type Context } from "hono";
import { sign } from "hono/jwt";
import { PrismaClient } from "@prisma/client";
import { permissionsForRole, type Role } from "@gx/shared-types";

// guards 静态引入会连带求值 db.ts（在 globalThis.__gx_prisma 注入前就 new 出 client），
// 故 guards 改在 beforeAll 注入临时 client 后动态 import（同 records-keyset 模式）。
type GuardsModule = typeof import("../../../../guards.js");

const ROLES: Role[] = ["owner", "creator", "editor", "commenter", "viewer"];
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me-in-production";
const TTL = 7 * 24 * 60 * 60;

let tmpDir: string;
let prisma: PrismaClient;
let baseId: string;
let guards: GuardsModule;
const tokens: Record<string, string> = {};

async function tokenFor(userId: string): Promise<string> {
  if (!tokens[userId]) {
    const now = Math.floor(Date.now() / 1000);
    tokens[userId] = await sign({ userId, iat: now, exp: now + TTL }, JWT_SECRET, "HS256");
  }
  return tokens[userId];
}

type GuardFn = (c: Context, b: string) => Promise<unknown>;

function guardApp(fn: GuardFn) {
  const app = new Hono();
  app.get("/:baseId", async (c) => {
    await fn(c, c.req.param("baseId"));
    return c.json({ ok: true });
  });
  app.onError((e, c) => {
    if (e instanceof guards.HttpError) {
      return c.json({ error: e.message }, e.status as 401 | 403);
    }
    throw e;
  });
  return app;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-rbac-cur-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.JWT_SECRET = JWT_SECRET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  guards = await import("../../../../guards.js");

  const base = await prisma.base.create({ data: { name: "b", createdBy: "seed" } });
  baseId = base.id;
  for (const role of ROLES) {
    await prisma.user.create({
      data: { id: `u_${role}`, email: `${role}@example.com`, displayName: role, passwordHash: "x" },
    });
    await prisma.member.create({ data: { baseId, userId: `u_${role}`, role } });
  }
  await prisma.user.create({
    data: { id: "u_out", email: "out@example.com", displayName: "out", passwordHash: "x" },
  });
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("permissionsForRole 五角色布尔矩阵（shared-types 真源）", () => {
  const EXPECTED: Record<Role, [boolean, boolean, boolean, boolean, boolean]> = {
    // [ManageBase, ManageSchema, EditData, Comment, View]
    owner:     [true, true, true, true, true],
    creator:   [false, true, true, true, true],
    editor:    [false, false, true, true, true],
    commenter: [false, false, false, true, true],
    viewer:    [false, false, false, false, true],
  };

  it.each(ROLES)("%s 矩阵逐值", (role) => {
    const p = permissionsForRole(role);
    expect([p.canManageBase, p.canManageSchema, p.canEditData, p.canComment, p.canView])
      .toEqual(EXPECTED[role]);
  });

  it("返回的是副本（改返回值不污染矩阵真源）", () => {
    const a = permissionsForRole("owner");
    a.canView = false;
    expect(permissionsForRole("owner").canView).toBe(true);
  });
});

describe("guards 真库：roleOf / permissionsOf", () => {
  it.each(ROLES)("%s 经 members.role 取角色并映射权限", async (role) => {
    expect(await guards.roleOf(`u_${role}`, baseId)).toBe(role);
    expect(await guards.permissionsOf(`u_${role}`, baseId)).toEqual(permissionsForRole(role));
  });

  it("非成员 -> roleOf=undefined，permissionsOf 全 false（含 canView=false）", async () => {
    expect(await guards.roleOf("u_out", baseId)).toBeUndefined();
    expect(await guards.permissionsOf("u_out", baseId)).toEqual({
      canManageBase: false, canManageSchema: false, canEditData: false,
      canComment: false, canView: false,
    });
  });
});

describe("guards 端到端（真 JWT -> 真库取 role -> 权限判定）", () => {
  // fn 在 beforeAll 动态拿到 guards 之后才解析（describe 体在导入期即求值）。
  const CASES: Array<{ name: string; fnName: keyof GuardsModule; allow: Role[] }> = [
    { name: "requireCanView", fnName: "requireCanView", allow: ROLES },
    { name: "requireCanEditData", fnName: "requireCanEditData", allow: ["owner", "creator", "editor"] },
    { name: "requireCanManageSchema", fnName: "requireCanManageSchema", allow: ["owner", "creator"] },
    { name: "requireCanManageBase", fnName: "requireCanManageBase", allow: ["owner"] },
    { name: "requireCanComment", fnName: "requireCanComment",
      allow: ["owner", "creator", "editor", "commenter"] },
  ];

  for (const { name, fnName, allow } of CASES) {
    it(`${name}：允许角色 200，其余五角色内成员 403`, async () => {
      const fn = guards[fnName] as unknown as GuardFn;
      for (const role of ROLES) {
        const res = await guardApp(fn).request(`/${baseId}`, {
          headers: { Authorization: `Bearer ${await tokenFor(`u_${role}`)}` },
        });
        expect(res.status, `${name} / ${role}`).toBe(allow.includes(role) ? 200 : 403);
      }
    });
  }

  it("已登录但非成员 -> 五类动作全部 403", async () => {
    for (const { fnName } of CASES) {
      const fn = guards[fnName] as unknown as GuardFn;
      const res = await guardApp(fn).request(`/${baseId}`, {
        headers: { Authorization: `Bearer ${await tokenFor("u_out")}` },
      });
      expect(res.status).toBe(403);
    }
  });

  it("无 token -> requireCanView 401（未登录）", async () => {
    const res = await guardApp(guards.requireCanView).request(`/${baseId}`);
    expect(res.status).toBe(401);
  });
});
