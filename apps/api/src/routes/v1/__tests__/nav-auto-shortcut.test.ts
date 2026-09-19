// 导航治理：建库 / 建知识库「自动入左侧一级导航」。
//
// 背景缺陷：syncNavFromEntitiesTx 只写 nav_nodes（sync.ts 文件头铁律「menu 不动」），
// 而一级导航读的是 menu_items，于是新建的库必须手动「收纳到导航」才出现。
// 修法：实体创建的同一写事务内 ensureEntityShortcutTx 补一条根级 shortcut。
//
// 覆盖：
//  - POST 建库 / 建知识库后 GET /api/v1/workspaces/current/menu 立刻含该实体的活 shortcut；
//  - 幂等：同一节点重复 ensure 不产生第二条（含「已手动收纳过的老库」）；
//  - 顺序稳定：后建的库 ord 更大，排在后面，已有项不被重排；
//  - 异常路径：非法参数 400、未登录 401，且都不产生半截 menu 行。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import type { MenuTreeDTO } from "@gx/shared-types";

let h: OrgHarness;
// 动态取：db.ts 单例在 setupOrgHarness 注入 globalThis.__gx_prisma 之后才可用，
// 顶层静态 import 会在注入前解析并绑错库（同 workspace-nav-read.test.ts 的写法）。
let syncMod: typeof import("../../../domain/nav/sync.js");
let menuMod: typeof import("../../../domain/nav/menu.js");

async function getMenu(userId = "u1"): Promise<MenuTreeDTO> {
  const res = await h.app.request("/api/v1/workspaces/current/menu", {
    headers: await h.auth(userId),
  });
  expect(res.status).toBe(200);
  return json<MenuTreeDTO>(res);
}

/** 指向该节点的活 shortcut 条数（幂等判定的唯一口径）。 */
function liveShortcuts(targetNodeId: string): Promise<number> {
  return h.prisma.menuItem.count({
    where: { workspaceId: "ws_default", type: "shortcut", nodeId: targetNodeId, deletedAt: null },
  });
}

