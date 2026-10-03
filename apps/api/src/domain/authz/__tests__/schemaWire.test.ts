// P1/S7 schema 结构写点 #3-#12 真库集成测试（临时库 + 真迁移 + 真 HTTP）。
// 覆盖：建表投影（含 role_admin 隐含）、加字段 mask 重算（窄/宽）、删字段 mask 剔除、
//       复制表 / 恢复表补齐投影、双写故障整体回滚。
// 期望一律由 projectScopeRow / projectImplicitAdmin 产出，不手抄动作位。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeNavHarness, json, failEntityWrite, dropAllFailTriggers, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";

// 注意：scopeProjection -> nav/backfill -> db -> config 链不得在收集期静态求值（会在夹具设置
// env 前固化 config，导致 /api/v1 不挂载、PUT 404），与 scopeDoubleWrite.test.ts 同口径，
// 故运行时函数全部用时动态 import；仅 type-only 导入（编译期擦除、零运行时副作用）。
import type { ScopeProjectionInput } from "../scopeProjection.js";
type ProjMod = typeof import("../scopeProjection.js");

let proj: ProjMod;

let h: CharHarness;

beforeAll(async () => {
  h = await makeNavHarness("gx-s7-schemawire-");
  await h.createUser("owner");
  await h.grantRole("owner");
  proj = await import("../scopeProjection.js");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

const CLEAR = [
  "auth_policies", "role_library_scope", "fields", "tables", "bases", "knowledge_bases",
];

beforeEach(async () => {
  await h.prisma.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
  for (const t of CLEAR) await h.prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await h.prisma.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  // 系统角色不删；确保各用例用到的自定义角色存在（PUT scope 要求角色存在否则 404）。
  for (const id of ["r1", "r_read", "r_manage", "r_narrow", "r_wide"]) {
    await h.prisma.role.upsert({
      where: { id },
      create: { id, workspaceId: "ws_default", name: id, isSystem: 0, permissions: "[]" },
      update: {},
    });
  }
});

async function call(method: string, url: string, body?: unknown): Promise<Response> {
  const headers = await h.auth("owner");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function scopeInput(
  roleId: string, libraryId: string, over: Partial<ScopeProjectionInput> = {},
): ScopeProjectionInput {
  return {
    roleId, libraryKind: "base", libraryId,
    canManage: 0, visible: 1, canShare: 0, config: "{}", ...over,
  };
}

/** PUT scope 行（owner 持 edit_roles）。 */
async function putScope(roleId: string, items: Array<Record<string, unknown>>): Promise<void> {
  const res = await call("PUT", "/api/v1/org/library-scopes", { roleId, items });
  expect(res.status).toBe(200);
}

async function policy(node: string, subject = "r1") {
  return h.prisma.authPolicy.findUnique({
    where: { nodeId_subjectType_subjectId: { nodeId: node, subjectType: "role", subjectId: subject } },
  });
}

const cfgString = (o: unknown) => JSON.stringify(o);

describe("#3 建表：scope 角色投影 + role_admin 隐含", () => {
  it("visible 只读 / canManage 两角色的新表节点策略与 projectScopeRow 一致", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 建表库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;

    await putScope("r_read", [
      { libraryKind: "base", libraryId: baseId, visible: true },
    ]);
    await putScope("r_manage", [
      { libraryKind: "base", libraryId: baseId, visible: true, canManage: true },
    ]);

    const createRes = await call("POST", `/api/tables?baseId=${baseId}`, { name: "新表" });
    expect(createRes.status).toBe(201);
    const tableId = (await json<{ table: { id: string } }>(createRes)).table.id;

    const { loadLiveShape } = await import("../scopeProjectionTx.js");
    const shape = await loadLiveShape(h.prisma, baseId);
    for (const [roleId, over] of [
      ["r_read", {}],
      ["r_manage", { canManage: 1 }],
    ] as const) {
      const expected = proj.projectScopeRow(scopeInput(roleId, baseId, over), shape)
        .find((p) => p.nodeId === `nav_table_${tableId}`);
      const row = await policy(`nav_table_${tableId}`, roleId);
      expect(row, roleId).toBeTruthy();
      expect(row!.actions).toBe(expected!.actions);
      expect(row!.fieldMask).toBe(expected!.fieldMask);
    }
  });

  it("role_admin 新表节点策略：无 scope 行时隐含只读，有 canManage 行时含管理位", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 admin 库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;

    // 直接验证 projectAdminForNewTableTx：建库 seed 给 role_admin 落了 canManage=1 行，
    // 先删掉该行模拟「admin 无此库行」，建表也须补隐含只读（代码健壮性要求）。
    await h.prisma.roleLibraryScope.deleteMany({
      where: { roleId: "role_admin", libraryKind: "base", libraryId: baseId },
    });
    // 直接造一张活表（不经建表 HTTP），再调用管理员单表同步。
    const t0 = await h.prisma.table.create({
      data: { baseId, name: "t0", primaryFieldId: "", createdBy: "owner" },
    });
    const { projectAdminForNewTableTx } = await import("../scopeDoubleWrite.js");
    await h.prisma.$transaction((tx) => projectAdminForNewTableTx(tx, baseId, t0.id, "owner"));

    const { loadLiveShape } = await import("../scopeProjectionTx.js");
    const { projectImplicitAdmin } = await import("../implicitAdminProject.js");
    let projected = projectImplicitAdmin({
      bases: [{ libraryId: baseId, shape: await loadLiveShape(h.prisma, baseId) }],
      kbs: [], adminScopeRows: [],
    }).find((p) => p.nodeId === `nav_table_${t0.id}`);
    let row = await policy(`nav_table_${t0.id}`, "role_admin");
    expect(row).toBeTruthy();
    expect(row!.actions).toBe(projected!.actions); // r
    expect(row!.fieldMask).toBe(projected!.fieldMask);

    // 恢复 admin canManage=1 行（建库 seed 口径），经建表 HTTP 再建一张表：含 manage_schema。
    await h.prisma.roleLibraryScope.create({
      data: {
        roleId: "role_admin", libraryKind: "base", libraryId: baseId,
        canManage: 1, visible: 1, canShare: 0,
      },
    });
    const create2 = await call("POST", `/api/tables?baseId=${baseId}`, { name: "admin 表2" });
    expect(create2.status).toBe(201);
    const tableId2 = (await json<{ table: { id: string } }>(create2)).table.id;
    const adminRow = await h.prisma.roleLibraryScope.findFirst({
      where: { roleId: "role_admin", libraryKind: "base", libraryId: baseId },
    });
    projected = (await import("../implicitAdminProject.js")).projectImplicitAdmin({
      bases: [{ libraryId: baseId, shape: await loadLiveShape(h.prisma, baseId) }],
      kbs: [], adminScopeRows: [{
        roleId: "role_admin", libraryKind: "base", libraryId: baseId,
        canManage: adminRow!.canManage, visible: adminRow!.visible,
        canShare: adminRow!.canShare, config: adminRow!.config,
      }],
    }).find((p) => p.nodeId === `nav_table_${tableId2}`);
    row = await policy(`nav_table_${tableId2}`, "role_admin");
    expect(row!.actions).toBe(projected!.actions);
    expect(row!.actions.split(",")).toContain("manage_schema");
  });
});

describe("#8 加字段：mask 重算（窄表入 allow / 宽表保持 null）", () => {
  it("显式 fields 表新字段按 editable 入 allow；宽 mask 表 fieldMask 仍为 null", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 字段库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;
    // 建初始表（自带名称字段），拿到字段 id。
    const tRes = await call("POST", `/api/tables?baseId=${baseId}`, { name: "表A" });
    const tableId = (await json<{ table: { id: string } }>(tRes)).table.id;
    const fields = await h.prisma.field.findMany({ where: { tableId } });
    const nameId = fields.find((f) => f.name === "名称")!.id;

    // r_narrow：显式字段配置（名称 visible）；r_wide：无显式 fields。
    await call("PUT", "/api/v1/org/library-scopes", {
      roleId: "r_narrow",
      items: [{
        libraryKind: "base", libraryId: baseId, visible: true,
        config: { fields: { [tableId]: { [nameId]: "visible" } } },
      }],
    });
    await call("PUT", "/api/v1/org/library-scopes", {
      roleId: "r_wide",
      items: [{ libraryKind: "base", libraryId: baseId, visible: true }],
    });

    // 加字段。
    const addRes = await call(
      "POST",
      `/api/fields?tableId=${tableId}`,
      { name: "新字段", type: "singleLineText" },
    );
    expect(addRes.status).toBe(201);

    const { loadLiveShape } = await import("../scopeProjectionTx.js");
    const shape = await loadLiveShape(h.prisma, baseId);
    const narrowConfig = cfgString({ fields: { [tableId]: { [nameId]: "visible" } } });
    const expectedNarrow = proj.projectScopeRow(
      scopeInput("r_narrow", baseId, { config: narrowConfig }), shape,
    ).find((p) => p.nodeId === `nav_table_${tableId}`);
    const narrow = await policy(`nav_table_${tableId}`, "r_narrow");
    expect(narrow!.fieldMask).toBe(expectedNarrow!.fieldMask);
    const mask = JSON.parse(narrow!.fieldMask!) as { allowFields: string[]; readOnlyFields: string[] };
    const newFieldId = (await h.prisma.field.findFirst({
      where: { tableId, name: "新字段" },
    }))!.id;
    expect(mask.allowFields).toContain(newFieldId); // 缺省 editable
    expect(mask.readOnlyFields).not.toContain(newFieldId);

    const wide = await policy(`nav_table_${tableId}`, "r_wide");
    expect(wide!.fieldMask).toBeNull();
  });
});

