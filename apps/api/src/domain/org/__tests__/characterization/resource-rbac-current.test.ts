// 特征测试（二）：库权限判定现状锁（真迁移临时库 + 真 guards + 真 JWT）。
//
// 权限核心模型重构后本文件钉死的是【新的】两层事实：
//   1. guards 的每个 require* 都由「角色 × 库视野」推导，members.role 不再参与放行；
//   2. 三条硬规则的落点：删库只有超级管理员、管理员不自动获得管理权、
//      允许分享开关放宽到管理员。
// permissionsForRole 的五角色矩阵作为遗留投影保留（仍在 shared-types），
// 但它只在测试中比对，不再进入任何库权限判定路径。
// 用 hono/jwt 以同一 HS256 密钥直接签发 {userId} token（与 auth.issueToken 同形态，
// 但不依赖其导出），走通 getUserId 验签 -> libraryPolicy 裁决 -> 权限判定整条链。

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

  const mkUser = (id: string) => prisma.user.create({
    data: { id, email: `${id}@example.com`, displayName: id, passwordHash: "x", workspaceId: "ws_default" },
  });
  const grant = (roleId: string, userId: string) => prisma.roleAssignment.create({
    data: { roleId, subjectType: "user", subjectId: userId, scopeType: "workspace", createdBy: "seed" },
  });
  // 只勾可见（不做逐表设置）与勾了可管理，是 B 段库权限的两种典型形状。
  const scope = (roleId: string, canManage: boolean) => prisma.roleLibraryScope.create({
    data: {
      roleId, libraryKind: "base", libraryId: baseId,
      visible: 1, canManage: canManage ? 1 : 0,
      config: JSON.stringify({ tables: {}, fields: {} }),
    },
  });
  const custom = (id: string, name: string) => prisma.role.create({
    data: { id, workspaceId: "ws_default", name, isSystem: 0, immutable: 0, permissions: "[]" },
  });

  await Promise.all(["u_super", "u_admin", "u_visible", "u_manager", "u_restricted", "u_out"].map(mkUser));
  await grant("role_owner", "u_super");
  await grant("role_admin", "u_admin");
  await grant("role_restricted", "u_restricted");
  const roleVisible = await custom("role_c_visible", "可见某个库");
  await grant(roleVisible.id, "u_visible");
  await scope(roleVisible.id, false);
  const roleManager = await custom("role_c_manager", "管某个库");
  await grant(roleManager.id, "u_manager");
  await scope(roleManager.id, true);
  // u_out 刻意不授予任何角色：零授权用户。

  // 引擎永久单一化后，base 裸建无 nav 节点 -> 守卫端到端反查 fail-closed（permissionsOf 不反查
  // navNode 故前面能过）。补 nav 同步建出 base 节点，并投影两个自定义角色（super/admin 硬短路）。
  const { syncNavFromEntitiesTx } = await import("../../../nav/sync.js");
  await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  // 管理员隐式投影（enter/manage_share）：裸建 base 没走标准 seed。对 role_admin 用其现有
  // 视野行重算投影——本夹具 admin 在该库无 canManage 行，故精确投影为 enter/manage_share，
  // 不给 edit_data/manage_table/manage_schema（replace 同时清掉先前多余策略）。
  const { rebuildScopePoliciesTx } = await import("../../../authz/scopeDoubleWrite.js");
  {
    const saved = await prisma.roleLibraryScope.findMany({ where: { roleId: "role_admin" } });
    await rebuildScopePoliciesTx(prisma, "role_admin", saved.map((r) => ({
      roleId: r.roleId, libraryKind: r.libraryKind, libraryId: r.libraryId,
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })), "seed");
  }
  for (const roleId of ["role_c_visible", "role_c_manager"] as const) {
    const saved = await prisma.roleLibraryScope.findMany({ where: { roleId } });
    await rebuildScopePoliciesTx(prisma, roleId, saved.map((r) => ({
      roleId: r.roleId, libraryKind: r.libraryKind, libraryId: r.libraryId,
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })), "seed");
  }
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("permissionsForRole 五角色布尔矩阵（shared-types 遗留投影）", () => {
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

  it("该矩阵已【退出】库权限判定：members.role 不再参与放行", async () => {
    // 用户被写进 members 表且 role=owner，但没有任何组织角色/库视野 —— 必须什么都没有。
    // 这是权限核心模型重构的核心断言：074号 invariants 之一。
    await prisma.member.create({ data: { baseId, userId: "u_out", role: "owner" } });
    const perm = await guards.permissionsOf("u_out", baseId);
    expect(perm.canView).toBe(false);
    expect(perm.canManageBase).toBe(false);
    await prisma.member.deleteMany({ where: { baseId, userId: "u_out" } });
  });
});

