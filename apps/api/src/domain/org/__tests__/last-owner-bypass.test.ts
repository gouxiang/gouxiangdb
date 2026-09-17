// M2 回溯修复：最后 owner 保护两条旁路对抗测试（真迁移临时库，不经 HTTP，直接调领域事务）。
//
// 坐实背景：assertNotLastOwnerTx 唯一调用点是 disableUser；以下两条写路径可在不停用任何用户
// 的情况下摘掉全部【在岗】owner 来源：
//  A/B replaceAssignments（PUT 角色主体集）：清空 role_owner 主体，或把唯一 owner 换成
//      DISABLED 用户 / 无 ACTIVE 成员的部门；
//  C   assignDepartments：owner 仅靠被授 role_owner 部门（子树）的成员关系获得身份，
//      把他移出该部门即零在岗 owner。
// 修复=两事务写完成后复算 usersWithRole("role_owner", tx)，空则 409 回滚。
// 对照组 D 证明守卫不是无脑拦死；E 证明自定义角色不触发；F 覆盖空部门替换变体。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
// 注意：只能 type-only import——guards.js 运行时传递依赖 db.ts，静态 import 会让 db 单例在
// beforeAll 注入临时 DATABASE_URL/globalThis.__gx_prisma 之前实例化，绑错库（同 roles-eval.test.ts）。
import type { HttpError } from "../../../guards.js";

// 与 roles-eval.test.ts 同一套建库/迁移/注入方式：注入临时 DATABASE_URL/globalThis.__gx_prisma
// 之后动态 import（静态 import 会在 beforeAll 前 new client 绑错库）。
type RoleAdminMod = typeof import("../roleAdmin.js");
type MembersMod = typeof import("../members.js");
type RolesMod = typeof import("../roles.js");
let replaceAssignments: RoleAdminMod["replaceAssignments"];
let assignDepartments: MembersMod["assignDepartments"];
let usersWithRole: RolesMod["usersWithRole"];
let OWNER_ROLE_ID: string;

let tmpDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-lastowner-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [roleAdmin, members, roles] = await Promise.all([
    import("../roleAdmin.js"),
    import("../members.js"),
    import("../roles.js"),
  ]);
  replaceAssignments = roleAdmin.replaceAssignments;
  assignDepartments = members.assignDepartments;
  usersWithRole = roles.usersWithRole;
  OWNER_ROLE_ID = roles.OWNER_ROLE_ID;
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

async function mkUser(id: string, status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  return prisma.user.create({
    data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", workspaceId: "ws_default", status },
  });
}

async function mkDept(id: string, parentId: string | null = null): Promise<string> {
  const pp = parentId === null ? `/${id}/` : `${(await prisma.department.findUnique({ where: { id: parentId } }))!.path}${id}/`;
  await prisma.department.create({
    data: { id, workspaceId: "ws_default", parentId, path: pp, name: id, status: "active" },
  });
  return id;
}

async function membership(userId: string, departmentId: string, isMain = 0) {
  return prisma.deptMember.create({ data: { departmentId, userId, isMain } });
}

async function grant(roleId: string, subjectType: "user" | "dept", subjectId: string) {
  return prisma.roleAssignment.create({ data: { roleId, subjectType, subjectId, scopeType: "workspace" } });
}

/**
 * 断言抛 HttpError 且状态码 409（守卫抛错在事务回调内，withWriteTx 原样透传）。
 * 结构化检查（name/status/message），避免运行时 instanceof 需加载 guards.js（会提前实例化 db 单例）。
 */
async function expectConflict409(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  const httpErr = err as HttpError;
  expect(httpErr.status).toBe(409);
  expect(httpErr.message).toContain("至少保留一位工作区所有者");
  return httpErr;
}

