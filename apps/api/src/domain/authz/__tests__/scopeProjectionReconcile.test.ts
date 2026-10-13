// P1/S8a scope 投影对账（S 段）真库集成测试：临时库 + 真迁移 + 真 HTTP（PUT/seed 主路径），
// 再直调 computeAuthzReconcile / applyAuthzReconcileFixes。
//   1) 干净态：经正常 POST 建库建表 + PUT 普通角色后对账 S=0；
//   2) 变异注入 S1/S2/S3/S4 逐类识别，ref=roleId|nodeId；
//   3) --apply 修复后 S=0、legacy 行计数不变，连跑第二次 no changes；
//   4) admin 漏投影（删未配 scope 库的隐含只读行）-> S1，apply 补回；
//   5) C5：合法 RowConditions 放行；坏 JSON/非法 op 报 C5_CONDITIONS_INVALID。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, json, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { projectAdminForNewLibraryTx } from "../scopeDoubleWrite.js";
import { legacyActionString } from "../backfill.js";
import type { AuthzClient } from "../types.js";

const projectAdminForLibrary = (client: AuthzClient, id: string): Promise<void> =>
  projectAdminForNewLibraryTx(client, "base", id, "owner");

let h: CharHarness;
let tx: AuthzClient;
let compute: typeof import("../reconcile.js").computeAuthzReconcile;
let applyFix: typeof import("../reconcile.js").applyAuthzReconcileFixes;

let tableNode: string;

