// 导航治理（第三批）：建库 / 建知识库**不再**自动写 menu_items。
//
// 变更背景：一级导航（L1）的数据源已从 menu_items 改为直接读 bases / knowledge_bases，
// 「建库补一条根级 shortcut」这套自动写入随导航编排一并下线——留着就是死代码
// （前端已不再消费 menu_items，写入只会被 DB 记账、永不被读）。
// 反向断言：先锁住「不再自动写入」，同时锁住「menu 编排 API 本身仍然可用」——
// 后端 domain/nav 与 PATCH menu 路由按约定保留为冷备，不许因为不消费就被误删。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import type { MenuTreeDTO } from "@gx/shared-types";

let h: OrgHarness;

async function getMenu(userId = "u1"): Promise<MenuTreeDTO> {
  const res = await h.app.request("/api/v1/workspaces/current/menu", {
    headers: await h.auth(userId),
  });
  expect(res.status).toBe(200);
  return json<MenuTreeDTO>(res);
}

async function patchMenu(userId: string, operations: unknown[]): Promise<Response> {
  return h.app.request("/api/v1/workspaces/current/menu", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await h.auth(userId)) },
    body: JSON.stringify({ operations }),
  });
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("u1");
  await h.grantSystemRole("u1", "owner");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("建实体不再自动写入 menu_items（一级导航改读实体列表）", () => {
  it("POST /api/bases 后 menu 中没有指向该库的任何行", async () => {
    const created = await json<{ base: { id: string; name: string } }>(
      await h.app.request("/api/bases", {
        method: "POST",
        headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "不再自动入导航库" }),
      }),
    );
    const target = nodeId("base", created.base.id);

    const menu = await getMenu();
    expect(menu.items.filter((m) => m.nodeId === target)).toHaveLength(0);
    expect(
      await h.prisma.menuItem.count({ where: { workspaceId: "ws_default", nodeId: target } }),
    ).toBe(0);
  });

  it("POST /api/kb 后 menu 中没有指向该知识库的任何行", async () => {
    const created = await json<{ knowledgeBase: { id: string } }>(
      await h.app.request("/api/kb", {
        method: "POST",
        headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "不再自动入导航知识库" }),
      }),
    );
    const target = nodeId("kb", created.knowledgeBase.id);

    const menu = await getMenu();
    expect(menu.items.filter((m) => m.nodeId === target)).toHaveLength(0);
  });

  it("menu 编排 API 保留可用：手动 insert 仍能在该节点上建出活 shortcut", async () => {
    // 这条是「冷备未坏」的护栏：前端不用了，但 domain/API 按约定保留，不能静默失效。
    const created = await json<{ base: { id: string } }>(
      await h.app.request("/api/bases", {
        method: "POST",
        headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "手动收纳的库" }),
      }),
    );
    const target = nodeId("base", created.base.id);

    const res = await patchMenu("u1", [
      { op: "insert", id: "menu_manual_ok", type: "shortcut", parentId: null, nodeId: target },
    ]);
    expect(res.status).toBe(200);

    const menu = await getMenu();
    const hit = menu.items.filter((m) => m.nodeId === target);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.parentId).toBeNull();
    expect(hit[0]!.node?.state).toBe("alive");
  });

  it("异常路径不受影响：非法参数 400、未登录 401，且都不产生半截 menu 行", async () => {
    const before = await h.prisma.menuItem.count();

    const bad = await h.app.request("/api/bases", {
      method: "POST",
      headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(bad.status).toBe(400);

    const anon = await h.app.request("/api/bases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "未登录建库" }),
    });
    expect(anon.status).toBe(401);

    const badKb = await h.app.request("/api/kb", {
      method: "POST",
      headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(badKb.status).toBe(400);

    expect(await h.prisma.menuItem.count()).toBe(before);
  });
});
