// 通电前【存量全量投影】真库集成测试（临时库 + 真迁移，不经 HTTP，直接调域函数）。
//
// 覆盖：
//   1) 存量（双写前就存在的 scope 行）投影：计划有差异 -> 单事务应用 -> S=0；
//   2) 幂等：第二次计划 changed=0、第二次应用零写；
//   3) 空库不炸：无 scope 行/无库/无角色均返回空计划，不抛；
//   4) 逐表位与字段档位展开正确（create 位 -> c/comment；hidden -> mask 收敛；
//      visible=0 时逐表配置不得单独放行；manage_schema 库/表双落点）。
// 通电前体检（含库级判定可达性）的用例在 preflight.test.ts。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { nodeId } from "../../nav/backfill.js";
import {
  createAuthzTempDb, resetTables, mkUser, mkRole, mkBase, mkTable, mkScope, seedFixture,
} from "./scopeBackfillFixture.js";

let prisma: PrismaClient;
let cleanup: () => void;
let planScopeBackfill: typeof import("../scopeBackfill.js")["planScopeBackfill"];
let applyScopeBackfill: typeof import("../scopeBackfill.js")["applyScopeBackfill"];
let computeScopeProjectionReconcile: typeof import("../scopeProjectionReconcile.js")["computeScopeProjectionReconcile"];

beforeAll(async () => {
  const db = createAuthzTempDb("gx-scope-backfill-");
  prisma = db.prisma;
  cleanup = db.cleanup;
  const backfill = await import("../scopeBackfill.js");
  planScopeBackfill = backfill.planScopeBackfill;
  applyScopeBackfill = backfill.applyScopeBackfill;
  computeScopeProjectionReconcile = (await import("../scopeProjectionReconcile.js")).computeScopeProjectionReconcile;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

beforeEach(async () => {
  await resetTables(prisma);
});

const policyOf = (subjectId: string, n: string) =>
  prisma.authPolicy.findFirstOrThrow({
    where: { nodeId: n, subjectType: "role", subjectId, reason: "scope:role" },
    select: { actions: true, fieldMask: true },
  });

const seed = (): Promise<void> => seedFixture(prisma);

describe("A 存量投影", () => {
  it("存量 scope 行（未经双写）投影前 0 行、计划有差异、应用后 S=0", async () => {
    await seed();
    expect(await prisma.authPolicy.count({ where: { reason: "scope:role" } })).toBe(0);

    const before = await planScopeBackfill(prisma);
    expect(before.totals.stored).toBe(0);
    expect(before.totals.toCreate).toBeGreaterThan(0);
    // role_admin 覆盖全部活库（含未配 scope 的 b2 隐含只读）：b1 库节点+表 + b2 库节点+表 = 4
    expect(before.roles.find((r) => r.roleId === "role_admin")?.toCreate).toBe(4);
    // r1：b1 可见 + t1.create -> 库节点（enter+edit_data）+ 表节点（r,c,comment） = 2
    expect(before.roles.find((r) => r.roleId === "r1")?.toCreate).toBe(2);

    const fix = await prisma.$transaction((tx) => applyScopeBackfill(tx, before, "tester"));
    expect(fix.created).toBe(before.totals.toCreate);
    expect(fix.updated).toBe(0);
    expect(fix.deleted).toBe(0);

    expect(await computeScopeProjectionReconcile(prisma)).toEqual([]);
  });

  it("只碰 scope:role，role_owner 的硬短路台账行不投影（计入 skipped）", async () => {
    await seed();
    await mkRole(prisma, "role_owner");
    await mkScope(prisma, { roleId: "role_owner", libraryId: "b1", canManage: 1, visible: 1 });

    const before = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, before, "tester"));
    expect(await prisma.authPolicy.count({ where: { subjectId: "role_owner" } })).toBe(0);
    expect(before.roles.find((r) => r.roleId === "role_owner")?.expected).toBe(0);
  });
});

describe("B 幂等", () => {
  it("第二次计划 changed=0、第二次应用零写", async () => {
    await seed();
    const first = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, first, "tester"));

    const second = await planScopeBackfill(prisma);
    expect(second.totals.changed).toBe(0);
    expect(second.totals.expected).toBe(second.totals.stored);

    const fix2 = await prisma.$transaction((tx) => applyScopeBackfill(tx, second, "tester"));
    expect(fix2).toEqual({ created: 0, updated: 0, deleted: 0, skipped: 0 });
    expect(await computeScopeProjectionReconcile(prisma)).toEqual([]);
  });
});

describe("C 空库与无配置不炸", () => {
  it("全空库：空计划 + 零写", async () => {
    const p = await planScopeBackfill(prisma);
    expect(p.roles).toEqual([]);
    expect(p.totals.changed).toBe(0);
    const fix = await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));
    expect(fix.created + fix.updated + fix.deleted).toBe(0);
  });

  it("有角色无库、有 scope 行指向已删库：不产生投影也不报错", async () => {
    await mkUser(prisma);
    await mkRole(prisma, "r1");
    await mkScope(prisma, { roleId: "r1", libraryId: "b_gone", visible: 1 });
    const p = await planScopeBackfill(prisma);
    expect(p.totals.expected).toBe(0);
    expect(p.totals.changed).toBe(0);
    await expect(prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"))).resolves.toBeTruthy();
  });
});

