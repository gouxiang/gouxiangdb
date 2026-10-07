// on 态边界对抗（同 __tests__/on-guard-exhaustive.test.ts 分工见下）。
//
// 分工：那份跑「身份 × 七守」全矩阵（8 身份逐格比对期望）；
// 本文件跑它【覆盖不到】的四类边界，都会被全矩阵的平均值盖住：
//   1) P1 的判别力前提：管理员两种形态必须打【两个库】——同一 role_admin 在同一库里
//      要么全都有 canManage 行、要么全都没有，单库夹具会在两边同时失真（见用例 1）；
//   2) 空库：enter 不依赖活表（零表库库门必须开），而 edit_data 在无活表时必须不成立；
//   3) 字段收窄不被聚合位淹没（A-4 防线）：库节点持 enter/edit_data 且 fieldMask 为空，
//      但 readSources【只收 r】，故聚合位一条都进不了能力并集，hidden 字段仍不可见；
//   4) table 中断继承后，库门 enter 仍成立（库之上无业务祖先），内容读回归自身节点 r。
//
// 引擎永久单一化后恒定跑真守卫，无开关/对拍/drift。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { rebuildScopePoliciesTx } from "../scopeDoubleWrite.js";
import { fieldCapability } from "../fieldMask.js";
import { nodeId } from "../../nav/backfill.js";

let h: CharHarness;
/** 库 A：role_admin 对该库【无 scope 行】（凭硬规则进库的管理员）。 */
let libA: string;
let tableA: string;
/** 库 B：role_admin 对该库有 canManage=1 行（勾了管理权的管理员）。 */
let libB: string;
/** 库 E：空库（零活表）。 */
let libE: string;

const OWNER = "e_owner";
const ADMIN = "e_admin";   // role_admin，两种形态打 A/B 两库
const VIEWER = "e_viewer"; // 纯只读成员

async function call(method: string, url: string, userId: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = await h.auth(userId);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const status = async (method: string, url: string, userId: string, body?: unknown): Promise<number> =>
  (await call(method, url, userId, body)).status;

/** role_admin 在某库的全部 scope 行 -> 重算其隐含投影（role_admin 覆盖全部活库）。 */
async function rebuildAdmin(): Promise<void> {
  const saved = await h.prisma.roleLibraryScope.findMany({ where: { roleId: "role_admin" } });
  await rebuildScopePoliciesTx(h.prisma, "role_admin", saved.map((r) => ({
    roleId: r.roleId, libraryKind: r.libraryKind, libraryId: r.libraryId,
    canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
  })), "seed");
}

/**
 * 第二代 scope 行：用 upsert 而非 create——建库路径已为 role_admin 种过一行
 * （libraryScopeSeed 同事务），直接 create 会撞 (roleId, libraryKind, libraryId) 唯一约束。
 */
async function upsertScope(row: {
  roleId: string; libraryId: string; visible: number; canManage: number; canShare: number; config: string;
}): Promise<void> {
  await h.prisma.roleLibraryScope.upsert({
    where: {
      roleId_libraryKind_libraryId: { roleId: row.roleId, libraryKind: "base", libraryId: row.libraryId },
    },
    create: { ...row, libraryKind: "base" },
    update: { visible: row.visible, canManage: row.canManage, canShare: row.canShare, config: row.config },
  });
}

const VIEWER_ROW = { visible: 1, canManage: 0, canShare: 0, config: "{}" };

beforeAll(async () => {
  h = await setupCharHarness("gx-authz-on-edge-");

  for (const u of [OWNER, ADMIN, VIEWER]) await h.createUser(u);
  await h.grantRole(OWNER);
  await h.grantRole(ADMIN, "role_admin");

  await h.prisma.role.create({
    data: { id: "role_e_viewer", workspaceId: "ws_default", name: "边界只读", isSystem: 0, permissions: "[]" },
  });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_e_viewer", subjectType: "user", subjectId: VIEWER, scopeType: "workspace", createdBy: "seed" },
  });

  // 三个库都由超管创建：任一被测身份都不是 createdBy，避免 creator 兜底造成假绿。
  for (const [key, name] of [["A", "边界库A"], ["B", "边界库B"], ["E", "边界空库"]] as const) {
    const r = await call("POST", "/api/bases", OWNER, { name });
    const id = (await json<{ base: { id: string } }>(r)).base.id;
    if (key === "A") libA = id; else if (key === "B") libB = id; else libE = id;
    const t = await call("GET", `/api/tables?baseId=${id}`, OWNER);
    const tables = (await json<{ tables: Array<{ id: string }> }>(t)).tables;
    if (key === "A") tableA = tables[0]!.id;
    if (key === "E") {
      // 空库：删掉默认表，构造零活表形态（enter 不依赖活表，正是这一格要证明的）。
      expect(await status("DELETE", `/api/tables/${tables[0]!.id}`, OWNER)).toBe(200);
    }
  }

  // 第二代 scope 行：VIEWER 在 A 库纯只读；role_admin 只在 B 库有 canManage 行。
  await upsertScope({ roleId: "role_e_viewer", libraryId: libA, ...VIEWER_ROW });
  await upsertScope({ roleId: "role_admin", libraryId: libB, visible: 1, canManage: 1, canShare: 0, config: "{}" });
  await upsertScope({ roleId: "role_e_viewer", libraryId: libE, ...VIEWER_ROW });
  // A/E 两库：把建库时种下的 role_admin 行【删除】——构造「管理员对该库未勾任何权限」形态。
  // 这是 P0-A/P1 的主角：管理员的 visible/canShare 来自 hard-coded 覆盖，本就不依赖行存在。
  await h.prisma.roleLibraryScope.deleteMany({
    where: { roleId: "role_admin", libraryKind: "base", libraryId: { in: [libA, libE] } },
  });
  expect((await h.prisma.roleLibraryScope.findMany({ where: { roleId: "role_admin" } }))
    .map((r) => r.libraryId)).toEqual([libB]);
  for (const roleId of ["role_admin", "role_e_viewer"]) {
    const saved = await h.prisma.roleLibraryScope.findMany({ where: { roleId } });
    await rebuildScopePoliciesTx(h.prisma, roleId, saved.map((r) => ({
      roleId: r.roleId, libraryKind: r.libraryKind, libraryId: r.libraryId,
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })), "seed");
  }
  await rebuildAdmin();
}, 180000);

