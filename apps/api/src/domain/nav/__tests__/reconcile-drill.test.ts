// M3/S4 reconcile 异常库演练（计划 §7-S4 三夹具 + 2026-09-12 新分级口径）。
//
// 每个夹具用独立临时库（隔离污染）。基线 = 16 迁移空库 + Prisma 造活实体 +
// backfill 期望集建节点 + 直接执行迁移 B 的菜单回填 SQL（与生产存量全收纳同一套）。
//   夹具① 物理删实体行 -> B1 broken（节点仍在、shortcut 仍指活节点）；--apply 不清，
//         --purge-broken 先删 shortcut 再删节点（FK RESTRICT 顺序），清到 0 阻断；
//   夹具② 节点 name 改错 -> A4（阻断），--apply 修回，再跑 no changes；
//   夹具③ 复制 shortcut 多处引用后软删资源 + 节点 -> C1S warning（shortcut 保留），
//         --apply 不清；实体恢复 + 节点复活后 warning 消失、shortcut 自动重新 alive；
// 另：未收纳实体产生逐 id 相等的 C4 warning，--apply 永不创建 shortcut。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { computeDiffs, applyFixesTx } from "../reconcile.js";
import { buildExpectedNodes, reconcileNodesTx, rebuildPathsTx, nodeId, WS_ID } from "../backfill.js";

let tmpRoot: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let seq = 0;

const backfillMenuSql = fs.readFileSync(
  path.resolve("prisma/migrations/20260916093000_enterprise_nav_backfill/migration.sql"),
  "utf8",
);

function freshDb(label: string): void {
  dbFile = path.join(tmpRoot, `${label}.db`);
  process.env.DATABASE_URL = `file:${dbFile}`;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  raw = new Database(dbFile);
  raw.pragma("foreign_keys=ON");
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s4-drill-"));
  process.env.NODE_ENV = "test";
  process.env.GX_AUDIT_DIR = path.join(tmpRoot, ".audit");
});
beforeEach(() => {
  freshDb(`db${++seq}`);
});
afterEach(async () => {
  await prisma?.$disconnect();
  raw?.close();
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function alignNodes(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await reconcileNodesTx(tx, await buildExpectedNodes(tx));
    await rebuildPathsTx(tx);
  });
}
const diffs = () => prisma.$transaction((tx) => computeDiffs(tx));
const blocking = async () => {
  const r = await diffs();
  return r.summary.A + r.summary.B + r.summary.C;
};

/** 造一个 user + base(含 table/view)，建节点 + 迁移 B 菜单，返回固定 id。 */
async function seedBaseWithMenu(prefix: string) {
  const userId = `${prefix}_u`;
  const baseId = `${prefix}_b`;
  const tableId = `${prefix}_t`;
  const viewId = `${prefix}_v`;
  await prisma.user.create({
    data: { id: userId, email: `${prefix}@x.com`, displayName: prefix, passwordHash: "h", status: "ACTIVE", workspaceId: WS_ID },
  });
  await prisma.$transaction([
    prisma.base.create({ data: { id: baseId, name: `${prefix} base`, createdBy: userId } }),
    prisma.member.create({ data: { id: `${prefix}_m`, baseId, userId, role: "owner" } }),
    prisma.table.create({ data: { id: tableId, baseId, name: `${prefix} table`, primaryFieldId: "", createdBy: userId } }),
    prisma.view.create({ data: { id: viewId, tableId, name: "grid", type: "grid", order: 0, config: "{}" } }),
  ]);
  await alignNodes();
  raw.exec(backfillMenuSql);
  return { userId, baseId, tableId, viewId };
}

describe("健康基线", () => {
  it("造实体+对齐+迁移 B 菜单后：0 阻断、0 warning", async () => {
    await seedBaseWithMenu("healthy");
    const r = await diffs();
    expect(r.summary.A + r.summary.B + r.summary.C).toBe(0);
    expect(r.summary.warnings).toBe(0);
  });
});

describe("夹具① 实体行物理消失 -> B1 broken，--purge-broken 清理", () => {
  it("B1 阻断；--apply 不带 purge 节点保留；带 purge 先删 shortcut 再删节点，0 阻断", async () => {
    const { tableId, viewId } = await seedBaseWithMenu("brk");
    // table 物理删（view 随 FK cascade）；nav 节点与菜单 shortcut 不受跨表 FK 影响，仍在。
    await prisma.table.delete({ where: { id: tableId } });
    let r = await diffs();
    expect(r.B.filter((d) => d.code === "B1").map((d) => d.ref).sort())
      .toEqual([nodeId("table", tableId), nodeId("view", viewId)].sort());
    expect(await blocking()).toBeGreaterThan(0);

    // 不带 purge：broken 只报告。
    await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    expect(await prisma.navNode.count({ where: { id: nodeId("table", tableId) } })).toBe(1);

    // 带 purge：先删指向待删节点的 shortcut，再删节点。
    const shortcutCount = await prisma.menuItem.count({ where: { nodeId: nodeId("table", tableId) } });
    expect(shortcutCount).toBe(1);
    const fix = await prisma.$transaction((tx) => applyFixesTx(tx, { purgeBroken: true }));
    expect(fix.purged.nodes).toBeGreaterThan(0);
    expect(fix.purged.shortcuts).toBe(1);
    expect(await blocking()).toBe(0);
    expect(await prisma.navNode.count({
      where: { id: { in: [nodeId("table", tableId), nodeId("view", viewId)] } },
    })).toBe(0);
    expect(await prisma.menuItem.count({ where: { nodeId: nodeId("table", tableId) } })).toBe(0);
    r = await diffs();
    expect(r.summary.warnings).toBe(0);
  });

  it("纯脏 shortcut（指向既无节点行也无实体的随机 id）-> C1B，--purge-broken 仅清该 shortcut", async () => {
    await seedBaseWithMenu("orphan");
    // 造一条指向不存在节点 id 的活 shortcut（手工脏数据；正常 API 因 FK RESTRICT 无法产生，
    // 模拟节点被外部手段物理删后菜单残留）。用 raw 临时关 FK 插入，再恢复。
    const ghost = "nav_table_ghost_does_not_exist";
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.prepare(
      "INSERT INTO menu_items (id,workspaceId,type,nodeId,ord,createdAt) VALUES (?,?,?,?,?,?)",
    ).run("menu_ghost", WS_ID, "shortcut", ghost, 99, "2026-03-01 00:00:00");
    raw.exec("PRAGMA foreign_keys=ON");
    const r = await diffs();
    expect(r.C.some((d) => d.code === "C1")).toBe(true);
    // 不带 purge：只报告不清理。
    await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    expect(await prisma.menuItem.count({ where: { id: "menu_ghost" } })).toBe(1);
    const fix = await prisma.$transaction((tx) => applyFixesTx(tx, { purgeBroken: true }));
    expect(fix.purged.shortcuts).toBe(1);
    expect(await prisma.menuItem.count({ where: { id: "menu_ghost" } })).toBe(0);
    expect(await blocking()).toBe(0);
  });
});

