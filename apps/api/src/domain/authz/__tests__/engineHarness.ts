// M4/S1 引擎测试夹具：真迁移临时库 + 直连 Prisma（不经 HTTP/service 直调，ARCH §5.8 口径）。
// 与 M2 s8-query-count / M3 charHarness 同模式：临时 DATABASE_URL + globalThis.__gx_prisma
// 后动态 import db 单例，再动态 import 引擎（纯域，不 import app/Hono/guards）。

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

export interface EngineHarness {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

let current: { tmpDir: string; prisma: PrismaClient } | null = null;

export async function setupEngineHarness(label = "gx-m4-authz-"): Promise<EngineHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "authz.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  current = { tmpDir, prisma };
  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      current = null;
    },
  };
}

export interface UserSpec {
  id: string;
  email?: string;
}

export async function createUsers(prisma: PrismaClient, specs: UserSpec[]): Promise<void> {
  await prisma.user.createMany({
    data: specs.map((s) => ({
      id: s.id,
      email: s.email ?? `${s.id}@example.com`,
      displayName: s.id,
      passwordHash: "x",
      workspaceId: "ws_default",
      status: "ACTIVE",
    })),
  });
}

export interface DeptSpec {
  id: string;
  parentId?: string | null;
  path?: string;
}

/** 建部门（path 缺省按 parent 链物化 "/id..." ）。 */
export async function createDepts(prisma: PrismaClient, specs: DeptSpec[]): Promise<void> {
  await prisma.department.createMany({
    data: specs.map((s) => ({
      id: s.id,
      workspaceId: "ws_default",
      parentId: s.parentId ?? null,
      path: s.path ?? "/",
      name: s.id,
    })),
  });
}

/** 由 parentId 链推导物化 path（"/root/.../id/"）。 */
export function materializedPath(dept: { id: string; parentId?: string | null }, byId: Map<string, { parentId?: string | null }>): string {
  const segs: string[] = [dept.id];
  let parentId = dept.parentId ?? null;
  while (parentId) {
    segs.unshift(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return `/${segs.join("/")}/`;
}

export async function addDeptMembership(
  prisma: PrismaClient,
  rows: Array<{ id: string; departmentId: string; userId: string; isMain?: number }>,
): Promise<void> {
  await prisma.deptMember.createMany({
    data: rows.map((r, i) => ({
      id: r.id,
      departmentId: r.departmentId,
      userId: r.userId,
      isMain: r.isMain ?? (i === 0 ? 1 : 0),
    })),
  });
}

export async function createRole(
  prisma: PrismaClient,
  spec: { id: string; name?: string },
): Promise<void> {
  await prisma.role.create({
    data: { id: spec.id, workspaceId: "ws_default", name: spec.name ?? spec.id, isSystem: 0, permissions: "[]" },
  });
}

export async function assignRole(
  prisma: PrismaClient,
  spec: { roleId: string; subjectType: "user" | "dept"; subjectId: string; createdBy?: string },
): Promise<void> {
  await prisma.roleAssignment.create({
    data: {
      roleId: spec.roleId,
      subjectType: spec.subjectType,
      subjectId: spec.subjectId,
      scopeType: "workspace",
      createdBy: spec.createdBy ?? "seed",
    },
  });
}

export interface NodeSpec {
  id: string;
  parentId?: string | null;
  kind?: string;
  resourceType?: string;
  resourceId?: string;
  name?: string;
  inheritAncestors?: number;
}

/** 建 nav 节点：path/depth 按 parentId 链物化（parent 须先建）。 */
export async function createNavNodes(prisma: PrismaClient, specs: NodeSpec[]): Promise<void> {
  const byId = new Map<string, NodeSpec>();
  for (const s of specs) byId.set(s.id, s);
  for (const s of specs) {
    const segs = [s.id];
    let p = s.parentId ?? null;
    while (p) {
      segs.unshift(p);
      p = byId.get(p)?.parentId ?? null;
    }
    await prisma.navNode.create({
      data: {
        id: s.id,
        workspaceId: "ws_default",
        parentId: s.parentId ?? null,
        kind: s.kind ?? "doc",
        resourceType: s.resourceType ?? s.kind ?? "doc",
        resourceId: s.resourceId ?? s.id,
        name: s.name ?? s.id,
        path: `/${segs.join("/")}/`,
        depth: segs.length - 1,
        isSystem: 1,
        inheritAncestors: s.inheritAncestors ?? 1,
      },
    });
  }
}

export interface PolicySpec {
  id: string;
  nodeId: string;
  subjectType: "user" | "dept" | "role";
  subjectId: string;
  actions: string;
  fieldMask?: string | null;
  createdBy?: string;
}

export async function createPolicies(prisma: PrismaClient, specs: PolicySpec[]): Promise<void> {
  await prisma.authPolicy.createMany({
    data: specs.map((s) => ({
      id: s.id,
      workspaceId: "ws_default",
      nodeId: s.nodeId,
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      actions: s.actions,
      fieldMask: s.fieldMask ?? null,
      createdBy: s.createdBy ?? "seed",
    })),
  });
}

export async function deletePolicy(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.authPolicy.delete({ where: { id } });
}

/** 内存 createdBy 解析器（S1 不真点实体表；S3 适配层注入按 resourceType 的点查实现）。 */
export function mapCreatedBy(map: Record<string, string>) {
  return async (node: { resourceId: string | null }): Promise<string | null> =>
    node.resourceId && map[node.resourceId] ? map[node.resourceId]! : null;
}

export { current };