describe("#10 删字段：id 从 mask allowFields 剔除", () => {
  it("删除后 mask 与 projectScopeRow 现配一致，被删字段不再出现", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 删字段库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;
    const tRes = await call("POST", `/api/tables?baseId=${baseId}`, { name: "表D" });
    const tableId = (await json<{ table: { id: string } }>(tRes)).table.id;
    const addRes = await call(
      "POST", `/api/fields?tableId=${tableId}`,
      { name: "待删", type: "singleLineText" },
    );
    const victimId = (await json<{ field: { id: string } }>(addRes)).field.id;
    const nameId = (await h.prisma.field.findFirst({ where: { tableId, name: "名称" } }))!.id;

    // 显式 mask：两字段均 editable。
    await call("PUT", "/api/v1/org/library-scopes", {
      roleId: "r1",
      items: [{
        libraryKind: "base", libraryId: baseId, visible: true,
        config: { fields: { [tableId]: { [nameId]: "editable", [victimId]: "editable" } } },
      }],
    });
    expect(JSON.parse((await policy(`nav_table_${tableId}`))!.fieldMask!).allowFields)
      .toContain(victimId);

    const delRes = await call("DELETE", `/api/fields/${victimId}`);
    expect(delRes.status).toBe(200);

    const { loadLiveShape } = await import("../scopeProjectionTx.js");
    const shape = await loadLiveShape(h.prisma, baseId);
    // 配置里仍留死键，但 buildFieldMask 只解析活字段——与第二代逐值一致。
    const expected = proj.projectScopeRow(
      scopeInput("r1", baseId, {
        config: cfgString({ fields: { [tableId]: { [nameId]: "editable", [victimId]: "editable" } } }),
      }), shape,
    ).find((p) => p.nodeId === `nav_table_${tableId}`);
    const row = await policy(`nav_table_${tableId}`);
    expect(row!.fieldMask).toBe(expected!.fieldMask);
    const mask = JSON.parse(row!.fieldMask!) as { allowFields: string[] };
    expect(mask.allowFields).not.toContain(victimId);
  });
});