async function call(method: string, url: string, user: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = await h.auth(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-s8a-scope-recon-");
  await h.createUser("owner");
  await h.grantRole("owner");

  // 干净起点：直接造 base + nav base 节点 + admin/owner scope 行（不经 POST /api/bases——
  // 其自动 starter 表尚未投影，那是 P1-S7 #3 的待接线点，与本片对账无关）。
  // 随后经【已完整接线】的 POST /api/tables 建表，确保各角色投影齐全。
  const baseId = "b1";
  const base2Id = "b2";
  await h.prisma.$transaction(async (pr) => {
    for (const id of [baseId, base2Id]) {
      await pr.base.create({ data: { id, name: `${id} 库`, createdBy: "owner" } });
      await pr.navNode.create({
        data: {
          id: nodeId("base", id), workspaceId: "ws_default", kind: "base",
          resourceType: "base", resourceId: id, name: id, path: `/${nodeId("base", id)}/`, depth: 0, isSystem: 1,
        },
      });
      await pr.roleLibraryScope.createMany({
        data: [
          { roleId: "role_owner", libraryKind: "base", libraryId: id, canManage: 1, visible: 1 },
          { roleId: "role_admin", libraryKind: "base", libraryId: id, canManage: 1, visible: 1 },
        ],
      });
      // 补 admin 库节点初始投影（seedAdminScopeTx 通常内部触发，直接造库须显式调）。
      await projectAdminForLibrary(pr as unknown as AuthzClient, id);
    }
  });

  const tableRes = await call("POST", `/api/tables?baseId=${baseId}`, "owner", { name: "t1" });
  expect(tableRes.status).toBe(201);
  const tableId = (await json<{ table: { id: string } }>(tableRes)).table.id;
  tableNode = nodeId("table", tableId);

  // b2 是【未配 r1 scope】的活库活表，用于 admin 漏投影场景。
  const table2Res = await call("POST", `/api/tables?baseId=${base2Id}`, "owner", { name: "t2" });
  expect(table2Res.status).toBe(201);
  const table2Id = (await json<{ table: { id: string } }>(table2Res)).table.id;

  // 普通角色 r1：对 b1 可见可建（投影 table 节点 r,c,comment）。
  await h.prisma.role.upsert({
    where: { id: "r1" },
    create: { id: "r1", workspaceId: "ws_default", name: "r1", isSystem: 0, permissions: "[]" },
    update: {},
  });
  const put = await call("PUT", "/api/v1/org/library-scopes", "owner", {
    roleId: "r1",
    items: [{ libraryKind: "base", libraryId: baseId, visible: true, config: { tables: { [tableId]: { create: true } } } }],
  });
  expect(put.status).toBe(200);

  // 动态 import 对账模块（复用真库，不拖 db 单例；本文件静态侧已只触 harness）。
  const mod = await import("../reconcile.js");
  compute = mod.computeAuthzReconcile;
  applyFix = mod.applyAuthzReconcileFixes;
  tx = h.prisma as unknown as AuthzClient;

  // 记录关键节点供各用例引用。
  (h as unknown as { baseId: string }).baseId = baseId;
  (h as unknown as Record<string, string>).tableId = tableId;
  (h as unknown as Record<string, string>).base2Id = base2Id;
  (h as unknown as Record<string, string>).table2Id = table2Id;
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("干净态 scope 对账", () => {
  it("经 seed + PUT 建库建表后 S=0（含 admin 覆盖与普通角色投影）", async () => {
    const r = await compute(tx);
    expect(r.S).toEqual([]);
    expect(r.summary.S).toBe(0);
  });
});

describe("变异注入 S1-S4", () => {
  it("S1 删一条 scope:role -> MISSING；ref/message 正确", async () => {
    const deleted = await h.prisma.authPolicy.deleteMany({
      where: { nodeId: tableNode, subjectType: "role", subjectId: "r1", reason: "scope:role" },
    });
    expect(deleted.count).toBe(1);

    const r = await compute(tx);
    const s1 = r.S.filter((d) => d.code === "S1_MISSING");
    expect(s1.some((d) => d.ref === `r1|${tableNode}`)).toBe(true);
    expect(s1.find((d) => d.ref === `r1|${tableNode}`)?.message).toContain("缺少 scope 投影");
  });

  it("S2 翻转一个 action -> ACTION_MISMATCH", async () => {
    await h.prisma.authPolicy.updateMany({
      where: { nodeId: tableNode, subjectType: "role", subjectId: "role_admin", reason: "scope:role" },
      data: { actions: "r,comment" }, // 原为含 c/u/d/manage_schema 的管理档
    });
    const r = await compute(tx);
    const s2 = r.S.filter((d) => d.code === "S2_ACTION_MISMATCH");
    expect(s2.some((d) => d.ref === `role_admin|${tableNode}`)).toBe(true);
    const msg = s2.find((d) => d.ref === `role_admin|${tableNode}`)!.message;
    expect(msg).toContain("动作不一致");
  });

  it("S3 改 mask allowFields -> MASK_MISMATCH", async () => {
    // 给 r1 造一个带 mask 的期望：先在其 scope 上加 per-field hidden，重 PUT 得非空 mask，
    // 再直接篡改现存 mask。
    const { tableId, baseId } = h as unknown as { tableId: string; baseId: string };
    const fieldId = (await h.prisma.field.findFirstOrThrow({ where: { tableId }, select: { id: true } })).id;
    const put = await call("PUT", "/api/v1/org/library-scopes", "owner", {
      roleId: "r1",
      items: [{
        libraryKind: "base", libraryId: baseId, visible: true,
        config: { tables: { [tableId]: { create: true } }, fields: { [tableId]: { [fieldId]: "hidden" } } },
      }],
    });
    expect(put.status).toBe(200);
    const before = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: tableNode, subjectId: "r1", reason: "scope:role" },
    });
    expect(before.fieldMask).not.toBeNull();
    await h.prisma.authPolicy.update({
      where: { id: before.id },
      data: { fieldMask: JSON.stringify({ allowFields: ["FAKE_FIELD"], readOnlyFields: [] }) },
    });

    const r = await compute(tx);
    const s3 = r.S.filter((d) => d.code === "S3_MASK_MISMATCH");
    expect(s3.some((d) => d.ref === `r1|${tableNode}`)).toBe(true);
  });

  it("S4 插一条多余 scope:role 到无期望节点 -> ORPHAN", async () => {
    const orphanNode = nodeId("base", "base_no_scope");
    await h.prisma.authPolicy.create({
      data: {
        id: "pol_s4_orphan", workspaceId: "ws_default", nodeId: orphanNode,
        subjectType: "role", subjectId: "r1", actions: "r", reason: "scope:role", createdBy: "mutate",
      },
    });
    const r = await compute(tx);
    const s4 = r.S.filter((d) => d.code === "S4_ORPHAN");
    expect(s4.some((d) => d.ref === `r1|${orphanNode}`)).toBe(true);
  });
});

describe("--apply 修复 S 段", () => {
  it("四类差异修复后 S=0，legacy 行计数不变", async () => {
    const legacyBefore = await h.prisma.authPolicy.count({ where: { reason: { startsWith: "legacy:" } } });
    const fix = await applyFix(tx);
    expect(fix.created + fix.deleted).toBeGreaterThan(0);

    const after = await compute(tx);
    expect(after.S).toEqual([]);
    const legacyAfter = await h.prisma.authPolicy.count({ where: { reason: { startsWith: "legacy:" } } });
    expect(legacyAfter).toBe(legacyBefore);
  });

  it("连跑第二次 no changes（幂等）", async () => {
    const fix2 = await applyFix(tx);
    expect(fix2.created + fix2.updated + fix2.deleted).toBe(0);
  });
});

