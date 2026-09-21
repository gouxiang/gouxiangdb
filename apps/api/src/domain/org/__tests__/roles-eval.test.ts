// M2/S5 角色求值与系统种子对拍（真迁移临时库，不经 HTTP，直接调领域函数）。
// 覆盖：系统角色常量与迁移种子逐字一致；直接授予/部门祖先授予并集去重与来源；
// 软删部门不展开、软删角色不生效；effectiveRoleRows/usersWithRole 查询数为常量（与层数/兼岗无关）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { ORG_ACTIONS } from "@gx/shared-types";

// 真库模式：被测领域模块依赖 db.ts 单例，必须在注入临时 DATABASE_URL/globalThis.__gx_prisma
// 之后【动态 import】（静态 import 会在 beforeAll 前 new client 绑错库）。
type RolesMod = typeof import("../roles.js");
let SYSTEM_ROLES: RolesMod["SYSTEM_ROLES"];
let effectiveRoleRows: RolesMod["effectiveRoleRows"];
let usersWithRole: RolesMod["usersWithRole"];

let tmpDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-roles-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const mod = await import("../roles.js");
  SYSTEM_ROLES = mod.SYSTEM_ROLES;
  effectiveRoleRows = mod.effectiveRoleRows;
  usersWithRole = mod.usersWithRole;
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

async function mkDept(id: string, parentId: string | null): Promise<string> {
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

/** 统计 Prisma 模型委托往返次数（只包被测函数实际用的四个委托）。 */
function counted(client: PrismaClient) {
  let calls = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop);
        return typeof v === "function"
          ? (...a: unknown[]) => { calls++; return (v as (...x: unknown[]) => unknown).apply(t, a); }
          : v;
      },
    }) as T;
  const proxied = {
    deptMember: wrap(client.deptMember),
    department: wrap(client.department),
    roleAssignment: wrap(client.roleAssignment),
    user: wrap(client.user),
  };
  return { count: () => calls, client: proxied as unknown as PrismaClient };
}

describe("系统角色常量与迁移种子对拍", () => {
  // 权限核心模型重构后，SYSTEM_ROLES.actions 就是数据库列的期望值本身：
  // 不再有「迁移补出来的读基线不在常量里」的例外——三枚权限预设的动作集全部由
  // ORG_ACTIONS 派生（超级管理员/管理员）或显式空（受限成员），旧的四枚资源名锚点恒空。
  // 由此对拍恢复为逐字严格相等，任何一侧加动作都必须在另一侧同步，否则红灯。

  // 例外：四枚历史资源名锚点（creator/editor/commenter/viewer）被更早的迁移
  // 20260920220000 补过一枚读基线 view_directory（动机：切到 view_directory 守卫后不让原本
  // 能读通讯录的人突然读不到）。这条基线写在数据库列里、不在常量中，故这四枚对拍时剔除它。
  // 三枚权限预设不受此影响：它们的动作集由 ORG_ACTIONS 派生或显式空，必须逐字严格相等。
  const ANCHOR_IDS = new Set(["role_creator", "role_editor", "role_commenter", "role_viewer"]);
  const expectedActions = (spec: { id: string; actions: readonly string[] }) =>
    ANCHOR_IDS.has(spec.id) ? spec.actions.filter((a) => a !== "view_directory") : [...spec.actions];
  const actualActions = (id: string, row: string) =>
    ANCHOR_IDS.has(id) ? (JSON.parse(row) as string[]).filter((a) => a !== "view_directory") : JSON.parse(row) as string[];

  it("七枚系统角色 id/key/name/isSystem/immutable/动作集逐字一致", async () => {
    const rows = await prisma.role.findMany({ where: { workspaceId: "ws_default" } });
    expect(rows).toHaveLength(SYSTEM_ROLES.length);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const spec of SYSTEM_ROLES) {
      const row = byId.get(spec.id);
      expect(row).toBeTruthy();
      expect(row!.systemKey).toBe(spec.systemKey);
      expect(row!.name).toBe(spec.name);
      expect(row!.isSystem).toBe(1);
      // immutable 必须与常量一致：它是「能不能被编辑/删除」的唯一判据，
      // 常量与列不同步会让"超级管理员可被改名"或"管理员删不掉"这类事故静默发生。
      expect(row!.immutable, `${spec.id} immutable 与常量不一致`).toBe(spec.immutable ? 1 : 0);
      const rowActions = JSON.parse(row!.permissions) as string[];
      expect(actualActions(spec.id, row!.permissions)).toEqual(expectedActions(spec));
      // 追加式迁移不能写出重复项（json_insert 无去重能力）。
      expect(new Set(rowActions).size).toBe(rowActions.length);
    }
    // 超级管理员全动作；管理员与其同权；受限成员零动作。
    const superAdmin = byId.get("role_owner")!;
    expect(JSON.parse(superAdmin.permissions).sort()).toEqual([...ORG_ACTIONS].sort());
    const admin = byId.get("role_admin")!;
    expect(JSON.parse(admin.permissions).sort()).toEqual([...ORG_ACTIONS].sort());
    expect(JSON.parse(byId.get("role_restricted")!.permissions)).toEqual([]);
  });
});