describe("#4 复制表 / #5 恢复表：投影补齐", () => {
  it("复制表：副本节点 scope:role 策略按现配重算补齐", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 复制库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;
    const tRes = await call("POST", `/api/tables?baseId=${baseId}`, { name: "源表" });
    const srcId = (await json<{ table: { id: string } }>(tRes)).table.id;
    await call("PUT", "/api/v1/org/library-scopes", {
      roleId: "r1",
      items: [{ libraryKind: "base", libraryId: baseId, visible: true }],
    });

    const dupRes = await call("POST", `/api/tables/${srcId}/duplicate`, { name: "副本表" });
    expect(dupRes.status).toBe(201);
    const copyId = (await json<{ table: { id: string } }>(dupRes)).table.id;

    const { loadLiveShape } = await import("../scopeProjectionTx.js");
    const expected = proj.projectScopeRow(
      scopeInput("r1", baseId), await loadLiveShape(h.prisma, baseId),
    ).find((p) => p.nodeId === `nav_table_${copyId}`);
    const row = await policy(`nav_table_${copyId}`);
    expect(row).toBeTruthy();
    expect(row!.actions).toBe(expected!.actions);
    expect(row!.fieldMask).toBe(expected!.fieldMask);
    expect(await policy(`nav_table_${copyId}`, "role_admin")).toBeTruthy();
  });

  it("恢复表：恢复表节点投影按活结构补齐重算", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 恢复库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;
    const tRes = await call("POST", `/api/tables?baseId=${baseId}`, { name: "待删表" });
    const tableId = (await json<{ table: { id: string } }>(tRes)).table.id;
    await call("PUT", "/api/v1/org/library-scopes", {
      roleId: "r1",
      items: [{ libraryKind: "base", libraryId: baseId, visible: true }],
    });

    // 删表（软删：不触发结构 remove，投影行随软删保留——恢复时据此补齐，不产生缺口）。
    const del = await call("DELETE", `/api/tables/${tableId}`);
    expect(del.status).toBe(200);

    // 恢复表：sync 'add' 按恢复后的活结构 upsert 投影。
    const rest = await call(
      "POST", `/api/records/trash/${tableId}/restore`, { kind: "table" },
    );
    expect(rest.status).toBe(200);

    const { loadLiveShape } = await import("../scopeProjectionTx.js");
    const expected = proj.projectScopeRow(
      scopeInput("r1", baseId), await loadLiveShape(h.prisma, baseId),
    ).find((p) => p.nodeId === `nav_table_${tableId}`);
    const row = await policy(`nav_table_${tableId}`);
    expect(row).toBeTruthy();
    expect(row!.actions).toBe(expected!.actions);
    expect(row!.fieldMask).toBe(expected!.fieldMask);
    expect(await policy(`nav_table_${tableId}`, "role_admin")).toBeTruthy();
  });
});