beforeAll(async () => {
  h = await setupOrgHarness();
  await h.createUser("u1");
  [syncMod, menuMod] = await Promise.all([
    import("../../../domain/nav/sync.js"),
    import("../../../domain/nav/menu.js"),
  ]);
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("建库 / 建知识库自动入一级导航", () => {
  it("POST /api/bases 后 menu 立刻含该库的活 shortcut", async () => {
    const created = await json<{ base: { id: string; name: string } }>(
      await h.app.request("/api/bases", {
        method: "POST",
        headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "自动入导航库" }),
      }),
    );
    const baseId = created.base.id;
    const target = nodeId("base", baseId);

    const menu = await getMenu();
    const hit = menu.items.filter((m) => m.nodeId === target);
    expect(hit.length).toBe(1);
    expect(hit[0]!.type).toBe("shortcut");
    expect(hit[0]!.parentId).toBeNull(); // 根级：直接出现在一级导航，不藏在容器里
    expect(hit[0]!.label).toBeNull(); // 不写死别名，改名自动跟随节点真名
    expect(hit[0]!.node?.state).toBe("alive");
    expect(hit[0]!.node?.name).toBe("自动入导航库");
    expect(hit[0]!.node?.kind).toBe("base");
    expect(await liveShortcuts(target)).toBe(1);
  });

  it("POST /api/kb 后 menu 立刻含该知识库的活 shortcut", async () => {
    const created = await json<{ knowledgeBase: { id: string; name: string } }>(
      await h.app.request("/api/kb", {
        method: "POST",
        headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "自动入导航知识库" }),
      }),
    );
    const target = nodeId("kb", created.knowledgeBase.id);

    const menu = await getMenu();
    const hit = menu.items.filter((m) => m.nodeId === target);
    expect(hit.length).toBe(1);
    expect(hit[0]!.node?.state).toBe("alive");
    expect(hit[0]!.node?.kind).toBe("kb");
    expect(hit[0]!.node?.name).toBe("自动入导航知识库");
    expect(await liveShortcuts(target)).toBe(1);
  });

  it("重复 ensure 不产生第二条（含已手动收纳过的老库）", async () => {
    // 老库：此前已由用户手动「收纳到导航」产生一条 shortcut。
    const legacyId = "legacy_b";
    await h.prisma.base.create({ data: { id: legacyId, name: "老库", createdBy: "u1" } });
    const legacyNode = nodeId("base", legacyId);
    await h.prisma.$transaction((tx) => syncMod.syncNavFromEntitiesTx(tx));
    await h.prisma.menuItem.create({
      data: {
        id: "menu_legacy_manual", workspaceId: "ws_default", parentId: null,
        type: "shortcut", nodeId: legacyNode, label: "老库别名", ord: 0,
      },
    });

    // 再跑两次 ensure（模拟任何再次触发建 shortcut 的路径）：既不多建，也不动既有别名。
    await h.prisma.$transaction((tx) => menuMod.ensureEntityShortcutTx(tx, legacyNode));
    await h.prisma.$transaction((tx) => menuMod.ensureEntityShortcutTx(tx, legacyNode));

    expect(await liveShortcuts(legacyNode)).toBe(1);
    const kept = await h.prisma.menuItem.findFirst({ where: { nodeId: legacyNode, deletedAt: null } });
    expect(kept?.id).toBe("menu_legacy_manual");
    expect(kept?.label).toBe("老库别名");
  });

  it("幂等只看活行：软删行保持软删、其 id 不被复用", async () => {
    const baseId = "removed_b";
    await h.prisma.base.create({ data: { id: baseId, name: "被移除的库", createdBy: "u1" } });
    const target = nodeId("base", baseId);
    await h.prisma.$transaction((tx) => syncMod.syncNavFromEntitiesTx(tx));
    await h.prisma.menuItem.create({
      data: {
        id: "menu_removed", workspaceId: "ws_default", parentId: null,
        type: "shortcut", nodeId: target, ord: 0, deletedAt: new Date(),
      },
    });

    await h.prisma.$transaction((tx) => menuMod.ensureEntityShortcutTx(tx, target));
    // 判定口径是「当前有没有活 shortcut」：软删行不被改写回活（不复活、不复用其 id），
    // 需要出现时另起一条新行。ensure 只在实体创建时调用一次，故用户删掉后不会被反复加回。
    const rows = await h.prisma.menuItem.findMany({ where: { nodeId: target }, orderBy: { id: "asc" } });
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === "menu_removed")?.deletedAt).not.toBeNull();
    const fresh = rows.find((r) => r.id !== "menu_removed")!;
    expect(fresh.deletedAt).toBeNull();
    expect(await liveShortcuts(target)).toBe(1);
  });

  it("顺序稳定：后建的库 ord 更大，已有项不被重排", async () => {
    const before = await getMenu();
    const created = await json<{ base: { id: string } }>(
      await h.app.request("/api/bases", {
        method: "POST",
        headers: { ...(await h.auth("u1")), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "后建的库" }),
      }),
    );
    const target = nodeId("base", created.base.id);
    const after = await getMenu();

    const fresh = after.items.find((m) => m.nodeId === target)!;
    const maxBefore = Math.max(...before.items.filter((m) => m.parentId === null).map((m) => m.ord), -1);
    // 根级追加：ord 取「建之前根级最大 ord + 1」，多库之间顺序稳定。
    expect(fresh.ord).toBe(maxBefore + 1);
    // 既有项一个不少、ord 不变
    for (const old of before.items) {
      const now = after.items.find((m) => m.id === old.id);
      expect(now, `既有菜单项 ${old.id} 不应消失`).toBeDefined();
      expect(now!.ord).toBe(old.ord);
    }
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
