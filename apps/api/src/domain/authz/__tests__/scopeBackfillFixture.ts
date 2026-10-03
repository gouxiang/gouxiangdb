// 存量投影 / 通电前体检 两个 spec 共用的真库夹具（临时库 + 真迁移，不经 HTTP）。
// 文件名不匹配 *.test.ts，vitest 不会把它当用例收集。

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { nodeId } from "../../nav/backfill.js";

/** 每个用例前清空的物理表（顺序无关，外键临时关闭）。 */
export const CLEAR_TABLES = [
  "auth_policies", "role_library_scope", "nav_nodes", "fields", "tables", "bases", "roles", "users",
];

/** 建一个临时库并跑完真迁移，返回 client 与其清理函数。 */
export function createAuthzTempDb(prefix: string): { prisma: PrismaClient; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  return { prisma, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

export async function resetTables(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
  for (const t of CLEAR_TABLES) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
}

export async function mkUser(prisma: PrismaClient, id = "u1"): Promise<void> {
  await prisma.user.create({
    data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", workspaceId: "ws_default" },
  });
}

export async function mkRole(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.role.create({
    data: { id, workspaceId: "ws_default", name: id, isSystem: id.startsWith("role_") ? 1 : 0, permissions: "[]" },
  });
}

export async function mkBase(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.base.create({ data: { id, name: id, createdBy: "u1" } });
}

export async function mkTable(prisma: PrismaClient, baseId: string, id: string, fieldIds: string[]): Promise<void> {
  await prisma.table.create({ data: { id, baseId, name: id, primaryFieldId: fieldIds[0] ?? "f0", createdBy: "u1" } });
  let order = 0;
  for (const f of fieldIds) {
    await prisma.field.create({ data: { id: f, tableId: id, name: f, type: "singleLineText", order: order++ } });
  }
}

export interface ScopeSeed {
  roleId: string;
  libraryId: string;
  libraryKind?: "base" | "kb";
  canManage?: number;
  visible?: number;
  canShare?: number;
  config?: unknown;
}

/** 直接插 role_library_scope（模拟双写上线前的存量行，绕过一切写路径钩子）。 */
export async function mkScope(prisma: PrismaClient, s: ScopeSeed): Promise<void> {
  await prisma.roleLibraryScope.create({
    data: {
      roleId: s.roleId,
      libraryKind: s.libraryKind ?? "base",
      libraryId: s.libraryId,
      canManage: s.canManage ?? 0,
      visible: s.visible ?? 0,
      canShare: s.canShare ?? 0,
      config: typeof s.config === "string" ? s.config : JSON.stringify(s.config ?? {}),
    },
  });
}

/** nav 节点（引擎 decide 需要；库级可达性抽样按真节点判）。 */
export async function mkNode(
  prisma: PrismaClient, kind: "base" | "table", rid: string, parentId: string | null,
): Promise<void> {
  const id = nodeId(kind, rid);
  await prisma.navNode.create({
    data: {
      id, workspaceId: "ws_default", kind, resourceType: kind, resourceId: rid,
      name: rid, path: `/${id}/`, depth: kind === "base" ? 0 : 1, isSystem: 1,
      ...(parentId ? { parentId } : {}),
    },
  });
}

/**
 * 标准夹具：u1 + b1(t1: f1,f2) + b2(t2: f3) + nav 四节点 + r1（b1 可见+建，f2 隐藏）
 * + role_admin（b1 管理）。b2 无 admin scope 行，用于「管理员隐含只读覆盖」。
 */
export async function seedFixture(prisma: PrismaClient): Promise<void> {
  await mkUser(prisma);
  await mkBase(prisma, "b1");
  await mkTable(prisma, "b1", "t1", ["f1", "f2"]);
  await mkBase(prisma, "b2");
  await mkTable(prisma, "b2", "t2", ["f3"]);
  await prisma.workspace.upsert({
    where: { id: "ws_default" },
    create: { id: "ws_default", name: "ws_default" },
    update: {},
  });
  await mkNode(prisma, "base", "b1", null);
  await mkNode(prisma, "table", "t1", nodeId("base", "b1"));
  await mkNode(prisma, "base", "b2", null);
  await mkNode(prisma, "table", "t2", nodeId("base", "b2"));
  await mkRole(prisma, "r1");
  await mkRole(prisma, "role_admin");
  await mkScope(prisma, {
    roleId: "r1", libraryId: "b1", visible: 1,
    config: { tables: { t1: { create: true } }, fields: { t1: { f2: "hidden" } } },
  });
  await mkScope(prisma, { roleId: "role_admin", libraryId: "b1", canManage: 1, visible: 1 });
}