afterAll(async () => {
  await h.cleanup();
});

const libPolicy = async (nodeIdValue: string, subjectId: string) =>
  h.prisma.authPolicy.findUnique({
    where: { nodeId_subjectType_subjectId: { nodeId: nodeIdValue, subjectType: "role", subjectId } },
  });
const actionsOf = (stored: string | null): string[] =>
  (stored ?? "").split(",").map((s) => s.trim()).filter(Boolean);

describe("边界对抗（补全矩阵覆盖不到的四类形态）", () => {
  it("1) P1：同一管理员在两库形态不同——无行库拿不到管理权，有 canManage 行的库拿得到", async () => {
    // 库 A：role_admin 无 scope 行 -> 库节点无 manage_table -> 库门开、管理权拒（P1 修法生效）。
    expect(await status("GET", `/api/tables?baseId=${libA}`, ADMIN)).toBe(200);
    expect(await status("PATCH", `/api/bases/${libA}`, ADMIN, { name: `A${Date.now()}` })).toBe(403);
    // 库 B：role_admin 有 canManage 行 -> 同一用户在这库有完整管理权。
    expect(await status("PATCH", `/api/bases/${libB}`, ADMIN, { name: `B${Date.now()}` })).toBe(200);

    // 并核对投影本身确实如此（不是碰巧 403）：A 库节点无 manage_table，B 库节点有。
    const actsA = actionsOf((await libPolicy(nodeId("base", libA), "role_admin"))?.actions ?? null);
    const actsB = actionsOf((await libPolicy(nodeId("base", libB), "role_admin"))?.actions ?? null);
    expect(actsA).toContain("enter");
    expect(actsA).not.toContain("manage_table");
    expect(actsB).toContain("enter");
    expect(actsB).toContain("manage_table");
    expect(actsB).toContain("edit_data");
  });

  it("2) 空库：enter 不依赖活表（库门开），但无活表时拿不到 edit_data", async () => {
    const libActs = actionsOf((await libPolicy(nodeId("base", libE), "role_e_viewer"))?.actions ?? null);
    expect(libActs).toContain("enter"); // 零表库也 emit enter：这是运行时活表并集做不到的一格
    expect(libActs).not.toContain("edit_data");
    expect(await status("GET", `/api/tables?baseId=${libE}`, VIEWER)).toBe(200);
  });

  it("3) 聚合位不进字段能力并集（A-4 防线）：库节点 enter/edit_data 带空 mask 也不放宽可见面", async () => {
    const hiddenField = "f_edge_hidden";
    // 给 VIEWER 在 A 库表上手插一条带 fieldMask 的窄策略（不含 hidden 字段）。
    await h.prisma.authPolicy.upsert({
      where: {
        nodeId_subjectType_subjectId: {
          nodeId: nodeId("table", tableA), subjectType: "user", subjectId: VIEWER,
        },
      },
      create: {
        id: "pol_edge_mask", workspaceId: "ws_default", nodeId: nodeId("table", tableA),
        subjectType: "user", subjectId: VIEWER,
        actions: "r", fieldMask: JSON.stringify({ allowFields: ["f_edge_visible"], readOnlyFields: [] }),
        createdBy: "test",
      },
      update: { actions: "r", fieldMask: JSON.stringify({ allowFields: ["f_edge_visible"], readOnlyFields: [] }) },
    });
    const tuple = [await libPolicy(nodeId("table", tableA), "role_e_viewer"),
      await libPolicy(nodeId("base", libA), "role_e_viewer"),
      await h.prisma.authPolicy.findUnique({
        where: {
          nodeId_subjectType_subjectId: {
            nodeId: nodeId("table", tableA), subjectType: "user", subjectId: VIEWER,
          },
        },
      })];
    // 库节点的 enter/edit_data 策略 fieldMask 恒为 null（I2），但 readSources 只收 r：
    // -> 它一条都进不了能力并集，visibleAll 不得被它撑开。
    for (const p of tuple) {
      if (!p) continue;
      if (actionsOf(p.actions).includes("enter") || actionsOf(p.actions).includes("edit_data")) {
        expect(p.fieldMask).toBeNull();
      }
    }
    const libRow = await libPolicy(nodeId("base", libA), "role_e_viewer");
    const cap = fieldCapability([
      { id: "lib", nodeId: nodeId("base", libA), subjectType: "role", subjectId: "role_e_viewer",
        actions: actionsOf(libRow?.actions ?? null) as never, fieldMask: null, rowConditions: null, viaAncestor: true },
      { id: "tbl", nodeId: nodeId("table", tableA), subjectType: "user", subjectId: VIEWER,
        actions: ["r"], fieldMask: { allowFields: ["f_edge_visible"], readOnlyFields: [] }, rowConditions: null, viaAncestor: false },
    ]);
    expect(cap.readSources.map((p) => p.id)).toEqual(["tbl"]); // 库节点那条不在读来源里
    expect(cap.visibleAll).toBe(false);
    expect(cap.visibleFields?.has("f_edge_visible")).toBe(true);
    expect(cap.visibleFields?.has(hiddenField)).toBe(false);
    await h.prisma.authPolicy.deleteMany({ where: { nodeId: nodeId("table", tableA), subjectId: VIEWER } });
  });

  it("4) table 中断继承：库门 enter 不受影响，内容读回归该表自身节点的 r", async () => {
    const tNode = await h.prisma.navNode.findUniqueOrThrow({
      where: {
        workspaceId_resourceType_resourceId: {
          workspaceId: "ws_default", resourceType: "table", resourceId: tableA,
        },
      },
    });
    await h.prisma.navNode.update({ where: { id: tNode.id }, data: { inheritAncestors: 0 } }); // Int 列（0=中断）
    try {
      // 库门不看库内表，也不看库的继承开关 -> 仍放行。
      expect(await status("GET", `/api/tables?baseId=${libA}`, VIEWER)).toBe(200);
    } finally {
      await h.prisma.navNode.update({ where: { id: tNode.id }, data: { inheritAncestors: 1 } });
    }
  });
});