describe("D 逐表位与字段档位展开", () => {
  it("create 位 -> c/comment；hidden 字段收敛 mask；visible=0 时逐表配置不放行", async () => {
    await seed();
    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));

    // r1：b1 可见 + t1.create -> r,c,comment；f2 hidden -> allow=[f1]（f1 未显式配置默认 editable）
    const r1 = await policyOf("r1", nodeId("table", "t1"));
    expect(r1.actions.split(",").sort()).toEqual(["c", "comment", "r"]);
    expect(JSON.parse(r1.fieldMask as string)).toEqual({ allowFields: ["f1"], readOnlyFields: [] });

    // role_admin：b1 canManage -> 全权 + manage_schema；b2 无 scope 行 -> 隐含只读 + manage_share
    const adminT1 = await policyOf("role_admin", nodeId("table", "t1"));
    expect(adminT1.actions.split(",").sort()).toEqual(["c", "comment", "d", "manage_schema", "r", "u"]);
    // 库节点：canManage -> manage_schema 必须同挂（七守 requireCanManageSchema 按 base 节点判）
    // 另含两枚聚合位：enter（库级准入）+ edit_data（canManage 隐含可写）
    const adminB1 = await policyOf("role_admin", nodeId("base", "b1"));
    expect(adminB1.actions.split(",").sort()).toEqual([
      "edit_data", "enter", "manage_schema", "manage_share", "manage_table",
    ]);
    const adminT2 = await policyOf("role_admin", nodeId("table", "t2"));
    expect(adminT2.actions).toBe("r");
    // b2 无 admin scope 行：隐含只读 -> enter + manage_share，无 edit_data（不可写）
    const adminB2 = await policyOf("role_admin", nodeId("base", "b2"));
    expect(adminB2.actions.split(",").sort()).toEqual(["enter", "manage_share"]);
  });

  it("manage_schema 同时落在库节点与表节点（七守按 base 节点判）；只读成员两处都没有", async () => {
    await mkUser(prisma);
    await mkBase(prisma, "b1");
    await mkTable(prisma, "b1", "t1", ["f1"]);
    await mkRole(prisma, "r_manage");
    await mkRole(prisma, "r_read");
    await mkScope(prisma, { roleId: "r_manage", libraryId: "b1", canManage: 1, visible: 1 });
    await mkScope(prisma, { roleId: "r_read", libraryId: "b1", visible: 1 });

    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));

    // canManage=1：库节点必须带 manage_schema，否则 on 态 requireCanManageSchema 会 OVERDENY 403
    const mBase = await policyOf("r_manage", nodeId("base", "b1"));
    expect(mBase.actions.split(",").sort()).toEqual([
      "edit_data", "enter", "manage_schema", "manage_share", "manage_table",
    ]);
    const mTable = await policyOf("r_manage", nodeId("table", "t1"));
    expect(mTable.actions.split(",").sort()).toEqual(["c", "comment", "d", "manage_schema", "r", "u"]);

    // 只读成员：库节点只有一枚 enter（准入），不带任何管理位、不带 edit_data
    const rBase = await policyOf("r_read", nodeId("base", "b1"));
    expect(rBase.actions).toBe("enter");
    const rTable = await policyOf("r_read", nodeId("table", "t1"));
    expect(rTable.actions).toBe("r");
  });

  it("kb 的 canManage 不得把 manage_schema 挂到 kb 节点（kind-动作仅 table/base 合法）", async () => {
    await mkUser(prisma);
    await prisma.knowledgeBase.create({ data: { id: "kb1", name: "kb1", createdBy: "u1" } });
    await mkRole(prisma, "r_kb");
    await mkScope(prisma, { roleId: "r_kb", libraryKind: "kb", libraryId: "kb1", canManage: 1, visible: 1 });

    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));

    const kbPolicy = await policyOf("r_kb", nodeId("kb", "kb1"));
    expect(kbPolicy.actions.includes("manage_schema")).toBe(false);
    // kb 只 emit enter，不 emit edit_data（§7.2-3：kb 内容写关在 content 档位上）
    expect(kbPolicy.actions.includes("enter")).toBe(true);
    expect(kbPolicy.actions.includes("edit_data")).toBe(false);
    // canManage=1 -> 建链位 share_link 随之投影（字典序位于 r/u 之间）；manage_schema 仍不挂 kb。
    expect(kbPolicy.actions.split(",").sort()).toEqual([
      "c", "comment", "d", "enter", "manage_share", "manage_table", "r", "share_link", "u",
    ]);
  });

  it("visible=0 但逐表勾 create：不得单独放行（期望 0 条）", async () => {
    await mkUser(prisma);
    await mkBase(prisma, "b1");
    await mkTable(prisma, "b1", "t1", ["f1"]);
    await mkRole(prisma, "r2");
    await mkScope(prisma, { roleId: "r2", libraryId: "b1", visible: 0, config: { tables: { t1: { create: true } } } });

    const p = await planScopeBackfill(prisma);
    expect(p.roles.find((r) => r.roleId === "r2")?.expected).toBe(0);
    expect(p.totals.changed).toBe(0);
  });
});