describe("夹具② 节点 name 改错 -> A4，--apply 修回", () => {
  it("报 A4；--apply 名回落实体；再跑 no changes", async () => {
    const { tableId } = await seedBaseWithMenu("a4");
    await prisma.navNode.update({ where: { id: nodeId("table", tableId) }, data: { name: "坏名" } });
    const r = await diffs();
    expect(r.A.some((d) => d.code === "A4" && d.ref === nodeId("table", tableId))).toBe(true);

    const fix = await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    expect(fix.nodes.updated).toBeGreaterThan(0);
    expect((await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", tableId) } })).name)
      .toContain("table");
    expect(await blocking()).toBe(0);

    const again = await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    expect(again.nodes.created + again.nodes.updated + again.nodes.pathsRebuilt).toBe(0);
    expect(again.purged.nodes + again.purged.shortcuts).toBe(0);
  });
});

describe("夹具③ 复制 shortcut 后软删 -> C1S warning 保留，恢复自动还原", () => {
  it("两处 shortcut 软删期均 C1S、活行保留、不阻断；--apply 不清；恢复后 warning 消失", async () => {
    const { baseId, tableId } = await seedBaseWithMenu("soft");
    const tableNode = nodeId("table", tableId);
    await prisma.menuItem.create({
      data: { id: `menu_copy_${tableId}`, workspaceId: WS_ID, type: "shortcut", nodeId: tableNode, ord: 9, parentId: `menu_base_${baseId}` },
    });
    expect(await prisma.menuItem.count({ where: { nodeId: tableNode } })).toBe(2);

    // 软删资源（table + view 隐藏）并把节点软删（运行期 sync 语义）。
    await prisma.$transaction([
      prisma.table.update({ where: { id: tableId }, data: { deletedAt: new Date() } }),
      prisma.view.updateMany({ where: { tableId }, data: { order: -1 } }),
    ]);
    await prisma.$transaction((tx) => applyFixesTx(tx, {})); // B2 对齐：节点软删
    const r = await diffs();
    expect(r.summary.C).toBe(0); // soft_dangling 不阻断
    expect(r.warnings.filter((d) => d.code === "C1S")).toHaveLength(2);
    expect(await prisma.menuItem.count({ where: { nodeId: tableNode, deletedAt: null } })).toBe(2);

    // 恢复资源 + 节点复活（恢复 table 时 view order 重置）。
    await prisma.$transaction([
      prisma.table.update({ where: { id: tableId }, data: { deletedAt: null } }),
      prisma.view.updateMany({ where: { tableId }, data: { order: 0 } }),
    ]);
    await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    const r2 = await diffs();
    expect(r2.warnings.filter((d) => d.code === "C1S")).toHaveLength(0);
    expect(await prisma.menuItem.count({ where: { nodeId: tableNode, deletedAt: null } })).toBe(2);
    expect(r2.summary.A + r2.summary.B + r2.summary.C).toBe(0);
  });
});

describe("未收纳 C4：逐 id 相等、--apply 永不创建 shortcut", () => {
  it("新建未收纳 table：C4 指向其节点；两次 --apply 后 menu 行数不变", async () => {
    const s = await seedBaseWithMenu("loose");
    const looseTable = `${s.baseId}_loose`;
    const looseView = `${s.baseId}_loosev`;
    await prisma.$transaction([
      prisma.table.create({ data: { id: looseTable, baseId: s.baseId, name: "未收纳表", primaryFieldId: "", createdBy: s.userId } }),
      prisma.view.create({ data: { id: looseView, tableId: looseTable, name: "grid", type: "grid", order: 0, config: "{}" } }),
    ]);
    await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    const r = await diffs();
    expect(r.summary.A + r.summary.B + r.summary.C).toBe(0);
    expect(r.warnings.filter((d) => d.code === "C4").map((d) => d.ref)).toContain(nodeId("table", looseTable));
    const menuBefore = await prisma.menuItem.count();
    await prisma.$transaction((tx) => applyFixesTx(tx, {}));
    expect(await prisma.menuItem.count()).toBe(menuBefore);
  });
});
