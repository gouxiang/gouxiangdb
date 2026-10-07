// M3/S5 GET /api/v1/workspaces/current/tree|menu 真库端到端测试。
//
// 覆盖（计划 §7-S5 验收项）：
//  - tree 平铺 -> parentId 组树所需字段齐全；parentId/maxDepth 分块界；kind 过滤；
//  - 10 万节点保护：无 parentId 全量 400；maxDepth 非法 400；非管理员 all=1 403；owner all=1 含软删；
//  - menu：容器/shortcut 真名/别名不覆盖真名/同一节点多处引用；
//  - shortcut state 三态 alive/soft_dangling/broken，且对无成员关系用户逐字段同值（零剪枝裁决 1）；
//  - 未登录 401；navVersion/menuVersion 字段存在。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import type { MenuTreeDTO, NavTreeDTO } from "@gx/shared-types";

let h: OrgHarness;
let raw: Database.Database;
let ids: {
  baseId: string; tableId: string; viewId: string;
  kbId: string; rootDoc: string; childDoc: string; canvas: string;
  softDoc: string; groupNode: string;
  aliveShortcut: string; aliasShortcut: string; secondShortcut: string;
  softShortcut: string; brokenShortcut: string; containerBase: string;
};

async function seed(): Promise<void> {
  const p = "s5";
  const baseId = `${p}_b`;
  const tableId = `${p}_t`;
  const viewId = `${p}_v`;
  const kbId = `${p}_kb`;
  const rootDoc = `${p}_d1`;
  const childDoc = `${p}_d2`;
  const canvas = `${p}_c1`;
  const softDoc = `${p}_d3`;
  // 顺序 await 写：数组事务并行发起在 FK 依赖下间歇 P2003（CLI flaky 同款纪律）。
  await h.prisma.base.create({ data: { id: baseId, name: "客户库", createdBy: "owner" } });
  await h.prisma.member.create({ data: { id: `${p}_m`, baseId, userId: "owner", role: "owner" } });
  await h.prisma.table.create({ data: { id: tableId, baseId, name: "商机表", primaryFieldId: "", createdBy: "owner" } });
  await h.prisma.view.create({ data: { id: viewId, tableId, name: "表格视图", type: "grid", order: 0, config: "{}" } });
  await h.prisma.knowledgeBase.create({ data: { id: kbId, name: "产品知识库", createdBy: "owner" } });
  await h.prisma.kbMember.create({ data: { id: `${p}_km`, kbId, userId: "owner", role: "owner" } });
  await h.prisma.kbDoc.create({ data: { id: rootDoc, kbId, kind: "doc", title: "入门指南", content: "", createdBy: "owner", updatedBy: "owner" } });
  await h.prisma.kbDoc.create({ data: { id: childDoc, kbId, kind: "doc", title: "子文档", content: "", parentId: rootDoc, createdBy: "owner", updatedBy: "owner" } });
  await h.prisma.kbDoc.create({ data: { id: canvas, kbId, kind: "canvas", title: "白板一", content: "[]", createdBy: "owner", updatedBy: "owner" } });
  await h.prisma.kbDoc.create({ data: { id: softDoc, kbId, kind: "doc", title: "待悬挂文档", content: "", createdBy: "owner", updatedBy: "owner" } });

  const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));

  // group 节点（isSystem=0，L1 根层）。
  const groupNode = `${p}_g1`;
  await h.prisma.navNode.create({
    data: {
      id: groupNode, workspaceId: "ws_default", parentId: null, kind: "group",
      name: "重点分组", ord: 900, path: `/${groupNode}/`, depth: 1, isSystem: 0,
      inheritAncestors: 1,
    },
  });

  // soft_dangling：实体与节点同时置软删（shortcut 保留）。
  await h.prisma.kbDoc.update({ where: { id: softDoc }, data: { deletedAt: new Date() } });
  await h.prisma.navNode.update({ where: { id: nodeId("doc", softDoc) }, data: { deletedAt: new Date() } });

  // 菜单：一个一级容器（挂 base 节点），其下三条 shortcut 指向同一 table 节点
  // （两处引用 + 一条别名）；一条 shortcut 指向软删 doc 节点。
  const containerBase = `menu_${p}_base`;
  await h.prisma.menuItem.create({
    data: { id: containerBase, workspaceId: "ws_default", parentId: null, type: "container", nodeId: null, iconName: "database", ord: 0 },
  });
  const aliveShortcut = `menu_${p}_s1`;
  const aliasShortcut = `menu_${p}_s2`;
  const secondShortcut = `menu_${p}_s3`;
  const softShortcut = `menu_${p}_s4`;
  await h.prisma.menuItem.create({
    data: { id: aliveShortcut, workspaceId: "ws_default", parentId: containerBase, type: "shortcut", nodeId: nodeId("table", tableId), ord: 0 },
  });
  await h.prisma.menuItem.create({
    data: { id: aliasShortcut, workspaceId: "ws_default", parentId: containerBase, type: "shortcut", nodeId: nodeId("table", tableId), label: "商机别名", ord: 1 },
  });
  await h.prisma.menuItem.create({
    data: { id: secondShortcut, workspaceId: "ws_default", parentId: null, type: "shortcut", nodeId: nodeId("table", tableId), ord: 1 },
  });
  await h.prisma.menuItem.create({
    data: { id: softShortcut, workspaceId: "ws_default", parentId: containerBase, type: "shortcut", nodeId: nodeId("doc", softDoc), ord: 2 },
  });

  // broken shortcut：FK RESTRICT 下业务路径无法产生，关 FK 直接插一条指向幽灵节点的行。
  const brokenShortcut = `menu_${p}_s5`;
  raw = new Database(path.join(h.tmpDir, "org.db"));
  raw.pragma("foreign_keys = OFF");
  raw.exec(
    `INSERT INTO menu_items (id, "workspaceId", "parentId", type, "nodeId", label, "iconName", ord, "createdAt", "updatedAt") ` +
    `VALUES ('${brokenShortcut}','ws_default','${containerBase}','shortcut','nav_doc_ghost_missing',NULL,NULL,3,${Date.now()},NULL)`,
  );
  raw.pragma("foreign_keys = ON");

  ids = {
    baseId, tableId, viewId, kbId, rootDoc, childDoc, canvas, softDoc, groupNode,
    aliveShortcut, aliasShortcut, secondShortcut, softShortcut, brokenShortcut, containerBase,
  };
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("owner");
  await h.createUser("outsider");
  await h.grantSystemRole("owner", "owner");
  await seed();
}, 120000);

