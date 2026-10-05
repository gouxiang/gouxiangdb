// P1/S5 scope 双写真库集成测试（临时库 + 真迁移 + 真 HTTP/直调事务）。
// 覆盖：PUT 普通角色投影；删除语义；PUT role_admin 覆盖未列库；PUT role_owner 跳过；
//       seed 产物与幂等；事务回滚；HTTP edit_roles 门控。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeNavHarness, json, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";

let h: CharHarness;

beforeAll(async () => {
  h = await makeNavHarness("gx-s5-scope-dw-");
  await h.createUser("owner");
  await h.createUser("rest");
  await h.grantRole("owner");
  await h.grantRole("rest", "role_restricted");
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
  // 系统角色不删（owner/rest 的 role_assignments 须能 include 到 role）；仅确保自定义 r1 存在。
  await h.prisma.role.upsert({
    where: { id: "r1" },
    create: { id: "r1", workspaceId: "ws_default", name: "r1", isSystem: 0, permissions: "[]" },
    update: {},
  });
});

async function call(method: string, url: string, user: string, body?: unknown): Promise<Response> {
  const headers = await h.auth(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function mkBase(id: string) {
  await h.prisma.base.create({ data: { id, name: id, createdBy: "owner" } });
}

async function mkTable(baseId: string, id: string): Promise<void> {
  await h.prisma.table.create({
    data: { id, baseId, name: id, primaryFieldId: `${id}_f1`, createdBy: "owner" },
  });
  await mkField(id, `${id}_f1`, 0);
}

async function mkField(tableId: string, id: string, order: number) {
  await h.prisma.field.create({ data: { id, tableId, name: id, type: "singleLineText", order } });
}

async function policy(node: string, subject = "r1") {
  return h.prisma.authPolicy.findUnique({
    where: { nodeId_subjectType_subjectId: { nodeId: node, subjectType: "role", subjectId: subject } },
  });
}

describe("PUT 普通角色：scope -> auth_policies", () => {
  it("逐表动作与字段 mask 与投影一致", async () => {
    await mkBase("b1");
    await mkTable("b1", "t1");
    await mkField("t1", "t1_f2", 1);
    await mkTable("b1", "t2");
    await mkField("t2", "t2_f2", 1);

    const res = await call("PUT", "/api/v1/org/library-scopes", "owner", {
      roleId: "r1",
      items: [{
        libraryKind: "base", libraryId: "b1", visible: true,
        config: {
          tables: { t1: { create: true, update: true } },
          fields: { t2: { t2_f1: "visible", t2_f2: "hidden" } },
        },
      }],
    });
    expect(res.status).toBe(200);

    const t1 = await policy("nav_table_t1");
    expect(t1?.actions.split(",").sort()).toEqual(["c", "comment", "r", "u"]);
    expect(t1?.fieldMask).toBeNull();
    const t2 = await policy("nav_table_t2");
    expect(t2?.actions).toBe("r");
    expect(JSON.parse(t2!.fieldMask!)).toEqual({
      allowFields: ["t2_f1"], readOnlyFields: ["t2_f1"],
    });
    // 库节点：enter（visible）+ edit_data（t1 勾了 create/update -> 库内活表可写并集），
    // 且不带任何 manage_*（非管理位成员）。这正是 ADR-0056 的两枚聚合位。
    expect(await policy("nav_base_b1")).toMatchObject({ actions: "edit_data,enter" });
  });

  it("删除语义：再 PUT 只保留 b2 -> b1 全部 scope:role 行删、b2 不动", async () => {
    await mkBase("b1");
    await mkTable("b1", "t1");
    await mkBase("b2");
    await mkTable("b2", "t9");
    const first = await call("PUT", "/api/v1/org/library-scopes", "owner", {
      roleId: "r1",
      items: [
        { libraryKind: "base", libraryId: "b1", visible: true },
        { libraryKind: "base", libraryId: "b2", visible: true },
      ],
    });
    expect(first.status).toBe(200);

    const second = await call("PUT", "/api/v1/org/library-scopes", "owner", {
      roleId: "r1",
      items: [{ libraryKind: "base", libraryId: "b2", visible: true }],
    });
    expect(second.status).toBe(200);

    expect(await policy("nav_table_t1")).toBeNull();
    expect(await policy("nav_table_t9")).not.toBeNull();
    const nodes = (await h.prisma.authPolicy.findMany({ where: { subjectId: "r1" } }))
      .map((p) => p.nodeId).sort();
    // b2 仍可见 -> 库节点带 enter，与表节点一并保留
    expect(nodes).toEqual(["nav_base_b2", "nav_table_t9"]);
  });
});

describe("PUT 系统角色", () => {
  it("role_admin：未在 items 里的活库隐含策略仍在且只读", async () => {
    await mkBase("b1");
    await mkTable("b1", "t1");
    await mkBase("b2");
    await mkTable("b2", "t9");
    const res = await call("PUT", "/api/v1/org/library-scopes", "owner", {
      roleId: "role_admin",
      items: [{ libraryKind: "base", libraryId: "b1", visible: true, canManage: true }],
    });
    expect(res.status).toBe(200);

    const unlistedTable = await policy("nav_table_t9", "role_admin");
    expect(unlistedTable?.actions).toBe("r");
    const unlistedLib = await policy("nav_base_b2", "role_admin");
    // 未列入的活库：隐含只读 -> enter + manage_share，无 edit_data
    expect(unlistedLib?.actions.split(",").sort()).toEqual(["enter", "manage_share"]);
    // 库节点须同挂 manage_schema：七守 requireCanManageSchema 按 base 节点判（guards.ts:186）
    const managedLib = await policy("nav_base_b1", "role_admin");
    expect(managedLib?.actions.split(",").sort()).toEqual([
      "edit_data", "enter", "manage_schema", "manage_share", "manage_table",
    ]);
    const managedTable = await policy("nav_table_t1", "role_admin");
    expect(managedTable?.actions.split(",").sort()).toEqual(["manage_schema", "r", "c", "u", "d", "comment"].sort());
  });

  it("role_owner：不产生任何 scope:role 策略", async () => {
    await mkBase("b1");
    await mkTable("b1", "t1");
    const res = await call("PUT", "/api/v1/org/library-scopes", "owner", {
      roleId: "role_owner",
      items: [{ libraryKind: "base", libraryId: "b1", visible: true, canManage: true }],
    });
    expect(res.status).toBe(200);
    expect(await h.prisma.authPolicy.count({ where: { reason: "scope:role" } })).toBe(0);
  });
});

describe("新库 seed：role_admin 初始投影", () => {
  it("base：库节点 manage_share+manage_table+manage_schema；kb：kb 节点 content 全权+管理位", async () => {
    const baseRes = await call("POST", "/api/bases", "owner", { name: "s5 新库" });
    expect(baseRes.status).toBe(201);
    const baseId = (await json<{ base: { id: string } }>(baseRes)).base.id;
    const baseLib = await policy(`nav_base_${baseId}`, "role_admin");
    // 新库 seed 走 projectImplicitAdmin（canManage 构造）-> 含 enter + edit_data
    expect(baseLib?.actions.split(",").sort()).toEqual([
      "edit_data", "enter", "manage_schema", "manage_share", "manage_table",
    ]);

    const kbRes = await call("POST", "/api/kb", "owner", { name: "s5 新 KB" });
    expect(kbRes.status).toBe(201);
    const kbId = (await json<{ knowledgeBase: { id: string } }>(kbRes)).knowledgeBase.id;
    const kbNode = await policy(`nav_kb_${kbId}`, "role_admin");
    // kb 节点追加 enter（不 emit edit_data，§7.2-3），并带建链位 share_link（admin canShare 恒真）
    expect(kbNode?.actions.split(",").sort()).toEqual(
      ["c", "comment", "d", "enter", "manage_share", "manage_table", "r", "share_link", "u"].sort(),
    );
  });

  it("seed 重复调用幂等（行不翻倍）且不影响其他库投影", async () => {
    await mkBase("b_existing");
    const existing = await policy("nav_base_b_existing", "role_admin");
    const { seedAdminScopeTx } = await import("../../../domain/authz/libraryScopeSeed.js");
    await h.prisma.$transaction(async (tx) => {
      await seedAdminScopeTx(tx, "base", "b_new", "owner");
      await seedAdminScopeTx(tx, "base", "b_new", "owner");
    });
    const rows = await h.prisma.authPolicy.findMany({
      where: { nodeId: "nav_base_b_new", subjectId: "role_admin" },
    });
    expect(rows).toHaveLength(1);
    // 其他库投影原样（无 seed 即无行，不凭空变化）。
    expect(await policy("nav_base_b_existing", "role_admin")).toEqual(existing);
  });
});

describe("事务回滚 与 HTTP 门控", () => {
  it("投影后抛错整体回滚：scope 行与策略均无半截", async () => {
    await mkBase("b1");
    await mkTable("b1", "t1");
    const { rebuildScopePoliciesTx } = await import("../../../domain/authz/scopeDoubleWrite.js");
    await expect(h.prisma.$transaction(async (tx) => {
      await tx.roleLibraryScope.create({
        data: { roleId: "r1", libraryKind: "base", libraryId: "b1", visible: 1 },
      });
      const saved = await tx.roleLibraryScope.findMany({ where: { roleId: "r1" } });
      await rebuildScopePoliciesTx(tx, "r1", saved, "owner");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await h.prisma.authPolicy.count()).toBe(0);
    expect(await h.prisma.roleLibraryScope.count()).toBe(0);
  });

  it("无 edit_roles 者 PUT 被挡（403），不产生投影", async () => {
    await mkBase("b1");
    const res = await call("PUT", "/api/v1/org/library-scopes", "rest", {
      roleId: "r1",
      items: [{ libraryKind: "base", libraryId: "b1", visible: true }],
    });
    expect(res.status).toBe(403);
    expect(await h.prisma.authPolicy.count()).toBe(0);
  });
});
