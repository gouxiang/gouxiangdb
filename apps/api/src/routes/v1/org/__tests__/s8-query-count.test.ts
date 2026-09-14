// M2/S8 查询计数常量上界（计划 §7-S8 第 2 条）。
//
// 夹具：6 层部门链 + 4 个并列部门 = 10 个部门，10 名用户各兼全部 10 部门（10 兼岗）。
// 口径：Prisma 模型委托往返次数（与 roles-eval.test.ts / db.ts instrumentPrisma 同口径，
// SQLite connector 不支持 query 日志事件，ORM 往返即 M1/S9 既定客观口径）。
// 断言：effectiveRoleRows <= 3 且与兼岗数无关；listMembers 无 deptId 恒为 4 次，
// 与成员总数（10 -> 500）无关。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

type ListMembers = typeof import("../../../../domain/org/memberDirectory.js")["listMembers"];
type Effective = typeof import("../../../../domain/org/authorization.js")["effectiveRoleRows"];

let tmpDir: string;
let prisma: PrismaClient;
let listMembers: ListMembers;
let effectiveRoleRows: Effective;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s8-count-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "c.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const dir = await import("../../../../domain/org/memberDirectory.js");
  const authz = await import("../../../../domain/org/authorization.js");
  listMembers = dir.listMembers;
  effectiveRoleRows = authz.effectiveRoleRows;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 仅包四个被测委托的计数器（与 roles-eval 的 counted 同形态）。 */
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
  return {
    count: () => calls,
    client: {
      deptMember: wrap(client.deptMember),
      department: wrap(client.department),
      roleAssignment: wrap(client.roleAssignment),
      user: wrap(client.user),
    } as unknown as PrismaClient,
  };
}

/** 在单例 prisma 的指定委托方法上装计数器，返回拆除函数。 */
function tapDelegateCalls(spec: Array<[string, string[]]>) {
  const client = prisma as unknown as Record<string, Record<string, unknown>>;
  let calls = 0;
  const saved: Array<[Record<string, unknown>, string, unknown]> = [];
  for (const [delegateName, methods] of spec) {
    const delegate = client[delegateName];
    for (const m of methods) {
      const original = delegate[m] as (...a: unknown[]) => unknown;
      saved.push([delegate, m, original]);
      delegate[m] = (...args: unknown[]) => {
        calls++;
        return original.apply(delegate, args);
      };
    }
  }
  return { count: () => calls, restore: () => { for (const [d, m, fn] of saved) d[m] = fn; } };
}

async function seedDepts(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const id = `dept_c${i}`;
    const parent = i === 1 ? null : ids[i - 2];
    const pp = i === 1 ? `/${id}/` : `${(await prisma.department.findUniqueOrThrow({ where: { id: parent! } })).path}${id}/`;
    await prisma.department.create({ data: { id, workspaceId: "ws_default", parentId: parent, path: pp, name: `C${i}` } });
    ids.push(id);
  }
  // 4 个并列部门（挂在 C1 下），凑足 10 个兼岗目标
  for (let i = 7; i <= 10; i++) {
    const id = `dept_c${i}`;
    await prisma.department.create({
      data: { id, workspaceId: "ws_default", parentId: ids[0], path: `${ids[0] ? `/${ids[0]}/` : "/"}${id}/`, name: `C${i}` },
    });
    ids.push(id);
  }
  return ids;
}

async function seedUsers(n: number, deptIds: string[], startIdx = 0) {
  await prisma.user.createMany({
    data: Array.from({ length: n }, (_, k) => {
      const idx = startIdx + k;
      return {
        id: `uc_${idx}`, email: `uc_${idx}@x.com`, displayName: `UC ${idx}`,
        passwordHash: "x", workspaceId: "ws_default", status: "ACTIVE",
      };
    }),
  });
  const rows = [] as Array<{ id: string; departmentId: string; userId: string; isMain: number }>;
  for (let k = 0; k < n; k++) {
    for (let d = 0; d < deptIds.length; d++) {
      rows.push({
        id: `dm_${startIdx + k}_${d}`, departmentId: deptIds[d], userId: `uc_${startIdx + k}`,
        isMain: d === 2 ? 1 : 0, // 主部门唯一
      });
    }
  }
  await prisma.deptMember.createMany({ data: rows });
}

describe("effectiveRoleRows 查询数常量（6 层链 + 10 兼岗）", () => {
  it("10 部门 10 兼岗 <=3，再叠加层级与兼岗不增长", async () => {
    const deptIds = await seedDepts();
    await seedUsers(10, deptIds);
    // 一个授给 C1 的自定义角色，使祖先闭包路径被实际命中
    await prisma.role.create({
      data: { id: "role_c_count", workspaceId: "ws_default", name: "Cnt", isSystem: 0, permissions: '["manage_members"]' },
    });
    await prisma.roleAssignment.create({
      data: { roleId: "role_c_count", subjectType: "dept", subjectId: deptIds[0], scopeType: "workspace" },
    });

    const c1 = counted(prisma);
    await effectiveRoleRows("uc_0", c1.client);
    const first = c1.count();
    expect(first).toBeLessThanOrEqual(3);

    // 再加 6 层链与第三、十兼岗的极端展开：对同一用户调用次数不变
    const extra: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const id = `dept_x${i}`;
      const parent = i === 1 ? deptIds[5] : extra[i - 2];
      const parentPath = (await prisma.department.findUniqueOrThrow({ where: { id: parent } })).path;
      await prisma.department.create({ data: { id, workspaceId: "ws_default", parentId: parent, path: `${parentPath}${id}/`, name: `X${i}` } });
      extra.push(id);
    }
    await prisma.deptMember.createMany({
      data: extra.map((d, i) => ({ id: `dm_x_${i}`, departmentId: d, userId: "uc_0", isMain: 0 })),
    });
    const c2 = counted(prisma);
    await effectiveRoleRows("uc_0", c2.client);
    expect(c2.count()).toBe(first);
  });
});

describe("listMembers 查询数与成员总数无关（无 deptId：count/findMany/归属 IN/授予 IN）", () => {
  it("10 人与 500 人均为同一常量（4 次 ORM 往返，另含已缓存的工作区解析）", async () => {
    // 预热 getDefaultWorkspaceId 内存单例，避免工作区点查计入
    await listMembers({ limit: 1 });

    const tap1 = tapDelegateCalls([
      ["user", ["count", "findMany"]],
      ["deptMember", ["findMany"]],
      ["roleAssignment", ["findMany"]],
    ]);
    await listMembers({ page: 1, limit: 100 });
    const small = tap1.count();
    tap1.restore();
    expect(small).toBe(4);

    // 追加到 500 人（已有 10 人 + 上一 describe 的夹具）
    const have = await prisma.user.count();
    if (have < 500) {
      await prisma.user.createMany({
        data: Array.from({ length: 500 - have }, (_, k) => ({
          id: `ub_${k}`, email: `ub_${k}@x.com`, displayName: `UB ${k}`,
          passwordHash: "x", workspaceId: "ws_default", status: "ACTIVE",
        })),
      });
    }

    const tap2 = tapDelegateCalls([
      ["user", ["count", "findMany"]],
      ["deptMember", ["findMany"]],
      ["roleAssignment", ["findMany"]],
    ]);
    await listMembers({ page: 1, limit: 100 });
    const large = tap2.count();
    tap2.restore();
    expect(large).toBe(small);
    expect(await prisma.user.count()).toBeGreaterThanOrEqual(500);
  });
});