afterAll(async () => {
  raw?.close();
  await h.cleanup();
});

describe("GET /api/v1/workspaces/current/tree", () => {
  it("未登录 -> 401", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree?parentId=root");
    expect(res.status).toBe(401);
  });

  it("不带 parentId 的全量请求 -> 400（10 万节点保护）", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree", { headers: await h.auth("owner") });
    expect(res.status).toBe(400);
    const body = await json<{ code: string }>(res);
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("parentId=root 默认窗口 maxDepth=2：含 L0/L1（base/table），不含 depth=3 的 view", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree?parentId=root", { headers: await h.auth("owner") });
    expect(res.status).toBe(200);
    const body = await json<NavTreeDTO>(res);
    expect(body.workspaceId).toBe("ws_default");
    expect(typeof body.navVersion).toBe("number");
    const byId = new Map(body.items.map((n) => [n.id, n]));
    expect(byId.has(nodeId("base", ids.baseId))).toBe(true);
    expect(byId.has(nodeId("table", ids.tableId))).toBe(true);
    expect(byId.has(nodeId("doc", ids.rootDoc))).toBe(true);
    expect(byId.has(nodeId("canvas", ids.canvas))).toBe(true);
    expect(byId.has(ids.groupNode)).toBe(true);
    expect(byId.has(nodeId("view", ids.viewId))).toBe(false);
    expect(byId.has(nodeId("doc", ids.childDoc))).toBe(false);
    expect(body.items.every((n) => n.deletedAt === null)).toBe(true);
  });

  it("maxDepth=3：含 view 与二级 doc", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree?parentId=root&maxDepth=3", {
      headers: await h.auth("owner"),
    });
    const body = await json<NavTreeDTO>(res);
    const byId = new Map(body.items.map((n) => [n.id, n]));
    expect(byId.has(nodeId("view", ids.viewId))).toBe(true);
    expect(byId.has(nodeId("doc", ids.childDoc))).toBe(true);
    const view = byId.get(nodeId("view", ids.viewId))!;
    expect(view.parentId).toBe(nodeId("table", ids.tableId));
    expect(view.resourceType).toBe("view");
    expect(view.resourceId).toBe(ids.viewId);
    expect(view.isSystem).toBe(true);
  });

  it("parentId=<table 节点>：锚点本身 + 其下 view", async () => {
    const res = await h.app.request(
      `/api/v1/workspaces/current/tree?parentId=${nodeId("table", ids.tableId)}&maxDepth=2`,
      { headers: await h.auth("owner") },
    );
    const body = await json<NavTreeDTO>(res);
    const got = new Set(body.items.map((n) => n.id));
    expect(got).toEqual(new Set([nodeId("table", ids.tableId), nodeId("view", ids.viewId)]));
  });

  it("parentId 指向不存在/软删节点 -> 400", async () => {
    const res = await h.app.request(
      `/api/v1/workspaces/current/tree?parentId=${nodeId("doc", ids.softDoc)}`,
      { headers: await h.auth("owner") },
    );
    expect(res.status).toBe(400);
  });

  it("maxDepth=0 / 负数 / 非整数 -> 400", async () => {
    for (const v of ["0", "-1", "1.5", "abc"]) {
      const res = await h.app.request(`/api/v1/workspaces/current/tree?parentId=root&maxDepth=${v}`, {
        headers: await h.auth("owner"),
      });
      expect(res.status, `maxDepth=${v}`).toBe(400);
    }
  });

  it("kind=table 过滤后只剩 table 节点", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree?parentId=root&maxDepth=3&kind=table", {
      headers: await h.auth("owner"),
    });
    const body = await json<NavTreeDTO>(res);
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(nodeId("table", ids.tableId));
  });

  it("未知 kind -> 400", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/tree?parentId=root&kind=widget", {
      headers: await h.auth("owner"),
    });
    expect(res.status).toBe(400);
  });

  it("非管理员 all=1 -> 403；owner all=1 -> 200 且含软删节点", async () => {
    const denied = await h.app.request("/api/v1/workspaces/current/tree?all=1", {
      headers: await h.auth("outsider"),
    });
    expect(denied.status).toBe(403);

    const ok = await h.app.request("/api/v1/workspaces/current/tree?all=1", {
      headers: await h.auth("owner"),
    });
    expect(ok.status).toBe(200);
    const body = await json<NavTreeDTO>(ok);
    const soft = body.items.find((n) => n.id === nodeId("doc", ids.softDoc));
    expect(soft).toBeDefined();
    expect(soft?.deletedAt).not.toBeNull();
  });
});

