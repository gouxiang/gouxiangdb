// 通电前【存量全量投影】真库集成测试（临时库 + 真迁移，不经 HTTP，直接调域函数）。
//
// 覆盖：
//   1) 存量（双写前就存在的 scope 行）投影：计划有差异 -> 单事务应用 -> S=0；
//   2) 幂等：第二次计划 changed=0、第二次应用零写；
//   3) 空库不炸：无 scope 行/无库/无角色均返回空计划，不抛；
//   4) 单条 scope 的逐表位与字段档位展开正确（create 位 -> c/comment；hidden -> mask 收敛；
//      visible=0 时逐表配置不得单独放行）；
//   5) 通电前体检：数据面 READY/NOT_READY 判定（门与接线为注入的静态事实）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

type BackfillMod = typeof import("../scopeBackfill.js");
type PreflightMod = typeof import("../preflight.js");
let prisma: PrismaClient;
let tmpDir: string;
let planScopeBackfill: BackfillMod["planScopeBackfill"];
let applyScopeBackfill: BackfillMod["applyScopeBackfill"];
let computeScopeProjectionReconcile: typeof import("../scopeProjectionReconcile.js")["computeScopeProjectionReconcile"];
let computePreflightData: PreflightMod["computePreflightData"];
let evaluatePreflight: PreflightMod["evaluatePreflight"];
let nodeId: typeof import("../../nav/backfill.js")["nodeId"];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-scope-backfill-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  [planScopeBackfill, applyScopeBackfill] = await Promise.all([
    import("../scopeBackfill.js").then((m) => m.planScopeBackfill),
    import("../scopeBackfill.js").then((m) => m.applyScopeBackfill),
  ]);
  const recon = await import("../scopeProjectionReconcile.js");
  computeScopeProjectionReconcile = recon.computeScopeProjectionReconcile;
  const pf = await import("../preflight.js");
  computePreflightData = pf.computePreflightData;
  evaluatePreflight = pf.evaluatePreflight;
  nodeId = (await import("../../nav/backfill.js")).nodeId;
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CLEAR_TABLES = ["auth_policies", "role_library_scope", "fields", "tables", "bases", "roles", "users"];

beforeEach(async () => {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
  for (const t of CLEAR_TABLES) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
});

async function mkUser(id = "u1"): Promise<void> {
  await prisma.user.create({
    data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", workspaceId: "ws_default" },
  });
}

async function mkRole(id: string): Promise<void> {
  await prisma.role.create({
    data: { id, workspaceId: "ws_default", name: id, isSystem: id.startsWith("role_") ? 1 : 0, permissions: "[]" },
  });
}

async function mkBase(id: string): Promise<void> {
  await prisma.base.create({ data: { id, name: id, createdBy: "u1" } });
}

async function mkTable(baseId: string, id: string, fieldIds: string[]): Promise<void> {
  await prisma.table.create({ data: { id, baseId, name: id, primaryFieldId: fieldIds[0] ?? "f0", createdBy: "u1" } });
  let order = 0;
  for (const f of fieldIds) {
    await prisma.field.create({ data: { id: f, tableId: id, name: f, type: "singleLineText", order: order++ } });
  }
}

interface ScopeSeed {
  roleId: string;
  libraryId: string;
  libraryKind?: "base" | "kb";
  canManage?: number;
  visible?: number;
  canShare?: number;
  config?: unknown;
}