describe("admin 漏投影", () => {
  it("删未配 scope 库的 admin 隐含只读行 -> S1，apply 补回", async () => {
    const { table2Id } = h as unknown as { table2Id: string };
    const node2 = nodeId("table", table2Id);
    const deleted = await h.prisma.authPolicy.deleteMany({
      where: { nodeId: node2, subjectType: "role", subjectId: "role_admin", reason: "scope:role" },
    });
    expect(deleted.count).toBe(1);

    const r1 = await compute(tx);
    expect(r1.S.some((d) => d.code === "S1_MISSING" && d.ref === `role_admin|${node2}`)).toBe(true);

    await applyFix(tx);
    const r2 = await compute(tx);
    expect(r2.S).toEqual([]);
  });
});

describe("C5 行级条件放行", () => {
  it("合法 RowConditions 不报 C5；坏 JSON/非法 op 报 C5_CONDITIONS_INVALID", async () => {
    const { tableId } = h as unknown as { tableId: string };
    const fieldId = (await h.prisma.field.findFirstOrThrow({ where: { tableId }, select: { id: true } })).id;
    const valid = JSON.stringify({
      version: 1,
      filter: { kind: "condition", fieldId, op: "is", value: "x" },
    });
    // 合法：临时造一条带合法 conditions 的行，C5 不应出现其 id。
    await h.prisma.authPolicy.create({
      data: {
        id: "pol_c5_valid", workspaceId: "ws_default", nodeId: nodeId("table", "tbl_c5"),
        subjectType: "user", subjectId: "owner", actions: "r", reason: "manual",
        conditions: valid, createdBy: "mutate",
      },
    });

    await h.prisma.authPolicy.create({
      data: {
        id: "pol_c5_badjson", workspaceId: "ws_default", nodeId: nodeId("table", "tbl_c5_bj"),
        subjectType: "user", subjectId: "owner", actions: "r", reason: "manual",
        conditions: "{not json", createdBy: "mutate",
      },
    });
    await h.prisma.authPolicy.create({
      data: {
        id: "pol_c5_badop", workspaceId: "ws_default", nodeId: nodeId("table", "tbl_c5_bo"),
        subjectType: "user", subjectId: "owner", actions: "r", reason: "manual",
        conditions: JSON.stringify({ version: 1, filter: { kind: "condition", fieldId, op: "HACK", value: 1 } }),
        createdBy: "mutate",
      },
    });

    const r = await compute(tx);
    const c5 = r.C.filter((d) => d.code === "C5_CONDITIONS_INVALID");
    expect(c5.some((d) => d.ref === "pol_c5_badjson")).toBe(true);
    expect(c5.some((d) => d.ref === "pol_c5_badop")).toBe(true);
    expect(c5.some((d) => d.ref === "pol_c5_valid")).toBe(false);
  });
});

// P1/S8a 接线缺陷回归：A3「疑似手工污染」不得命中机器投影 scope:role 行，否则与 S 段互斥、
// project-scope --apply 补出的投影恒定触发 A3 且只报不改、reconcile rc 永远非 0。
describe("A3 豁免机器 scope:role 投影（仍抓真手工行）", () => {
  it("(a) scope:role 行动作串恰等于 base creator 旧档：不报 A3，但 S4 仍把它当多余投影对账", async () => {
    // 真实缺陷现场：project-scope 在 table 节点补出的角色投影动作串恰为 base creator 档。
    const creatorActions = legacyActionString("base", "creator");
    const scopeNode = nodeId("base", "base_no_scope_a3");
    await h.prisma.authPolicy.create({
      data: {
        id: "pol_a3_scope_role", workspaceId: "ws_default", nodeId: scopeNode,
        subjectType: "role", subjectId: "r1", actions: creatorActions,
        reason: "scope:role", createdBy: "owner", // 机器行 createdBy 是真实操作人，故豁免只认 reason
      },
    });

    const r = await compute(tx);
    expect(r.A.some((d) => d.code === "A3_MANUAL_MATCHES_LEGACY" && d.ref === "pol_a3_scope_role")).toBe(false);
    // S 段照常管理 scope:role 漂移：无期望节点上的投影 -> S4_ORPHAN，一个都不许豁免。
    expect(r.S.some((d) => d.code === "S4_ORPHAN" && d.ref === `r1|${scopeNode}`)).toBe(true);
  });

  it("(b) 非 legacy、非 scope:role 的手工行动作串命中旧档：仍报 A3（豁免未扩大到手工行）", async () => {
    const creatorActions = legacyActionString("base", "creator");
    await h.prisma.authPolicy.create({
      data: {
        id: "pol_a3_manual", workspaceId: "ws_default", nodeId: nodeId("table", "tbl_a3_manual"),
        subjectType: "user", subjectId: "owner", actions: creatorActions,
        reason: "manual-grant", createdBy: "owner",
      },
    });

    const r = await compute(tx);
    expect(r.A.some((d) => d.code === "A3_MANUAL_MATCHES_LEGACY" && d.ref === "pol_a3_manual")).toBe(true);
  });
});
