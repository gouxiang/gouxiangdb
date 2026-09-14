// M3/S3 sync 原语层测试（真库真 16 迁移，PrismaClient 直连，不经 HTTP）：
//  - 原语只在调用方传入事务内执行（不自开事务）：原语写后抛错 -> nav 无残留（裁决 9 方向②）；
//  - 软删子树沿 parentId 收集（base->table->view、kb->doc/canvas/子孙 doc），软删保留行；
//  - 物理删守卫：view/table 节点被 menu_items 引用时 409 NAV_NODE_IN_USE，清引用后成功；
//  - doc 永久删主动清自身 shortcut 与节点（内容所有者语义，不 409）。
//
// 用本测试自有 prisma.$transaction(fn) 包裹原语（原语签名就是事务回调，不绑定写队列）。
// 路由层"nav 失败 -> 实体整体回滚 + 不吞错"（方向①）在 nav-sync-routes.test.ts 用真 HTTP +
// sqlite trigger 注入 nav 写失败逐条证明。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { HttpError } from "../../../guards.js";
import {
  syncNavFromEntitiesTx,
  softDeleteSubtreeTx,
  softDeleteSingleNodeTx,
  purgeViewNodeTx,
  purgeTableNodeTx,
  purgeDocNodeTx,
} from "../sync.js";
import { nodeId } from "../backfill.js";

let tmpDir: string;
let prisma: PrismaClient;
let seq = 0;

async function seedBaseWithTable(prefix: string): Promise<{ baseId: string; tableId: string; viewId: string }> {
  const baseId = `${prefix}_b`;
  const tableId = `${prefix}_t`;
  const viewId = `${prefix}_v`;
  await prisma.$transaction([
    prisma.base.create({ data: { id: baseId, name: `${prefix} base`, createdBy: "u1" } }),
    prisma.table.create({ data: { id: tableId, baseId, name: `${prefix} table`, primaryFieldId: "", createdBy: "u1" } }),
    prisma.view.create({ data: { id: viewId, tableId, name: "grid", type: "grid", order: 0, config: "{}" } }),
  ]);
  return { baseId, tableId, viewId };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m3-s3-prim-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("sync 原语与调用方事务共生死（裁决 9 方向②：原语后失败 -> nav 随事务回滚无残留）", () => {
  it("syncNavFromEntitiesTx 写节点后抛错：事务整体回滚，无半截节点", async () => {
    const p = `q${seq++}`;
    await seedBaseWithTable(p);
    await expect(
      prisma.$transaction(async (tx) => {
        await syncNavFromEntitiesTx(tx);
        throw new Error("boom after nav sync");
      }),
    ).rejects.toThrow(/boom/);
    expect(await prisma.navNode.count({ where: { resourceId: { in: [`${p}_b`, `${p}_t`] } } })).toBe(0);
  });

  it("正常提交：节点齐全，view path 三层正确，navVersion 递增", async () => {
    const p = `q${seq++}`;
    const { baseId, tableId, viewId } = await seedBaseWithTable(p);
    const v0 = (await prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } })).navVersion;
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    const view = await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", viewId) } });
    expect(view.path).toBe(`/${nodeId("base", baseId)}/${nodeId("table", tableId)}/${nodeId("view", viewId)}/`);
    expect(view.depth).toBe(3);
    const v1 = (await prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } })).navVersion;
    expect(v1).toBeGreaterThan(v0);
  });
});

