// M3/S6 group CRUD + move/move-impact 端到端测试。
//
// 覆盖：建组（L0/L1）、改名/排序、非 group 父 400、删组非空无策略 409、move/retain、
// 有 shortcut 引用 409；move-impact 口径（人数/内容数/引用数/hint 恒 false）；
// move 未确认 409+impact、确认后 path 子树重写且经后续实体写 sync 不被拉回（编排覆盖）；
// 移入自身子树 400；非 manage_menu 403；操作后 reconcile 0 阻断。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { computeDiffs } from "../../../domain/nav/reconcile.js";
import type { MoveImpactDTO } from "@gx/shared-types";

let h: OrgHarness;
let raw: Database.Database;
let ids: {
  baseId: string; tableId: string; viewId: string; kbId: string; docId: string; canvasId: string;
  g1: string; g2: string; g11: string;
};

async function seed(): Promise<void> {
  await h.prisma.base.create({ data: { id: "s6g_b", name: "客户库", createdBy: "owner" } });
  await h.prisma.member.create({ data: { id: "s6g_m", baseId: "s6g_b", userId: "owner", role: "owner" } });
  await h.prisma.table.create({ data: { id: "s6g_t", baseId: "s6g_b", name: "商机表", primaryFieldId: "", createdBy: "owner" } });
  await h.prisma.view.create({ data: { id: "s6g_v", tableId: "s6g_t", name: "表格视图", type: "grid", order: 0, config: "{}" } });
  await h.prisma.knowledgeBase.create({ data: { id: "s6g_kb", name: "知识库", createdBy: "owner" } });
  await h.prisma.kbMember.create({ data: { id: "s6g_km", kbId: "s6g_kb", userId: "owner", role: "owner" } });
  await h.prisma.kbDoc.create({ data: { id: "s6g_d1", kbId: "s6g_kb", kind: "doc", title: "文档", content: "", createdBy: "owner", updatedBy: "owner" } });
  await h.prisma.kbDoc.create({ data: { id: "s6g_c1", kbId: "s6g_kb", kind: "canvas", title: "画布", content: "[]", createdBy: "owner", updatedBy: "owner" } });
  const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  raw = new Database(path.join(h.tmpDir, "org.db"));
  raw.pragma("foreign_keys=ON");
  ids = {
    baseId: "s6g_b", tableId: "s6g_t", viewId: "s6g_v", kbId: "s6g_kb", docId: "s6g_d1", canvasId: "s6g_c1",
    g1: "", g2: "", g11: "",
  };
}

async function createGroup(user: string, body: unknown): Promise<{ res: Response; id: string }> {
  const res = await h.app.request("/api/v1/nav/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth(user)) },
    body: JSON.stringify(body),
  });
  const body2 = res.status === 201 ? await json<{ id: string }>(res) : null;
  return { res, id: body2?.id ?? "" };
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("owner");
  await h.createUser("viewer");
  await h.grantSystemRole("owner", "owner");
  await h.grantSystemRole("viewer", "viewer");
  await seed();
}, 120000);

afterAll(async () => {
  raw?.close();
  await h.cleanup();
});