/** 直接插 role_library_scope（模拟双写上线前的存量行，绕过一切写路径钩子）。 */
async function mkScope(s: ScopeSeed): Promise<void> {
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

/** 标准夹具：u1 + b1(t1: f1,f2) + b2(t2: f3) + r1（b1 可见+建，f2 隐藏）+ role_admin（b1 管理）。 */
async function seed(): Promise<void> {
  await mkUser();
  await mkBase("b1");
  await mkTable("b1", "t1", ["f1", "f2"]);
  await mkBase("b2");
  await mkTable("b2", "t2", ["f3"]);
  await mkRole("r1");
  await mkRole("role_admin");
  await mkScope({
    roleId: "r1", libraryId: "b1", visible: 1,
    config: { tables: { t1: { create: true } }, fields: { t1: { f2: "hidden" } } },
  });
  await mkScope({ roleId: "role_admin", libraryId: "b1", canManage: 1, visible: 1 });
}

const policyOf = (subjectId: string, n: string) =>
  prisma.authPolicy.findFirstOrThrow({
    where: { nodeId: n, subjectType: "role", subjectId, reason: "scope:role" },
    select: { actions: true, fieldMask: true },
  });

describe("A 存量投影", () => {
  it("存量 scope 行（未经双写）投影前 0 行、计划有差异、应用后 S=0", async () => {
    await seed();
    expect(await prisma.authPolicy.count({ where: { reason: "scope:role" } })).toBe(0);

    const before = await planScopeBackfill(prisma);
    expect(before.totals.stored).toBe(0);
    expect(before.totals.toCreate).toBeGreaterThan(0);
    // role_admin 覆盖全部活库（含未配 scope 的 b2 隐含只读）：b1 库节点+表 + b2 库节点+表 = 4
    expect(before.roles.find((r) => r.roleId === "role_admin")?.toCreate).toBe(4);
    expect(before.roles.find((r) => r.roleId === "r1")?.toCreate).toBe(1);

    const fix = await prisma.$transaction((tx) => applyScopeBackfill(tx, before, "tester"));
    expect(fix.created).toBe(before.totals.toCreate);
    expect(fix.updated).toBe(0);
    expect(fix.deleted).toBe(0);

    expect(await computeScopeProjectionReconcile(prisma)).toEqual([]);
  });

  it("只碰 scope:role，role_owner 的硬短路台账行不投影（计入 skipped）", async () => {
    await seed();
    await mkRole("role_owner");
    await mkScope({ roleId: "role_owner", libraryId: "b1", canManage: 1, visible: 1 });

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
    await mkUser();
    await mkRole("r1");
    await mkScope({ roleId: "r1", libraryId: "b_gone", visible: 1 });
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
    const adminB1 = await policyOf("role_admin", nodeId("base", "b1"));
    expect(adminB1.actions.split(",").sort()).toEqual(["manage_schema", "manage_share", "manage_table"]);
    const adminT2 = await policyOf("role_admin", nodeId("table", "t2"));
    expect(adminT2.actions).toBe("r");
    const adminB2 = await policyOf("role_admin", nodeId("base", "b2"));
    expect(adminB2.actions).toBe("manage_share");
  });

  it("manage_schema 同时落在库节点与表节点（七守按 base 节点判）；只读成员两处都没有", async () => {
    await mkUser();
    await mkBase("b1");
    await mkTable("b1", "t1", ["f1"]);
    await mkRole("r_manage");
    await mkRole("r_read");
    await mkScope({ roleId: "r_manage", libraryId: "b1", canManage: 1, visible: 1 });
    await mkScope({ roleId: "r_read", libraryId: "b1", visible: 1 });

    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));

    // canManage=1：库节点必须带 manage_schema，否则 on 态 requireCanManageSchema 会 OVERDENY 403
    const mBase = await policyOf("r_manage", nodeId("base", "b1"));
    expect(mBase.actions.split(",").sort()).toEqual(["manage_schema", "manage_share", "manage_table"]);
    const mTable = await policyOf("r_manage", nodeId("table", "t1"));
    expect(mTable.actions.split(",").sort()).toEqual(["c", "comment", "d", "manage_schema", "r", "u"]);

    // 只读成员：库节点无策略行、表节点无结构权
    expect(await prisma.authPolicy.count({
      where: { nodeId: nodeId("base", "b1"), subjectId: "r_read", reason: "scope:role" },
    })).toBe(0);
    const rTable = await policyOf("r_read", nodeId("table", "t1"));
    expect(rTable.actions).toBe("r");
  });

  it("kb 的 canManage 不得把 manage_schema 挂到 kb 节点（kind-动作仅 table/base 合法）", async () => {
    await mkUser();
    await prisma.knowledgeBase.create({ data: { id: "kb1", name: "kb1", createdBy: "u1" } });
    await mkRole("r_kb");
    await mkScope({ roleId: "r_kb", libraryKind: "kb", libraryId: "kb1", canManage: 1, visible: 1 });

    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));

    const kbPolicy = await policyOf("r_kb", nodeId("kb", "kb1"));
    expect(kbPolicy.actions.includes("manage_schema")).toBe(false);
    expect(kbPolicy.actions.split(",").sort()).toEqual(["c", "comment", "d", "manage_share", "manage_table", "r", "u"]);
  });

  it("visible=0 但逐表勾 create：不得单独放行（期望 0 条）", async () => {
    await mkUser();
    await mkBase("b1");
    await mkTable("b1", "t1", ["f1"]);
    await mkRole("r2");
    await mkScope({ roleId: "r2", libraryId: "b1", visible: 0, config: { tables: { t1: { create: true } } } });

    const p = await planScopeBackfill(prisma);
    expect(p.roles.find((r) => r.roleId === "r2")?.expected).toBe(0);
    expect(p.totals.changed).toBe(0);
  });
});

