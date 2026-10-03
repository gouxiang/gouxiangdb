// ADR-0056 翻 on 阻断缺陷对拍：软删表后库节点 edit_data 必须随活表形态重算。
// 真库 + 真迁移（临时库副本，生产 dev.db 零写），直接调 softDeleteTableTx 事务体，
// 落库读 auth_policies 动作串，用 parseActionString 判定，不依赖动作顺序。
//
// 口径：
//   1) canManage=0、唯一可写表被删 -> edit_data 移除；enter（空库库门）/manage_share 保留；
//   2) canManage=1（库管理）删表 -> edit_data 仍在（canManage 恒导出），manage_* 不丢。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { parseActionString } from "@gx/shared-types";
import { softDeleteTableTx } from "../../tableServiceTx.js";
import {
  loadLiveShape,
  replaceScopePoliciesTx,
  resyncLibraryAggregateForAllScopesTx,
} from "../scopeProjectionTx.js";
import { projectScopeRow, type ScopeProjectionInput } from "../scopeProjection.js";

let prisma: PrismaClient;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-del-resync-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CLEAR_TABLES = [
  "auth_policies", "role_library_scope", "fields", "tables", "bases", "users",
];

async function resetDb() {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
  for (const t of CLEAR_TABLES) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
}

async function mkUser() {
  await prisma.user.create({
    data: { id: "admin", email: "admin@x.com", displayName: "admin", passwordHash: "x", workspaceId: "ws_default" },
  });
}

async function mkBaseWithTable(): Promise<string> {
  await prisma.base.create({ data: { id: "b1", name: "b1", createdBy: "admin" } });
  await prisma.table.create({
    data: { id: "t1", baseId: "b1", name: "t1", primaryFieldId: "f1", createdBy: "admin" },
  });
  await prisma.field.create({
    data: { id: "f1", tableId: "t1", name: "名称", type: "singleLineText", order: 0 },
  });
  return "b1";
}

async function mkScope(over: Partial<ScopeProjectionInput>) {
  await prisma.roleLibraryScope.create({
    data: {
      roleId: "r1", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 1, canShare: 0, config: "{}", ...over,
    },
  });
}

async function projectAll() {
  const scope = await prisma.roleLibraryScope.findUniqueOrThrow({
    where: {
      roleId_libraryKind_libraryId: {
        roleId: "r1", libraryKind: "base", libraryId: "b1",
      },
    },
  });
  const shape = await loadLiveShape(prisma, "b1");
  const input: ScopeProjectionInput = {
    roleId: scope.roleId, libraryKind: "base", libraryId: scope.libraryId,
    canManage: scope.canManage, visible: scope.visible,
    canShare: scope.canShare, config: scope.config,
  };
  await replaceScopePoliciesTx(
    prisma, "r1", projectScopeRow(input, shape), "admin",
  );
}

async function readLibraryActions(roleId = "r1"): Promise<string[]> {
  const row = await prisma.authPolicy.findUnique({
    where: {
      nodeId_subjectType_subjectId: {
        nodeId: "nav_base_b1", subjectType: "role", subjectId: roleId,
      },
    },
  });
  expect(row, "缺库节点 scope:role 策略").toBeDefined();
  return parseActionString(row!.actions);
}

describe("软删表后库节点 edit_data 重算", () => {
  it("canManage=0：删掉唯一可写表 -> edit_data 移除，enter/manage_share 保留", async () => {
    await resetDb();
    await mkUser();
    await mkBaseWithTable();
    const config = JSON.stringify({ tables: { t1: { update: true } } });
    await mkScope({ canShare: 1, config });
    await projectAll();

    const before = await readLibraryActions();
    expect(before.includes("edit_data")).toBe(true);
    expect(before.includes("enter")).toBe(true);
    expect(before.includes("manage_share")).toBe(true);

    await prisma.$transaction((tx) =>
      softDeleteTableTx(tx, "t1", "admin"));

    const after = await readLibraryActions();
    expect(after.includes("edit_data"), "删唯一可写表后 edit_data 必须移除").toBe(false);
    expect(after.includes("enter"), "空库库门仍可见（legacy visible）").toBe(true);
    expect(after.includes("manage_share"), "库级分享位由 scope 行保留").toBe(true);
    expect(after.includes("manage_table")).toBe(false);
  });

  it("canManage=1：删表后 edit_data 仍在，manage_schema/manage_table/manage_share 不丢", async () => {
    await resetDb();
    await mkUser();
    await mkBaseWithTable();
    await mkScope({ canManage: 1, visible: 1 });
    await projectAll();

    const before = await readLibraryActions();
    expect(before.includes("edit_data")).toBe(true);

    await prisma.$transaction((tx) =>
      softDeleteTableTx(tx, "t1", "admin"));

    const after = await readLibraryActions();
    expect(after.includes("edit_data"), "canManage 恒导出 edit_data，不得误删").toBe(true);
    expect(after.includes("enter")).toBe(true);
    expect(after.includes("manage_schema")).toBe(true);
    expect(after.includes("manage_table")).toBe(true);
    expect(after.includes("manage_share")).toBe(true);
  });

  it("role_admin 隐含库节点：canManage=0 管理员删掉唯一可写表 -> edit_data 移除", async () => {
    await resetDb();
    await mkUser();
    await mkBaseWithTable();
    const config = JSON.stringify({ tables: { t1: { update: true } } });
    // 管理员隐含投影不走普通 scope 行遍历，单独覆盖：canManage=0 时 edit_data 只来自活表可写并集。
    await mkScope({ roleId: "role_admin", canManage: 0, visible: 1, config });
    await resyncLibraryAggregateForAllScopesTx(prisma, "base", "b1", "admin");

    const before = await readLibraryActions("role_admin");
    expect(before.includes("edit_data")).toBe(true);

    await prisma.$transaction((tx) => softDeleteTableTx(tx, "t1", "admin"));

    const after = await readLibraryActions("role_admin");
    expect(after.includes("edit_data"), "管理员 edit_data 亦须随活表并集重算").toBe(false);
    expect(after.includes("enter")).toBe(true);
    expect(after.includes("manage_share")).toBe(true);
  });

  it("恢复表：删表后 edit_data 移除 -> 恢复同一张可写表后 edit_data 回来（OVERDENY 反证）", async () => {
    await resetDb();
    await mkUser();
    await mkBaseWithTable();
    const config = JSON.stringify({ tables: { t1: { update: true } } });
    await mkScope({ config });
    await projectAll();

    await prisma.$transaction((tx) => softDeleteTableTx(tx, "t1", "admin"));
    expect((await readLibraryActions()).includes("edit_data")).toBe(false);

    // 模拟恢复表（活表形态回到删前）+ 恢复路径的同事务重算调用。
    await prisma.$transaction(async (tx) => {
      await tx.table.update({ where: { id: "t1" }, data: { deletedAt: null } });
      await tx.field.updateMany({ where: { tableId: "t1" }, data: { deletedAt: null } });
      await resyncLibraryAggregateForAllScopesTx(tx, "base", "b1", "admin");
    });

    const restored = await readLibraryActions();
    expect(restored.includes("edit_data"), "恢复可写表后须拿回 edit_data").toBe(true);
  });
});