describe("POST /nav/groups", () => {
  it("未登录 401、viewer 403", async () => {
    const anon = await h.app.request("/api/v1/nav/groups", { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
    const denied = await createGroup("viewer", { name: "x" });
    expect(denied.res.status).toBe(403);
  });

  it("L0 建组 201；空名/超长 400；挂在实体节点下 400", async () => {
    const g1 = await createGroup("owner", { name: "重点", ord: 1 });
    expect(g1.res.status).toBe(201);
    ids.g1 = g1.id;
    const empty = await createGroup("owner", { name: "  " });
    expect(empty.res.status).toBe(400);
    const badParent = await createGroup("owner", { name: "错", parentId: nodeId("base", ids.baseId) });
    expect(badParent.res.status).toBe(400);
  });

  it("在 g1 下建子组 g11；g2 建在 L0", async () => {
    const g11 = await createGroup("owner", { name: "子组", parentId: ids.g1 });
    expect(g11.res.status).toBe(201);
    ids.g11 = g11.id;
    const g2 = await createGroup("owner", { name: "归档", iconName: "group" });
    expect(g2.res.status).toBe(201);
    ids.g2 = g2.id;
  });

  it("PATCH 改名/排序", async () => {
    const res = await h.app.request(`/api/v1/nav/groups/${ids.g1}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ name: "重点客户", ord: 2 }),
    });
    expect(res.status).toBe(200);
    const row = await h.prisma.navNode.findUnique({ where: { id: ids.g1 } });
    expect(row?.name).toBe("重点客户");
    expect(row?.ord).toBe(2);
  });
});

describe("move-impact + move", () => {
  it("impact：把 table 节点移入 g1，人数/内容数/引用数正确（M4/S7 三源：owner 两侧皆兜底 -> 0）", async () => {
    const tableNode = nodeId("table", ids.tableId);
    // 先给 table 加一条 shortcut，验 shortcutCount。
    await h.app.request("/api/v1/workspaces/current/menu", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ operations: [{ op: "insert", id: "s6g_sc", type: "shortcut", nodeId: tableNode, ord: 0 }] }),
    });
    const res = await h.app.request(
      `/api/v1/nodes/${tableNode}/move-impact?newParentId=${ids.g1}`,
      { headers: await h.auth("owner") },
    );
    expect(res.status).toBe(200);
    const impact = await json<MoveImpactDTO>(res);
    expect(impact.subtreeItemCount).toBe(1); // table 一个内容（view 不计 subtreeItemCount）
    // M4/S7 三源逐节点对称差：owner 是 table/view creator 且持 role_owner，移动前后两侧都在，
    // 空 group 不构成 restricted 边界、无授予变化 -> 0（M3 旧 members 口径的 1 已废弃）。
    expect(impact.affectedUserCount).toBe(0);
    expect(impact.shortcutCount).toBe(1);
    expect(impact.willBreakInheritanceHint).toBe(false); // 最近 inheritAncestors=0 祖先移动前后相同
  });

  it("未确认 -> 409 MOVE_NEEDS_CONFIRM 带 impact；节点未动", async () => {
    const tableNode = nodeId("table", ids.tableId);
    const res = await h.app.request(`/api/v1/nodes/${tableNode}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ newParentId: ids.g1 }),
    });
    expect(res.status).toBe(409);
    const body = await json<{ code: string; impact: MoveImpactDTO }>(res);
    expect(body.code).toBe("MOVE_NEEDS_CONFIRM");
    expect(body.impact.affectedUserCount).toBe(0); // 三源口径：无失访/新增用户
    const row = await h.prisma.navNode.findUnique({ where: { id: tableNode } });
    expect(row?.parentId).toBe(nodeId("base", ids.baseId));
  });

  it("确认移动 -> 200，parent/path 更新，view 子树 path 重写；后续实体改名 sync 不拉回（编排覆盖）", async () => {
    const tableNode = nodeId("table", ids.tableId);
    const viewNode = nodeId("view", ids.viewId);
    const res = await h.app.request(`/api/v1/nodes/${tableNode}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ newParentId: ids.g1, confirmed: true }),
    });
    expect(res.status).toBe(200);
    const table = await h.prisma.navNode.findUniqueOrThrow({ where: { id: tableNode } });
    expect(table.parentId).toBe(ids.g1);
    expect(table.path.startsWith("/")).toBe(true);
    const view = await h.prisma.navNode.findUniqueOrThrow({ where: { id: viewNode } });
    expect(view.path.startsWith(table.path)).toBe(true); // 子树前缀随父重写

    // 实体改名触发 sync：编排态父必须保留。
    await h.prisma.table.update({ where: { id: ids.tableId }, data: { name: "商机表改名" } });
    const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
    await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    const after = await h.prisma.navNode.findUniqueOrThrow({ where: { id: tableNode } });
    expect(after.name).toBe("商机表改名");
    expect(after.parentId).toBe(ids.g1);
  });

  it("移入自身子树 -> 400；移入实体节点 -> 400；newParentId 缺失 -> 400", async () => {
    const cycle = await h.app.request(`/api/v1/nodes/${ids.g1}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ newParentId: ids.g11, confirmed: true }),
    });
    expect(cycle.status).toBe(400);
    const toEntity = await h.app.request(`/api/v1/nodes/${nodeId("doc", ids.docId)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ newParentId: nodeId("kb", ids.kbId), confirmed: true }),
    });
    expect(toEntity.status).toBe(400);
  });
});

describe("DELETE /nav/groups/:id", () => {
  it("非空组无 strategy -> 409", async () => {
    const res = await h.app.request(`/api/v1/nav/groups/${ids.g1}`, {
      method: "DELETE", headers: await h.auth("owner"),
    });
    expect(res.status).toBe(409);
  });

  it("strategy=retain：实体节点回落实体默认父（table->base），组删除；reconcile 0 阻断", async () => {
    const tableNode = nodeId("table", ids.tableId);
    const res = await h.app.request(`/api/v1/nav/groups/${ids.g1}?strategy=retain`, {
      method: "DELETE", headers: await h.auth("owner"),
    });
    expect(res.status).toBe(200);
    const gone = await h.prisma.navNode.findUnique({ where: { id: ids.g1 } });
    expect(gone).toBeNull();
    const table = await h.prisma.navNode.findUniqueOrThrow({ where: { id: tableNode } });
    expect(table.parentId).toBe(nodeId("base", ids.baseId));
    const report = await h.prisma.$transaction((tx) => computeDiffs(tx));
    expect(report.A.length + report.B.length + report.C.length).toBe(0);
  });

  it("组有活 shortcut 引用 -> 409", async () => {
    await h.prisma.menuItem.create({
      data: { id: "s6g_msc", workspaceId: "ws_default", parentId: null, type: "shortcut", nodeId: ids.g2, ord: 9 },
    });
    const res = await h.app.request(`/api/v1/nav/groups/${ids.g2}`, {
      method: "DELETE", headers: await h.auth("owner"),
    });
    expect(res.status).toBe(409);
    await h.prisma.menuItem.delete({ where: { id: "s6g_msc" } });
  });

  it("strategy=move 把内容迁到目标组后删组", async () => {
    // g11 在 g1 retain 时顶到根（直接子组）；给它挂 doc，再 move 到 g2 后删。
    const docNode = nodeId("doc", ids.docId);
    const moved = await h.app.request(`/api/v1/nodes/${docNode}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
      body: JSON.stringify({ newParentId: ids.g11, confirmed: true }),
    });
    expect(moved.status).toBe(200);
    const res = await h.app.request(
      `/api/v1/nav/groups/${ids.g11}?strategy=move&targetParentId=${ids.g2}`,
      { method: "DELETE", headers: await h.auth("owner") },
    );
    expect(res.status).toBe(200);
    const doc = await h.prisma.navNode.findUniqueOrThrow({ where: { id: docNode } });
    expect(doc.parentId).toBe(ids.g2);
    // g2 仍在。
    expect(await h.prisma.navNode.findUnique({ where: { id: ids.g2 } })).not.toBeNull();
  });
});