describe("E 通电前体检", () => {
  const wiredFacts = (enforceReady: boolean) => ({
    enforceReady,
    hooks: [{ hook: "rebuildScopePoliciesTx", required: true, why: "PUT 主路径", callSites: ["src/x.ts:1"] }],
  });

  it("存量未投影 -> NOT_READY（覆盖缺口 + S1）", async () => {
    await seed();
    const data = await computePreflightData(prisma);
    expect(data.coverage.gap).toBeGreaterThan(0);
    expect(data.coverage.rolesWithoutProjection).toContain("role_admin");
    const r = evaluatePreflight(data, wiredFacts(true));
    expect(r.verdict).toBe("NOT_READY");
    expect(r.blocking.some((b) => b.includes("存量覆盖缺口"))).toBe(true);
  });

  it("投影完成 + 门已翻 -> READY；门未翻 -> NOT_READY", async () => {
    await seed();
    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));

    const data = await computePreflightData(prisma);
    expect(data.coverage.gap).toBe(0);
    expect(data.coverage.rolesWithoutProjection).toEqual([]);
    expect(data.coverage.scopeRows).toBe(2);
    // A 段可能含 A3（scope 投影动作串恰等于旧角色档的已知噪声），按 runbook 只报不改 -> 提示。
    expect(data.reconcile.summary).toMatchObject({ B: 0, C: 0, S: 0 });
    expect(data.reconcile.byCode.every((x) => x.kind === "advisory")).toBe(true);

    expect(evaluatePreflight(data, wiredFacts(true)).verdict).toBe("READY");
    const notReady = evaluatePreflight(data, wiredFacts(false));
    expect(notReady.verdict).toBe("NOT_READY");
    expect(notReady.blocking.some((b) => b.includes("AUTHZ_ENFORCE_READY"))).toBe(true);
  });

  it("主路径双写钩子缺失 -> 阻断；结构性钩子缺失 -> 仅提示", async () => {
    await seed();
    const p = await planScopeBackfill(prisma);
    await prisma.$transaction((tx) => applyScopeBackfill(tx, p, "tester"));
    const data = await computePreflightData(prisma);

    const missingMain = evaluatePreflight(data, {
      enforceReady: true,
      hooks: [{ hook: "rebuildScopePoliciesTx", required: true, why: "PUT 主路径", callSites: [] }],
    });
    expect(missingMain.verdict).toBe("NOT_READY");
    expect(missingMain.blocking.some((b) => b.includes("rebuildScopePoliciesTx"))).toBe(true);

    const missingStructural = evaluatePreflight(data, {
      enforceReady: true,
      hooks: [{ hook: "resyncTableMaskTx", required: false, why: "字段重算", callSites: [] }],
    });
    expect(missingStructural.verdict).toBe("READY");
    expect(missingStructural.advisory.some((a) => a.includes("resyncTableMaskTx"))).toBe(true);
  });
});