describe("GET /api/v1/workspaces/current/menu", () => {
  it("未登录 -> 401", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/menu");
    expect(res.status).toBe(401);
  });

  it("容器/真名/别名不覆盖真名/多处引用；dangling/broken shortcut 永久剪枝", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/menu", {
      headers: await h.auth("owner"),
    });
    expect(res.status).toBe(200);
    const body = await json<MenuTreeDTO>(res);
    expect(body.workspaceId).toBe("ws_default");
    expect(typeof body.menuVersion).toBe("number");
    const byId = new Map(body.items.map((m) => [m.id, m]));

    const container = byId.get(ids.containerBase)!;
    expect(container.type).toBe("container");
    expect(container.nodeId).toBeNull();
    expect(container.node).toBeNull();
    expect(container.iconName).toBe("database");

    const alive = byId.get(ids.aliveShortcut)!;
    expect(alive.node?.state).toBe("alive");
    expect(alive.node?.name).toBe("商机表");
    expect(alive.node?.kind).toBe("table");
    expect(alive.node?.resourceId).toBe(ids.tableId);
    expect(alive.label).toBeNull();

    const alias = byId.get(ids.aliasShortcut)!;
    expect(alias.label).toBe("商机别名");
    expect(alias.node?.name).toBe("商机表"); // 别名不覆盖节点真名
    expect(alias.node?.state).toBe("alive");

    // 同一节点两处（实际三处）引用都解析成功。
    const refs = body.items.filter((m) => m.nodeId === nodeId("table", ids.tableId));
    expect(refs.length).toBe(3);
    expect(refs.every((m) => m.node?.state === "alive")).toBe(true);

    // A-6 永久剪枝：目标节点自身 r 不成立的 shortcut 一律剔除（无权访问已删/不存在内容），
    // 超管也一样——soft_dangling / broken 不进入菜单，菜单里根本找不到这两项。
    expect(byId.has(ids.softShortcut)).toBe(false);
    expect(byId.has(ids.brokenShortcut)).toBe(false);
  });

  it("剪枝对所有登录用户一视同仁：无角色 outsider 只拿到空菜单（无 dangling/broken）", async () => {
    const res = await h.app.request("/api/v1/workspaces/current/menu", {
      headers: await h.auth("outsider"),
    });
    expect(res.status).toBe(200);
    const bb = await json<MenuTreeDTO>(res);
    // outsider 无任何角色 -> 无可见 shortcut，容器随之收空：菜单为空。
    expect(bb.items).toEqual([]);
    expect(bb.workspaceId).toBe("ws_default");
  });
});