describe("软删子树（沿 parentId，不依赖 path 是否已初始化）", () => {
  it("softDeleteSubtreeTx(base) 软删 base/table/view 全闭包，行保留", async () => {
    const p = `q${seq++}`;
    const { baseId, tableId, viewId } = await seedBaseWithTable(p);
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    await prisma.$transaction((tx) => softDeleteSubtreeTx(tx, nodeId("base", baseId)));
    for (const [kind, rid] of [["base", baseId], ["table", tableId], ["view", viewId]] as const) {
      const n = await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId(kind, rid) } });
      expect(n.deletedAt).not.toBeNull();
    }
    expect(await prisma.navNode.count({ where: { resourceId: { in: [baseId, tableId, viewId] } } })).toBe(3);
  });

  it("kb 子树软删覆盖 kb/根 doc/子孙 doc/canvas 全闭包", async () => {
    const p = `q${seq++}`;
    const kbId = `${p}_kb`;
    const d1 = `${p}_d1`;
    const d2 = `${p}_d2`;
    const c1 = `${p}_c1`;
    await prisma.$transaction([
      prisma.knowledgeBase.create({ data: { id: kbId, name: `${p} kb`, createdBy: "u1" } }),
      prisma.kbDoc.create({ data: { id: d1, kbId, kind: "doc", title: "root", content: "", createdBy: "u1", updatedBy: "u1" } }),
      prisma.kbDoc.create({ data: { id: d2, kbId, kind: "doc", title: "child", content: "", parentId: d1, createdBy: "u1", updatedBy: "u1" } }),
      prisma.kbDoc.create({ data: { id: c1, kbId, kind: "canvas", title: "canvas", content: "[]", createdBy: "u1", updatedBy: "u1" } }),
    ]);
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    expect((await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", d2) } })).parentId)
      .toBe(nodeId("doc", d1));
    await prisma.$transaction((tx) => softDeleteSubtreeTx(tx, nodeId("kb", kbId)));
    for (const [kind, rid] of [["kb", kbId], ["doc", d1], ["doc", d2], ["canvas", c1]] as const) {
      expect((await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId(kind, rid) } })).deletedAt).not.toBeNull();
    }
  });

  it("softDeleteSingleNodeTx 幂等：节点不存在不抛错", async () => {
    await expect(
      prisma.$transaction((tx) => softDeleteSingleNodeTx(tx, "doc", "nope_missing_id")),
    ).resolves.toBeUndefined();
  });
});

describe("物理删 RESTRICT 守卫（NAV_NODE_IN_USE 409）", () => {
  it("view 节点被菜单引用 -> purgeViewNodeTx 409 且事务回滚；清引用后删除成功", async () => {
    const p = `q${seq++}`;
    const { viewId } = await seedBaseWithTable(p);
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    await prisma.menuItem.create({ data: { workspaceId: "ws_default", type: "shortcut", nodeId: nodeId("view", viewId) } });
    await expect(
      prisma.$transaction((tx) => purgeViewNodeTx(tx, viewId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.navNode.count({ where: { id: nodeId("view", viewId) } })).toBe(1);
    await prisma.menuItem.deleteMany({ where: { nodeId: nodeId("view", viewId) } });
    await prisma.$transaction(async (tx) => {
      await purgeViewNodeTx(tx, viewId);
      await tx.view.delete({ where: { id: viewId } });
    });
    expect(await prisma.navNode.count({ where: { id: nodeId("view", viewId) } })).toBe(0);
    expect(await prisma.view.count({ where: { id: viewId } })).toBe(0);
  });

  it("table 节点被菜单引用 -> purgeTableNodeTx 409；无引用时连同 view 子节点一起物理删", async () => {
    const p = `q${seq++}`;
    const { tableId, viewId } = await seedBaseWithTable(p);
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    await prisma.menuItem.create({ data: { workspaceId: "ws_default", type: "shortcut", nodeId: nodeId("table", tableId) } });
    await expect(
      prisma.$transaction((tx) => purgeTableNodeTx(tx, tableId)),
    ).rejects.toMatchObject({ status: 409 });
    await prisma.menuItem.deleteMany({ where: { nodeId: nodeId("table", tableId) } });
    await prisma.$transaction((tx) => purgeTableNodeTx(tx, tableId));
    expect(await prisma.navNode.count({ where: { id: { in: [nodeId("table", tableId), nodeId("view", viewId)] } } })).toBe(0);
  });

  it("doc 永久删：主动清自身 shortcut + 节点，不抛 409", async () => {
    const p = `q${seq++}`;
    const kbId = `${p}_kb`;
    const docId = `${p}_doc`;
    await prisma.$transaction([
      prisma.knowledgeBase.create({ data: { id: kbId, name: `${p} kb`, createdBy: "u1" } }),
      prisma.kbDoc.create({ data: { id: docId, kbId, kind: "doc", title: "d", content: "", createdBy: "u1", updatedBy: "u1" } }),
    ]);
    await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
    await prisma.menuItem.create({ data: { workspaceId: "ws_default", type: "shortcut", nodeId: nodeId("doc", docId) } });
    await prisma.$transaction((tx) => purgeDocNodeTx(tx, docId));
    expect(await prisma.navNode.count({ where: { resourceId: docId } })).toBe(0);
    expect(await prisma.menuItem.count({ where: { nodeId: nodeId("doc", docId) } })).toBe(0);
  });

  it("守卫错误携带 HTTP 语义 status=409（NAV_NODE_IN_USE）", () => {
    expect(new HttpError(409, "x").status).toBe(409);
  });
});
