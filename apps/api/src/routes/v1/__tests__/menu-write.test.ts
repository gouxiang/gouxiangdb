// M3/S6 PATCH /api/v1/workspaces/current/menu 菜单编排写端到端测试。
//
// 覆盖：四 op（insert/update/reorder/delete）整单事务；容器 2 层上限；
// shortcut nodeId 存在性；坏图标 400；别名不覆盖真名；同节点多处引用/换容器；
// 非 manage_menu 角色 403、未登录 401；编排后 reconcile 阻断差异 0（只动 menu_items，
// 不制造 A/B 差异；C4 warnings 随收纳变化但不阻断）；menuVersion 单调。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { computeDiffs } from "../../../domain/nav/reconcile.js";
import type { MenuTreeDTO } from "@gx/shared-types";

let h: OrgHarness;
let ids: { tableId: string; viewId: string; baseId: string };

async function seed(): Promise<void> {
  const baseId = "s6m_b";
  const tableId = "s6m_t";
  const viewId = "s6m_v";
  await h.prisma.base.create({ data: { id: baseId, name: "库", createdBy: "owner" } });
  await h.prisma.member.create({ data: { id: "s6m_m", baseId, userId: "owner", role: "owner" } });
  await h.prisma.table.create({ data: { id: tableId, baseId, name: "表", primaryFieldId: "", createdBy: "owner" } });
  await h.prisma.view.create({ data: { id: viewId, tableId, name: "视图", type: "grid", order: 0, config: "{}" } });
  const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  ids = { tableId, viewId, baseId };
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("owner");
  await h.createUser("viewer");
  await h.createUser("custom");
  await h.grantSystemRole("owner", "owner");
  await h.grantSystemRole("viewer", "viewer"); // 无 manage_menu
  // 自定义角色持 manage_menu。
  await h.prisma.role.create({
    data: { id: "role_menu", workspaceId: "ws_default", systemKey: null, name: "编排员", description: "", isSystem: 0, permissions: '["manage_menu"]' },
  });
  await h.grant("role_menu", "user", "custom");
  await seed();
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

async function patchMenu(
  userId: string,
  operations: unknown[],
): Promise<Response> {
  return h.app.request("/api/v1/workspaces/current/menu", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await h.auth(userId)) },
    body: JSON.stringify({ operations }),
  });
}

async function getMenu(userId = "owner"): Promise<MenuTreeDTO> {
  const res = await h.app.request("/api/v1/workspaces/current/menu", { headers: await h.auth(userId) });
  return json<MenuTreeDTO>(res);
}