describe("旁路 A：replaceAssignments 清空 role_owner 主体集", () => {
  it("唯一在岗 owner 是直接 user 授予，PUT subjects:[] -> 409 且授予行回滚保留", async () => {
    await mkUser("admin"); // 操作人（仅记录 createdBy，无需 manage_roles 权限——领域函数不鉴权）
    await mkUser("owner1");
    await grant(OWNER_ROLE_ID, "user", "owner1");
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["owner1"]);

    await expectConflict409(replaceAssignments("admin", OWNER_ROLE_ID, { subjects: [] }));

    // 事务整体回滚：原授予行仍在，无新增，owner 求值不变。
    const rows = await prisma.roleAssignment.findMany({ where: { roleId: OWNER_ROLE_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "user", subjectId: "owner1" });
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["owner1"]);
  });

  it("subjects 缺省/非数组（归一为 []）同样 409 回滚，不得静默清空", async () => {
    await mkUser("admin");
    await mkUser("owner1");
    await grant(OWNER_ROLE_ID, "user", "owner1");

    await expectConflict409(replaceAssignments("admin", OWNER_ROLE_ID, {}));

    const rows = await prisma.roleAssignment.findMany({ where: { roleId: OWNER_ROLE_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectId).toBe("owner1");
  });
});

describe("旁路 B：replaceAssignments 换成无效 owner 来源", () => {
  it("唯一 owner 替换成 DISABLED 用户 -> 409（ACTIVE 过滤经守卫生效），旧授予回滚保留", async () => {
    await mkUser("admin");
    await mkUser("owner1");
    await mkUser("ghost", "DISABLED");
    await grant(OWNER_ROLE_ID, "user", "owner1");

    await expectConflict409(
      replaceAssignments("admin", OWNER_ROLE_ID, {
        subjects: [{ subjectType: "user", subjectId: "ghost" }],
      }),
    );

    const rows = await prisma.roleAssignment.findMany({ where: { roleId: OWNER_ROLE_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "user", subjectId: "owner1" });
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["owner1"]);
  });

  it("唯一 owner 替换成无 ACTIVE 成员的部门 -> 409 回滚（部门授予子树展开为空）", async () => {
    await mkUser("admin");
    await mkUser("owner1");
    const emptyDept = await mkDept("empty");
    await grant(OWNER_ROLE_ID, "user", "owner1");

    await expectConflict409(
      replaceAssignments("admin", OWNER_ROLE_ID, {
        subjects: [{ subjectType: "dept", subjectId: emptyDept }],
      }),
    );

    const rows = await prisma.roleAssignment.findMany({ where: { roleId: OWNER_ROLE_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "user", subjectId: "owner1" });
  });
});

describe("旁路 C：assignDepartments 摘掉部门子树来源的最后 owner", () => {
  it("owner 仅靠 role_owner 部门授予（在子部门）获得身份，移出该部门 -> 409 且 deptMember 行回滚保留", async () => {
    await mkUser("admin");
    await mkUser("deptOwner");
    const root = await mkDept("root");
    const child = await mkDept("child", "root");
    await membership("deptOwner", child, 1);
    await grant(OWNER_ROLE_ID, "dept", root); // 荫及子树 -> deptOwner 是唯一在岗 owner
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["deptOwner"]);

    await expectConflict409(assignDepartments("admin", "deptOwner", { remove: [child] }));

    // deleteMany 已在事务内执行，但守卫抛错整体回滚：成员行仍在，owner 身份不变。
    const rows = await prisma.deptMember.findMany({ where: { userId: "deptOwner" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ departmentId: child, userId: "deptOwner" });
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["deptOwner"]);
  });

  it("owner 直接挂在被授部门自身，移出 -> 409 回滚", async () => {
    await mkUser("admin");
    await mkUser("deptOwner2");
    const root = await mkDept("root2");
    await membership("deptOwner2", root, 1);
    await grant(OWNER_ROLE_ID, "dept", root);

    await expectConflict409(assignDepartments("admin", "deptOwner2", { remove: [root] }));

    const rows = await prisma.deptMember.findMany({ where: { userId: "deptOwner2" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].departmentId).toBe(root);
  });
});

describe("对照 D：仍有第二位 ACTIVE owner 时同类操作放行（守卫非无脑拦死）", () => {
  it("两位直接 owner：PUT 移除其一（保留另一位 ACTIVE owner）-> 200 生效", async () => {
    await mkUser("admin");
    await mkUser("owner1");
    await mkUser("owner2");
    await grant(OWNER_ROLE_ID, "user", "owner1");
    await grant(OWNER_ROLE_ID, "user", "owner2");

    const result = await replaceAssignments("admin", OWNER_ROLE_ID, {
      subjects: [{ subjectType: "user", subjectId: "owner2" }],
    });
    expect(result.assignments).toHaveLength(1);
    expect(result.removed).toEqual([{ subjectType: "user", subjectId: "owner1" }]);

    const rows = await prisma.roleAssignment.findMany({ where: { roleId: OWNER_ROLE_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectId).toBe("owner2");
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["owner2"]);
  });

  it("部门子树 owner 被移出，但另有第二位 ACTIVE 直接 owner -> 200，成员行确实删除", async () => {
    await mkUser("admin");
    await mkUser("deptOwner");
    await mkUser("backupOwner");
    const root = await mkDept("root3");
    await membership("deptOwner", root, 1);
    await grant(OWNER_ROLE_ID, "dept", root);
    await grant(OWNER_ROLE_ID, "user", "backupOwner");

    const result = await assignDepartments("admin", "deptOwner", { remove: [root] });
    expect(result.userId).toBe("deptOwner");
    expect(result.deptMemberships).toHaveLength(0);
    expect(await prisma.deptMember.count({ where: { userId: "deptOwner" } })).toBe(0);
    // 部门授予仍在（守卫不管授予本身），但子树已无成员；在岗 owner 剩 backupOwner。
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["backupOwner"]);
  });
});

describe("E：非 owner 自定义角色不受该守卫约束", () => {
  it("自定义角色 PUT subjects:[] 清空成功，不报 owner 409，role_owner 授予不受影响", async () => {
    await mkUser("admin");
    await mkUser("owner1");
    await grant(OWNER_ROLE_ID, "user", "owner1");
    const custom = await prisma.role.create({
      data: { id: "role_c_lastowner", workspaceId: "ws_default", name: "自定义", isSystem: 0, permissions: "[]" },
    });
    await grant(custom.id, "user", "owner1");

    const result = await replaceAssignments("admin", custom.id, { subjects: [] });
    expect(result.assignments).toHaveLength(0);
    expect(result.removed).toEqual([{ subjectType: "user", subjectId: "owner1" }]);
    expect(await prisma.roleAssignment.count({ where: { roleId: custom.id } })).toBe(0);
    // owner 授予原样保留。
    expect(await prisma.roleAssignment.count({ where: { roleId: OWNER_ROLE_ID } })).toBe(1);
    expect(await usersWithRole(OWNER_ROLE_ID)).toEqual(["owner1"]);
  });
});