describe("guards 真库：PermissionsOf 由『角色 × 库视野』推导", () => {
  const ALL_FALSE = {
    canManageBase: false, canManageSchema: false, canEditData: false,
    canComment: false, canView: false,
  };

  it("超级管理员：全权（不看库视野配置）", async () => {
    expect(await guards.permissionsOf("u_super", baseId)).toEqual({
      canManageBase: true, canManageSchema: true, canEditData: true,
      canComment: true, canView: true,
    });
  });

  it("管理员：能进所有库，但管理权来自配置（未勾选时只可见）", async () => {
    const before = await guards.permissionsOf("u_admin", baseId);
    expect(before.canView).toBe(true);
    expect(before.canManageBase).toBe(false);
    expect(before.canEditData).toBe(false);
  });

  it("自定义角色 + 只勾可见（未做逐表设置）：库内全表只读", async () => {
    const perm = await guards.permissionsOf("u_visible", baseId);
    expect(perm.canView).toBe(true);
    // 只读可见不等于可评论：评论权跟写权限走（旧模型 viewer 的 canComment 也是 false）。
    expect(perm.canComment).toBe(false);
    expect(perm.canEditData).toBe(false);
    expect(perm.canManageBase).toBe(false);
  });

  it("自定义角色 + 勾了可管理：除删库外全权", async () => {
    const perm = await guards.permissionsOf("u_manager", baseId);
    expect(perm).toEqual({
      canManageBase: true, canManageSchema: true, canEditData: true,
      canComment: true, canView: true,
    });
    const access = await guards.baseAccessOf("u_manager", baseId);
    // 硬规则：删库不是管理权的子集。
    expect(access.canDeleteLibrary).toBe(false);
  });

  it("受限成员 / 零角色：全 false（含 canView=false）", async () => {
    expect(await guards.permissionsOf("u_out", baseId)).toEqual(ALL_FALSE);
    expect(await guards.permissionsOf("u_restricted", baseId)).toEqual(ALL_FALSE);
  });
});

describe("guards 端到端（真 JWT -> 库视野裁决）", () => {
  const CASES: Array<{
    name: string;
    fnName: keyof GuardsModule;
    allow: string[];
  }> = [
    { name: "requireCanView", fnName: "requireCanView", allow: ["u_super", "u_admin", "u_visible", "u_manager"] },
    { name: "requireCanEditData", fnName: "requireCanEditData", allow: ["u_super", "u_manager"] },
    { name: "requireCanManageSchema", fnName: "requireCanManageSchema", allow: ["u_super", "u_manager"] },
    { name: "requireCanManageBase", fnName: "requireCanManageBase", allow: ["u_super", "u_manager"] },
    { name: "requireCanComment", fnName: "requireCanComment", allow: ["u_super", "u_manager"] },
    // 硬规则 A：删库只有超级管理员。
    { name: "requireCanDeleteBase", fnName: "requireCanDeleteBase", allow: ["u_super"] },
    // 硬规则 C：允许分享开关——有管理权者 + 超级管理员 + 管理员。
    { name: "requireCanToggleShare", fnName: "requireCanToggleShare", allow: ["u_super", "u_admin", "u_manager"] },
  ];

  const ALL_USERS = ["u_super", "u_admin", "u_visible", "u_manager", "u_restricted", "u_out"];

  for (const { name, fnName, allow } of CASES) {
    it(`${name}：放行名单 200，其余 403`, async () => {
      const fn = guards[fnName] as unknown as GuardFn;
      for (const userId of ALL_USERS) {
        const res = await guardApp(fn).request(`/${baseId}`, {
          headers: { Authorization: `Bearer ${await tokenFor(userId)}` },
        });
        expect(res.status, `${name} / ${userId}`).toBe(allow.includes(userId) ? 200 : 403);
      }
    });
  }

  it("受限成员 -> 六类动作全部 403", async () => {
    for (const { fnName } of CASES) {
      const fn = guards[fnName] as unknown as GuardFn;
      const res = await guardApp(fn).request(`/${baseId}`, {
        headers: { Authorization: `Bearer ${await tokenFor("u_restricted")}` },
      });
      expect(res.status).toBe(403);
    }
  });

  it("无 token -> requireCanView 401（未登录）", async () => {
    const res = await guardApp(guards.requireCanView).request(`/${baseId}`);
    expect(res.status).toBe(401);
  });
});
