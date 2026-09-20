// M6 建库/建知识库权限门 assertCanCreateLibrary（真迁移临时库，不经 HTTP，直接调领域函数）。
//
// 覆盖：
//  - 实例无任何角色授予 -> 放行（组织角色体系未启用，不能把所有人锁死）；
//  - 有授予 + 用户持 create_library -> 放行；
//  - 有授予 + 用户不持 create_library -> 抛 403，文案固定；
//  - 门不是摆设：别人被授予不代表本人放行；
//  - 按角色不按人：部门授予荫及子树成员同样生效；
//  - 常量层：ORG_ACTIONS 含 create_library，role_owner 默认 actions 自动包含它。
//
// 注意：系统角色 permissions 由迁移种子固定（owner 现为五枚），本测试的动作集一律用
// 【自定义角色】精确控制，避免依赖迁移链内容。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { ORG_ACTIONS } from "@gx/shared-types";

// 同 roles-eval.test.ts：注入临时 DATABASE_URL/globalThis.__gx_prisma 之后【动态 import】
// （静态 import 会在 beforeAll 前 new client 绑错库）。
type GuardMod = typeof import("../createLibraryGuard.js");
type RolesMod = typeof import("../roles.js");

let assertCanCreateLibrary: GuardMod["assertCanCreateLibrary"];
let CREATE_LIBRARY_DENIED: string;
let SYSTEM_ROLES: RolesMod["SYSTEM_ROLES"];

let tmpDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-clib-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [guard, roles] = await Promise.all([
    import("../createLibraryGuard.js"),
    import("../roles.js"),
  ]);
  assertCanCreateLibrary = guard.assertCanCreateLibrary;
  CREATE_LIBRARY_DENIED = guard.CREATE_LIBRARY_DENIED;
  SYSTEM_ROLES = roles.SYSTEM_ROLES;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
  for (const t of ["role_assignments", "dept_members", "departments", "users"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
});

async function mkUser(id: string) {
  return prisma.user.create({
    data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", workspaceId: "ws_default" },
  });
}

async function mkRole(id: string, actions: string[]) {
  return prisma.role.create({
    data: {
      id, workspaceId: "ws_default", systemKey: null, name: id,
      description: "", isSystem: 0, permissions: JSON.stringify(actions),
    },
  });
}

async function grant(roleId: string, subjectType: "user" | "dept", subjectId: string) {
  return prisma.roleAssignment.create({ data: { roleId, subjectType, subjectId, scopeType: "workspace" } });
}

async function mkDept(id: string, parentId: string | null): Promise<string> {
  const pp = parentId === null
    ? `/${id}/`
    : `${(await prisma.department.findUnique({ where: { id: parentId } }))!.path}${id}/`;
  await prisma.department.create({
    data: { id, workspaceId: "ws_default", parentId, path: pp, name: id, status: "active" },
  });
  return id;
}

describe("assertCanCreateLibrary 兜底与判定", () => {
  it("实例无任何角色授予 -> 放行（体系未启用，保持登录即可建库的旧行为）", async () => {
    await mkUser("u_none");
    expect(await prisma.roleAssignment.count()).toBe(0);
    await expect(assertCanCreateLibrary("u_none")).resolves.toBeUndefined();
  });

  it("有授予 + 用户持 create_library -> 放行", async () => {
    await mkUser("u_yes");
    const r = await mkRole("role_c_yes", ["create_library"]);
    await grant(r.id, "user", "u_yes");
    expect(await prisma.roleAssignment.count()).toBeGreaterThan(0);
    await expect(assertCanCreateLibrary("u_yes")).resolves.toBeUndefined();
  });

  it("有授予 + 用户不持 create_library -> 抛 403 且文案固定", async () => {
    await mkUser("u_no");
    const r = await mkRole("role_c_no", ["manage_members"]);
    await grant(r.id, "user", "u_no");
    await expect(assertCanCreateLibrary("u_no")).rejects.toMatchObject({
      status: 403,
      message: CREATE_LIBRARY_DENIED,
    });
  });

  it("门不是摆设：他人被授予不代表本人放行（本人无任何角色 -> 403）", async () => {
    await mkUser("u_other");
    await mkUser("u_self");
    const r = await mkRole("role_c_lib2", ["create_library"]);
    await grant(r.id, "user", "u_other");
    await expect(assertCanCreateLibrary("u_self")).rejects.toMatchObject({ status: 403 });
  });

  it("按角色不按人：部门授予荫及子树成员 -> 放行", async () => {
    await mkUser("u_dept");
    const top = await mkDept("dl", null);
    const sub = await mkDept("dl1", "dl");
    await prisma.deptMember.create({ data: { departmentId: sub, userId: "u_dept", isMain: 1 } });
    const r = await mkRole("role_c_libd", ["create_library"]);
    await grant(r.id, "dept", top);
    await expect(assertCanCreateLibrary("u_dept")).resolves.toBeUndefined();
  });
});

describe("第六枚组织动作常量", () => {
  it("ORG_ACTIONS 含 create_library，且既有五枚顺序未变（追加在末尾）", () => {
    expect(ORG_ACTIONS).toContain("create_library");
    expect([...ORG_ACTIONS]).toEqual([
      "manage_departments", "manage_members", "manage_roles", "manage_menu", "manage_share",
      "create_library",
    ]);
  });

  it("role_owner 默认 actions 自动含 create_library（从 SYSTEM_ROLES 派生，不写字面量）", () => {
    const owner = SYSTEM_ROLES.find((r) => r.systemKey === "owner");
    expect(owner).toBeTruthy();
    expect(owner!.actions).toEqual([...ORG_ACTIONS]);
    expect(owner!.actions).toContain("create_library");
    for (const r of SYSTEM_ROLES.filter((x) => x.systemKey !== "owner")) {
      expect(r.actions).toEqual([]);
    }
  });
});
