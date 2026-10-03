// ADR-0056 调用点接通证据（路由级）：软删表 / 恢复表走完 HTTP 路径后，库节点 edit_data
// 必须随活表形态重算。原语级测试只能证明「算得对」，证明不了「被调用」——本缺陷的成因
// 恰恰是调用点压根没接。故这里经真 Hono 路由打到底，再落库读 auth_policies 断言。
//
// 真库 + 真迁移（临时目录），生产 dev.db 零写；身份固定为超管 u1（删表/恢复都过
// requireTableManage）。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve("u1") }));

import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { parseActionString } from "@gx/shared-types";
import {
  loadLiveShape,
  replaceScopePoliciesTx,
} from "../../domain/authz/scopeProjectionTx.js";
import { projectScopeRow } from "../../domain/authz/scopeProjection.js";

const OWNER = "u1";
let prisma: PrismaClient;
let tmpDir: string;
let request: (method: string, url: string, body?: unknown) => Promise<Response>;
let baseId: string;
let tableId: string;
/**
 * 删表事务体（第三条用例绕开 HTTP 守卫直调）。必须动态 import：静态 import 会在本文件顶部
 * 就把 db.ts 单例建出来（那时 DATABASE_URL 尚未指向临时库），路由随后复用该单例将查不到
 * 新建的库 -> 守卫 403。与路由模块同在 setup() 内、env 生效之后加载。
 */
let softDeleteTableTx: typeof import("../../domain/tableServiceTx.js")["softDeleteTableTx"];

async function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-delroute-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_M1_SIDECAR = "off";
  process.env.GX_M1_SIDECAR_READ = "off";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  await prisma.user.create({
    data: { id: OWNER, email: "u1@example.com", displayName: "U1", passwordHash: "x" },
  });
  await prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: OWNER, scopeType: "workspace", createdBy: "seed" },
  });

  const guardsMod = await import("../../guards.js");
  const [tablesMod, recordsMod, tableTxMod] = await Promise.all([
    import("../tables.js"),
    import("../records.js"),
    import("../../domain/tableServiceTx.js"),
  ]);
  softDeleteTableTx = tableTxMod.softDeleteTableTx;
  const app = new Hono();
  app.route("/tables", tablesMod.tables);
  app.route("/records", recordsMod.records);
  app.onError((err, c) => guardsMod.errorResponse(c, err));
  request = async (method, url, body) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return app.request(url, init);
  };
}

async function libraryActions(roleId = "r1"): Promise<string[]> {
  const row = await prisma.authPolicy.findUnique({
    where: {
      nodeId_subjectType_subjectId: {
        nodeId: `nav_base_${baseId}`, subjectType: "role", subjectId: roleId,
      },
    },
  });
  expect(row, "缺库节点 scope:role 策略").toBeDefined();
  return parseActionString(row!.actions);
}

/** 每个用例一套干净夹具：base + 一张表 + 一条「对该表可写」的 scope 行 + 首放投影。 */
async function seed(baseName: string): Promise<void> {
  // 库名全局唯一（A4 收口），两个用例各用一个名字。
  const base = await prisma.base.create({ data: { name: baseName, createdBy: OWNER } });
  baseId = base.id;
  await prisma.member.create({ data: { baseId, userId: OWNER, role: "owner" } });

  const created = await request("POST", `/tables?baseId=${baseId}`, { name: "t1" });
  expect(created.status).toBe(201);
  tableId = (await created.json() as { table: { id: string } }).table.id;

  // 按既有原语（非被测对象）先落一次全量投影：库节点此时含 edit_data。
  const config = JSON.stringify({ tables: { [tableId]: { update: true } } });
  await prisma.roleLibraryScope.create({
    data: {
      roleId: "r1", libraryKind: "base", libraryId: baseId,
      canManage: 0, visible: 1, canShare: 0, config,
    },
  });
  await replaceScopePoliciesTx(prisma, "r1", projectScopeRow({
    roleId: "r1", libraryKind: "base", libraryId: baseId,
    canManage: 0, visible: 1, canShare: 0, config,
  }, await loadLiveShape(prisma, baseId)), OWNER);
  expect((await libraryActions()).includes("edit_data")).toBe(true);
}

// 只 setup 一次：路由模块与 db.ts 单例在首次 import 时已绑定到首个 prisma，
// 每个用例重复 setup（重建临时库）会让缓存模块指向已销毁的连接 -> 500。
describe("软删/恢复表路由：库节点 edit_data 随活表形态重算", () => {
  beforeAll(async () => { await setup(); }, 120000);
  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("DELETE /tables/:id：走完删表路由，库节点 edit_data 移除（调用点接通证据）", async () => {
    await seed("b1");
    const del = await request("DELETE", `/tables/${tableId}`);
    expect(del.status, "删表路由应放行（超管身份）").toBe(200);
    const afterDelete = await libraryActions();
    expect(afterDelete.includes("edit_data"),
      "删表路由必须重算库节点，edit_data 不得残留").toBe(false);
    expect(afterDelete.includes("enter")).toBe(true);
  }, 120000);

  it("删表走真事务体（不经 HTTP 守卫）+ 恢复走真路由：非管理员 r1 拿回 edit_data", async () => {
    // OVERDENY 的真实形状：断言主体是 canManage=0 的普通角色 r1，其 edit_data 纯由
    // 活表可写并集导出（不掺 canManage）。删表绕开 HTTP 走 domain 事务体（r1 本就过不了
    // requireTableManage，而故障路径是「删」这一步没重算），恢复侧仍走真 HTTP 路由。
    await seed("b3");
    await prisma.$transaction((tx) => softDeleteTableTx(tx, tableId, OWNER));
    expect((await libraryActions()).includes("edit_data")).toBe(false);

    const restore = await request("POST", `/records/trash/${tableId}/restore`, { kind: "table" });
    expect(restore.status, "恢复表路由应放行").toBe(200);
    expect((await libraryActions()).includes("edit_data"),
      "普通角色恢复可写表后必须拿回 edit_data").toBe(true);
  }, 120000);

  it("POST /records/trash/:id/restore：走完恢复路由，库节点 edit_data 回来（OVERDENY 反证）", async () => {
    await seed("b2");
    const del = await request("DELETE", `/tables/${tableId}`);
    expect(del.status).toBe(200);
    expect((await libraryActions()).includes("edit_data")).toBe(false);

    const restore = await request("POST", `/records/trash/${tableId}/restore`, { kind: "table" });
    expect(restore.status, "恢复表路由应放行").toBe(200);
    const afterRestore = await libraryActions();
    expect(afterRestore.includes("edit_data"),
      "恢复表路由必须重算库节点，可写表拿回 edit_data").toBe(true);
  }, 120000);
});
