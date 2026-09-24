// P1/S3 scopeProjectionTx 真库集成测试（临时库 + 真迁移，不经 HTTP，直接调事务原语）。
// 覆盖：A 幂等精确替换；B 删除隔离（legacy/policy:v1/user 行不被碰）；C add 级联；
//       D remove 级联 + legacy 保留；E mask 重算；F 事务回滚。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

type TxMod = typeof import("../scopeProjectionTx.js");
type ProjMod = typeof import("../scopeProjection.js");
let txm: TxMod;
let projectScopeRow: ProjMod["projectScopeRow"];
let prisma: PrismaClient;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s3-tx-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  [txm, { projectScopeRow: projectScopeRow }] = await Promise.all([
    import("../scopeProjectionTx.js"),
    import("../scopeProjection.js"),
  ]);
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CLEAR_TABLES = [
  "auth_policies", "role_library_scope", "fields", "tables", "bases", "users",
];

beforeEach(async () => {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
  for (const t of CLEAR_TABLES) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
});

async function mkUser(id = "admin") {
  await prisma.user.create({
    data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", workspaceId: "ws_default" },
  });
}

async function mkBase(id = "b1") {
  await prisma.base.create({ data: { id, name: id, createdBy: "admin" } });
}

async function mkTable(baseId: string, id: string): Promise<void> {
  await prisma.table.create({
    data: { id, baseId, name: id, primaryFieldId: `${id}_f1`, createdBy: "admin" },
  });
  await mkField(id, `${id}_f1`, 0);
}

async function mkField(tableId: string, id: string, order: number) {
  await prisma.field.create({
    data: { id, tableId, name: id, type: "singleLineText", order },
  });
}

function scopeRow(o: {
  roleId: string; libraryKind?: "base" | "kb"; libraryId: string;
  canManage?: number; visible?: number; canShare?: number; config?: unknown;
}) {
  return prisma.roleLibraryScope.create({
    data: {
      roleId: o.roleId,
      libraryKind: o.libraryKind ?? "base",
      libraryId: o.libraryId,
      canManage: o.canManage ?? 0,
      visible: o.visible ?? 0,
      canShare: o.canShare ?? 0,
      config: typeof o.config === "string" ? o.config : JSON.stringify(o.config ?? {}),
    },
  });
}

const input = (
  roleId: string, libraryId: string, over: Record<string, unknown> = {},
) => ({
  roleId, libraryKind: "base" as const, libraryId,
  canManage: 0, visible: 1, canShare: 0, config: "{}", ...over,
});

describe("A replaceScopePoliciesTx 幂等精确替换", () => {
  it("首放 -> 幂等重放 -> 收缩删除", async () => {
    await mkUser();
    await mkBase();
    await mkTable("b1", "t1");
    await mkTable("b1", "t2");
    const row = input("r1", "b1", { canManage: 1 });
    const projected = projectScopeRow(row, await txm.loadLiveShape(prisma, "b1"));
    expect(projected.length).toBe(3); // t1, t2, 库节点

    const first = await txm.replaceScopePoliciesTx(prisma, "r1", projected, "admin");
    expect(first).toEqual({ upserted: 3, deleted: 0 });
    const idsAfter = (
      await prisma.authPolicy.findMany({ where: { reason: "scope:role" }, select: { id: true } })
    ).map((r) => r.id).sort();

    const second = await txm.replaceScopePoliciesTx(prisma, "r1", projected, "admin");
    expect(second).toEqual({ upserted: 3, deleted: 0 });
    const idsSecond = (
      await prisma.authPolicy.findMany({ where: { reason: "scope:role" }, select: { id: true } })
    ).map((r) => r.id).sort();
    expect(idsSecond).toEqual(idsAfter); // 幂等：不产生重复行

    const onlyT1 = projected.filter((p) => p.nodeId === "nav_table_t1");
    const third = await txm.replaceScopePoliciesTx(prisma, "r1", onlyT1, "admin");
    expect(third).toEqual({ upserted: 1, deleted: 2 });
    const remaining = await prisma.authPolicy.findMany({ where: { reason: "scope:role" } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].nodeId).toBe("nav_table_t1");
  });
});

describe("B 删除隔离：非 scope:role 行原样保留", () => {
  it("空集替换只删 scope:role，legacy/policy:v1/user 行计数不变", async () => {
    await mkUser();
    const keepers = [
      { nodeId: "n_legacy", subjectType: "role", subjectId: "r1", reason: "legacy:user" },
      { nodeId: "n_v1", subjectType: "role", subjectId: "r1", reason: "policy:v1" },
      { nodeId: "n_user", subjectType: "user", subjectId: "u1", reason: null },
    ];
    for (const k of keepers) {
      await prisma.authPolicy.create({
        data: { workspaceId: "ws_default", createdBy: "admin", ...k },
      });
    }
    // 一条将被删的 scope:role 行。
    await prisma.authPolicy.create({
      data: {
        workspaceId: "ws_default", nodeId: "n_scope", subjectType: "role",
        subjectId: "r1", actions: "r", reason: "scope:role", createdBy: "admin",
      },
    });

    const result = await txm.replaceScopePoliciesTx(prisma, "r1", [], "admin");
    expect(result).toEqual({ upserted: 0, deleted: 1 });
    expect(await prisma.authPolicy.count()).toBe(3);
    for (const k of keepers) {
      const row = await prisma.authPolicy.findUnique({
        where: { nodeId_subjectType_subjectId: { nodeId: k.nodeId, subjectType: k.subjectType, subjectId: k.subjectId } },
      });
      expect(row?.reason).toBe(k.reason);
    }
  });
});