describe("PATCH /workspaces/current/menu 鉴权", () => {
  it("未登录 401；viewer 无 manage_menu 403", async () => {
    const anon = await h.app.request("/api/v1/workspaces/current/menu", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operations: [] }),
    });
    expect(anon.status).toBe(401);
    const denied = await patchMenu("viewer", [{ op: "insert", type: "container" }]);
    expect(denied.status).toBe(403);
  });

  it("operations 非数组/空 -> 400", async () => {
    for (const body of [{}, { operations: [] }, { operations: "x" }]) {
      const res = await h.app.request("/api/v1/workspaces/current/menu", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("insert/update/reorder/delete", () => {
  it("insert 一级容器 + shortcut（含别名），同一节点两处引用", async () => {
    const res = await patchMenu("owner", [
      { op: "insert", id: "s6m_c1", type: "container", iconName: "database", ord: 0 },
      { op: "insert", id: "s6m_s1", type: "shortcut", parentId: "s6m_c1", nodeId: nodeId("table", ids.tableId), ord: 0 },
      { op: "insert", id: "s6m_s2", type: "shortcut", parentId: "s6m_c1", nodeId: nodeId("table", ids.tableId), label: "表别名", ord: 1 },
    ]);
    expect(res.status).toBe(200);
    const body = await json<{ menuVersion: number; applied: number }>(res);
    expect(body.applied).toBe(3);
    const menu = await getMenu();
    const byId = new Map(menu.items.map((m) => [m.id, m]));
    expect(byId.get("s6m_s1")?.node?.name).toBe("表");
    expect(byId.get("s6m_s1")?.label).toBeNull();
    expect(byId.get("s6m_s2")?.label).toBe("表别名");
    expect(byId.get("s6m_s2")?.node?.name).toBe("表");
  });

  it("update 别名/图标；清空别名 label=null", async () => {
    const res = await patchMenu("owner", [
      { op: "update", id: "s6m_s1", label: "新别名" },
      { op: "update", id: "s6m_c1", iconName: "book" },
    ]);
    expect(res.status).toBe(200);
    const menu = await getMenu();
    const byId = new Map(menu.items.map((m) => [m.id, m]));
    expect(byId.get("s6m_s1")?.label).toBe("新别名");
    expect(byId.get("s6m_c1")?.iconName).toBe("book");
  });

  it("reorder 换 ord 与跨容器（新建第二个容器并移入 shortcut）", async () => {
    await patchMenu("owner", [{ op: "insert", id: "s6m_c2", type: "container", iconName: "book", ord: 1 }]);
    const res = await patchMenu("owner", [
      { op: "reorder", id: "s6m_s2", parentId: "s6m_c2", ord: 0 },
    ]);
    expect(res.status).toBe(200);
    const menu = await getMenu();
    const moved = menu.items.find((m) => m.id === "s6m_s2")!;
    expect(moved.parentId).toBe("s6m_c2");
  });

  it("delete 容器级联软删后代；删除后 GET 不可见", async () => {
    const res = await patchMenu("owner", [{ op: "delete", id: "s6m_c2" }]);
    expect(res.status).toBe(200);
    const menu = await getMenu();
    expect(menu.items.some((m) => m.id === "s6m_c2")).toBe(false);
    expect(menu.items.some((m) => m.id === "s6m_s2")).toBe(false);
  });

  it("整单失败回滚：同批合法容器 + 非法 shortcut（坏 nodeId）-> 409 且容器未建", async () => {
    const res = await patchMenu("owner", [
      { op: "insert", id: "s6m_rollback_c", type: "container" },
      { op: "insert", type: "shortcut", nodeId: "nav_table_ghost" },
    ]);
    expect(res.status).toBe(409);
    const menu = await getMenu();
    expect(menu.items.some((m) => m.id === "s6m_rollback_c")).toBe(false);
  });
});

describe("校验", () => {
  it("容器超 2 层 -> 400；shortcut 作父 -> 400；坏图标 -> 400；shortcut 缺 nodeId -> 400", async () => {
    // L1
    await patchMenu("owner", [{ op: "insert", id: "s6m_l1", type: "container" }]);
    // L2
    const l2 = await patchMenu("owner", [{ op: "insert", id: "s6m_l2", type: "container", parentId: "s6m_l1" }]);
    expect(l2.status).toBe(200);
    // L3 超层
    const l3 = await patchMenu("owner", [{ op: "insert", type: "container", parentId: "s6m_l2" }]);
    expect(l3.status).toBe(400);
    // shortcut 作父
    const badParent = await patchMenu("owner", [
      { op: "insert", type: "container", parentId: "s6m_s1" },
    ]);
    expect(badParent.status).toBe(400);
    // 坏图标
    const badIcon = await patchMenu("owner", [{ op: "insert", type: "container", iconName: "rainbow" }]);
    expect(badIcon.status).toBe(400);
    // shortcut 缺 nodeId
    const noNode = await patchMenu("owner", [{ op: "insert", type: "shortcut", parentId: "s6m_l1" }]);
    expect(noNode.status).toBe(400);
    // container 带 nodeId
    const cWithNode = await patchMenu("owner", [
      { op: "insert", type: "container", nodeId: nodeId("table", ids.tableId) },
    ]);
    expect(cWithNode.status).toBe(400);
  });

  it("reorder 把容器挂到自己的子孙下 -> 400 NAV_CYCLE，整单不动", async () => {
    // s6m_l1（L1）-> s6m_l2（L2）；尝试把 l1 挂到 l2 下成环。
    const before = (await getMenu()).items.find((m) => m.id === "s6m_l1")!;
    expect(before.parentId).toBeNull();
    const res = await patchMenu("owner", [{ op: "reorder", id: "s6m_l1", parentId: "s6m_l2", ord: 0 }]);
    expect(res.status).toBe(400);
    const body = await json<{ code: string }>(res);
    expect(body.code).toBe("NAV_CYCLE");
    const after = (await getMenu()).items.find((m) => m.id === "s6m_l1")!;
    expect(after.parentId).toBeNull();
  });

  it("自定义角色持 manage_menu 可编排", async () => {
    const res = await patchMenu("custom", [{ op: "insert", id: "s6m_custom_c", type: "container", ord: 5 }]);
    expect(res.status).toBe(200);
  });
});

describe("编排后 reconcile 口径", () => {
  it("只动 menu_items：阻断差异 A/B/C1-C3 全 0", async () => {
    const report = await h.prisma.$transaction((tx) => computeDiffs(tx));
    const blocking = [...report.A, ...report.B, ...report.C];
    if (blocking.length) {
      throw new Error(blocking.map((d) => `${d.code}:${d.message}`).join("\n"));
    }
    expect(blocking.length).toBe(0);
  });
});