describe("effectiveRoleRows 并集求值与来源", () => {
  it("直接授予 + 部门祖先授予并集、去重、来源清单完整", async () => {
    await mkUser("u");
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(await mkDept(`d${i}`, i === 1 ? null : ids[i - 2]));
    await membership("u", "d3", 1);
    await membership("u", "d6", 0);

    // 自定义角色 R 授给部门 d2（u 在 d3 -> d3 path 含 d2，命中祖先）
    const r = await prisma.role.create({
      data: { id: "role_c_r", workspaceId: "ws_default", name: "R", isSystem: 0, permissions: '["manage_members"]' },
    });
    await grant(r.id, "dept", "d2");
    // 系统 viewer 直接授给用户
    await grant("role_viewer", "user", "u");
    // Q 授给 d6 自身
    const q = await prisma.role.create({
      data: { id: "role_c_q", workspaceId: "ws_default", name: "Q", isSystem: 0, permissions: "[]" },
    });
    await grant(q.id, "dept", "d6");

    const roles = await effectiveRoleRows("u");
    const byId = new Map(roles.map((x) => [x.roleId, x]));
    expect([...byId.keys()].sort()).toEqual(["role_c_q", "role_c_r", "role_viewer"]);

    const rEff = byId.get("role_c_r")!;
    expect(rEff.sources).toEqual([{ type: "dept", id: "d2", name: "d2" }]);
    // d2 是经 d3 祖先命中，而非 u 直接在 d2；来源仅记录授予所在的 d2。
    const qEff = byId.get("role_c_q")!;
    expect(qEff.sources).toEqual([{ type: "dept", id: "d6", name: "d6" }]);
    const viewer = byId.get("role_viewer")!;
    expect(viewer.sources).toEqual([{ type: "user", id: "u" }]);
  });

  it("调岗即时：移出 d3 后下次求值 R 消失；加回恢复（无缓存）", async () => {
    await mkUser("u2");
    const root = await mkDept("a", null);
    const child = await mkDept("b", "a");
    await membership("u2", child);
    const role = await prisma.role.create({
      data: { id: "role_c_t", workspaceId: "ws_default", name: "T", isSystem: 0, permissions: '["manage_roles"]' },
    });
    await grant(role.id, "dept", root);
    expect((await effectiveRoleRows("u2")).map((x) => x.roleId)).toContain(role.id);

    await prisma.deptMember.deleteMany({ where: { userId: "u2" } });
    expect((await effectiveRoleRows("u2")).map((x) => x.roleId)).not.toContain(role.id);

    await membership("u2", child);
    expect((await effectiveRoleRows("u2")).map((x) => x.roleId)).toContain(role.id);
  });

  it("软删部门的授予不展开；软删角色不生效", async () => {
    await mkUser("u3");
    const d = await mkDept("g", null);
    await membership("u3", d);
    const role = await prisma.role.create({
      data: { id: "role_c_g", workspaceId: "ws_default", name: "G", isSystem: 0, permissions: "[]" },
    });
    await grant(role.id, "dept", d);
    expect((await effectiveRoleRows("u3")).map((x) => x.roleId)).toContain(role.id);

    // 软删角色
    await prisma.role.update({ where: { id: role.id }, data: { deletedAt: new Date() } });
    expect((await effectiveRoleRows("u3"))).toHaveLength(0);

    // 恢复角色，再软删部门
    await prisma.role.update({ where: { id: role.id }, data: { deletedAt: null } });
    expect((await effectiveRoleRows("u3"))).toHaveLength(1);
    await prisma.department.update({ where: { id: d }, data: { deletedAt: new Date() } });
    expect((await effectiveRoleRows("u3"))).toHaveLength(0);
  });

  it("查询数为常量（6 层 + 双兼岗），与层数/兼岗数无关", async () => {
    await mkUser("u4");
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(await mkDept(`l${i}`, i === 1 ? null : ids[i - 2]));
    await membership("u4", "l3");
    await membership("u4", "l6");
    const role = await prisma.role.create({
      data: { id: "role_c_k", workspaceId: "ws_default", name: "K", isSystem: 0, permissions: '["manage_members"]' },
    });
    await grant(role.id, "dept", "l1");

    const c1 = counted(prisma);
    await effectiveRoleRows("u4", c1.client);
    const first = c1.count();

    // 再加兼岗与更多层，调用次数应不变
    const ids2: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const parent = i === 1 ? "l6" : ids2[i - 2];
      ids2.push(await mkDept(`m${i}`, parent));
    }
    await membership("u4", "m6");
    const c2 = counted(prisma);
    await effectiveRoleRows("u4", c2.client);
    expect(c2.count()).toBe(first);
    expect(first).toBeLessThanOrEqual(3);
  });
});

describe("usersWithRole 反向展开（最后 owner 保护用）", () => {
  it("直接用户 + 授予部门子树成员全部计入，且只计 ACTIVE", async () => {
    await mkUser("owner1");
    await mkUser("owner2");
    await prisma.user.update({ where: { id: "owner2" }, data: { status: "DISABLED" } });
    const top = await mkDept("o", null);
    const sub = await mkDept("o1", "o");
    await mkUser("subowner");
    await membership("subowner", sub, 1);
    await grant("role_owner", "user", "owner1");
    await grant("role_owner", "user", "owner2"); // DISABLED 不计
    await grant("role_owner", "dept", top); // 荫及子树 subowner

    const users = await usersWithRole("role_owner");
    expect(users.sort()).toEqual(["owner1", "subowner"]);
  });
});