describe("C syncTableForAllScopes op=add", () => {
  it("canManage/visible 角色补投影，zero 角色无行", async () => {
    await mkUser();
    await mkBase();
    await mkTable("b1", "told");
    await mkTable("b1", "tnew");
    await scopeRow({ roleId: "rm", libraryId: "b1", canManage: 1, visible: 1 });
    await scopeRow({
      roleId: "rv", libraryId: "b1", visible: 1,
      config: { fields: { tnew: { tnew_f1: "visible" } } },
    });
    await scopeRow({ roleId: "rz", libraryId: "b1", config: { tables: { tnew: { create: true } } } });

    await txm.syncTableForAllScopesTx(prisma, "base", "b1", "tnew", "add", "admin");

    const shape = await txm.loadLiveShape(prisma, "b1");
    for (const [roleId] of [["rm"], ["rv"]] as const) {
      const expected = projectScopeRow(input(roleId, "b1", {
        canManage: roleId === "rm" ? 1 : 0,
        ...(roleId === "rv"
          ? { config: JSON.stringify({ fields: { tnew: { tnew_f1: "visible" } } }) }
          : {}),
      }), shape).find((p) => p.nodeId === "nav_table_tnew");
      const row = await prisma.authPolicy.findUnique({
        where: {
          nodeId_subjectType_subjectId: { nodeId: "nav_table_tnew", subjectType: "role", subjectId: roleId },
        },
      });
      expect(row, roleId).toBeDefined();
      expect(row!.actions).toBe(expected!.actions);
      expect(row!.fieldMask).toBe(expected!.fieldMask);
    }
    expect(await prisma.authPolicy.findUnique({
      where: {
        nodeId_subjectType_subjectId: { nodeId: "nav_table_tnew", subjectType: "role", subjectId: "rz" },
      },
    })).toBeNull();
  });
});

describe("D syncTableForAllScopes op=remove", () => {
  it("scope:role 行删光；同节点 legacy 行保留", async () => {
    await mkUser();
    await mkBase();
    await mkTable("b1", "tnew");
    await scopeRow({ roleId: "rm", libraryId: "b1", canManage: 1, visible: 1 });
    await scopeRow({ roleId: "rv", libraryId: "b1", visible: 1 });
    await txm.syncTableForAllScopesTx(prisma, "base", "b1", "tnew", "add", "admin");

    await txm.syncTableForAllScopesTx(prisma, "base", "b1", "tnew", "remove", "admin");
    expect(await prisma.authPolicy.count({ where: { nodeId: "nav_table_tnew" } })).toBe(0);

    await prisma.authPolicy.create({
      data: {
        workspaceId: "ws_default", nodeId: "nav_table_tnew", subjectType: "role",
        subjectId: "rm", actions: "r", reason: "legacy:member", createdBy: "admin",
      },
    });
    await txm.syncTableForAllScopesTx(prisma, "base", "b1", "tnew", "remove", "admin");
    const left = await prisma.authPolicy.findMany({ where: { nodeId: "nav_table_tnew" } });
    expect(left).toHaveLength(1);
    expect(left[0].reason).toBe("legacy:member");
  });
});

describe("E resyncTableMaskTx", () => {
  it("新字段补入显式 mask；宽 mask 角色保持 null；actions 不变", async () => {
    await mkUser();
    await mkBase();
    await mkTable("b1", "t1");
    await mkField("t1", "f2", 1);
    const narrowCfg = JSON.stringify({ fields: { t1: { t1_f1: "editable", f2: "visible" } } });
    await scopeRow({ roleId: "r1", libraryId: "b1", visible: 1, config: narrowCfg });
    await scopeRow({ roleId: "r2", libraryId: "b1", visible: 1 });
    const shape = await txm.loadLiveShape(prisma, "b1");
    await txm.replaceScopePoliciesTx(
      prisma, "r1", projectScopeRow(input("r1", "b1", { config: narrowCfg }), shape), "admin",
    );
    await txm.replaceScopePoliciesTx(
      prisma, "r2", projectScopeRow(input("r2", "b1"), shape), "admin",
    );
    const beforeActions = (await prisma.authPolicy.findFirst({
      where: { nodeId: "nav_table_t1", subjectType: "role", subjectId: "r1" },
    }))!.actions;

    await mkField("t1", "f3", 2);
    await txm.resyncTableMaskTx(prisma, "t1", "admin");

    const r1 = await prisma.authPolicy.findFirst({
      where: { nodeId: "nav_table_t1", subjectType: "role", subjectId: "r1" },
    });
    expect(JSON.parse(r1!.fieldMask!)).toEqual({
      allowFields: ["t1_f1", "f2", "f3"], readOnlyFields: ["f2"],
    });
    expect(r1!.actions).toBe(beforeActions);
    const r2 = await prisma.authPolicy.findFirst({
      where: { nodeId: "nav_table_t1", subjectType: "role", subjectId: "r2" },
    });
    expect(r2!.fieldMask).toBeNull();
  });
});

describe("F 事务回滚", () => {
  it("回调抛错整体回滚，auth_policies 回到调用前", async () => {
    await mkUser();
    await mkBase();
    await mkTable("b1", "t1");
    await expect(prisma.$transaction(async (tx) => {
      await txm.replaceScopePoliciesTx(
        tx, "r1",
        projectScopeRow(input("r1", "b1", { canManage: 1 }), await txm.loadLiveShape(tx, "b1")),
        "admin",
      );
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await prisma.authPolicy.count()).toBe(0);
  });
});