describe("#3 双写故障：建表事务整体回滚", () => {
  it("sync 原语的策略写失败时表与投影都不存在（无半截）", async () => {
    const baseRes = await call("POST", "/api/bases", { name: "s7 故障库" });
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;
    await call("PUT", "/api/v1/org/library-scopes", {
      roleId: "r1",
      items: [{ libraryKind: "base", libraryId: baseId, visible: true }],
    });

    // 让 auth_policies INSERT 在 sync 阶段 ABORT（建表实体写不触该表）：
    // 与「让 sync 原语抛错」等价，且在 DB 层证明同事务回滚、无半截。
    await failEntityWrite(h, "auth_policies", "INSERT");
    try {
      const res = await call("POST", `/api/tables?baseId=${baseId}`, { name: "半截表" });
      expect(res.status).toBe(500);
    } finally {
      await dropAllFailTriggers(h);
    }

    // 建库自带的 starter 表（数据表 1）保留；失败的「半截表」随事务回滚，不存在。
    expect(await h.prisma.table.count({
      where: { baseId, deletedAt: null, name: "半截表" },
    })).toBe(0);
    expect(await h.prisma.table.count({
      where: { baseId, deletedAt: null, name: "数据表 1" },
    })).toBe(1);
    // starter 字段完好（数量大于 0）。
    expect(await h.prisma.field.count({
      where: { table: { baseId } },
    })).toBeGreaterThan(0);
    // 所有现存 scope:role 表节点投影只指向当前活表，不包含半截表节点。
    const liveIds = new Set((await h.prisma.table.findMany({
      where: { baseId, deletedAt: null }, select: { id: true },
    })).map((t) => t.id));
    const policies = await h.prisma.authPolicy.findMany({
      where: { reason: "scope:role", nodeId: { startsWith: "nav_table_" } },
    });
    for (const p of policies) {
      const tid = p.nodeId.slice("nav_table_".length);
      expect(liveIds.has(tid)).toBe(true);
    }
  });
});
