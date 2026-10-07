// apps/api/src/routes/__tests__/detailLayoutGridVersion.test.ts
// grid 视图上的表单布局版本：UI 实测那条默认路径的 HTTP 级回归（真迁移临时库 + 真 Hono 路由）。
//
// 为什么单独一个文件：绝大多数表没有 detail 视图，表单设计器 ?design=1 会 fallback 到
// views[0]（通常是 grid），保存落的就是 grid 视图的 config.detailLayout。以前
// maybeAutoSnapshotLayoutTx 对非 detail 视图直接短路，于是"布局存进去了、版本历史永远空、
// 回退彻底不可用"，而且不报错。这两条把它钉在 HTTP 层——领域层的判据一旦被改回
// `viewType !== "detail"`，① 会立刻转红。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

// 必须在任何 import 之前提升：db/guards 依赖 db.ts 单例，故业务模块一律动态 import。
vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve("u1") }));

const OWNER = "u1";
let prisma: PrismaClient;
let request: (method: string, url: string, body?: unknown) => ReturnType<Hono["request"]>;
let tmpDir: string;

let tableId = "";
let f1 = "";
let f2 = "";
/** 表里的第一个视图（grid）—— UI 默认路径就是它，不是任何 detail 视图。 */
let gridViewId = "";

const layoutOf = (fieldIds: string[]) => ({
  defaultRowColumns: 2,
  rows: [{ colCount: 2, fieldIds, widths: Object.fromEntries(fieldIds.map((f) => [f, 50])) }],
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-grid-layout-version-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_M1_SIDECAR = "off";
  process.env.GX_M1_SIDECAR_READ = "off";
  delete process.env.GX_M1_KEYSET;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });

  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  await prisma.user.create({
    data: { id: OWNER, email: "u1@example.com", displayName: "U1", passwordHash: "x" },
  });
  await prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: OWNER, scopeType: "workspace", createdBy: "seed" },
  });

  const guardsMod = await import("../../guards.js");
  const viewsMod = await import("../views.js");
  const layoutVersionsMod = await import("../layoutVersions.js");
  const app = new Hono();
  app.route("/api/views", viewsMod.views);
  app.route("/api/views", layoutVersionsMod.layoutVersions);
  app.onError((err, c) => guardsMod.errorResponse(c, err));
  request = (method, url, body) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return app.request(url, init);
  };

  const base = await prisma.base.create({ data: { name: "b", createdBy: OWNER } });
  await prisma.member.create({ data: { baseId: base.id, userId: OWNER, role: "owner" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: OWNER },
  });
  tableId = table.id;
  const primary = await prisma.field.create({
    data: { tableId: table.id, name: "名称", type: "singleLineText", order: 0 },
  });
  await prisma.table.update({ where: { id: table.id }, data: { primaryFieldId: primary.id } });
  const made: string[] = [];
  for (const [i, name] of ["字段1", "字段2"].entries()) {
    const f = await prisma.field.create({ data: { tableId: table.id, name, type: "singleLineText", order: i + 1 } });
    made.push(f.id);
  }
  [f1, f2] = made;
  // 「这张表根本没有 detail 视图」—— 只有 grid，与 UI 实测的现场一致。
  const grid = await prisma.view.create({
    data: { tableId: table.id, name: "表格", type: "grid", order: 0, config: "{}", lockMode: "collaborative" },
  });
  gridViewId = grid.id;

  // 引擎永久单一化后，base/table/view 裸建无 nav 节点 -> 守卫反查 fail-closed。补 nav 同步。
  // u1 是超管（isWorkspaceOwner 硬短路），不依赖节点策略投影。
  const { syncNavFromEntitiesTx } = await import("../../domain/nav/sync.js");
  await prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("grid 视图上的表单布局版本（默认路径）", () => {
  it("① 保存一次后版本历史非空 —— 响应必须带回真版本号，不是 null", async () => {
    const res = await request("POST", `/api/views/${gridViewId}/detail-layout`, {
      detailLayout: layoutOf([f1]),
      tabs: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number | null };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);

    const list = (await (
      await request("GET", `/api/views/${gridViewId}/layout-versions`)
    ).json()) as { items: { version: number; label: string | null }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.version).toBe(1);
    expect(list.items[0]!.label).toBeNull();
  });

  it("② 布局确实落在 grid 视图的 config 上（记录抽屉读的就是它）", async () => {
    const v = await prisma.view.findUnique({ where: { id: gridViewId } });
    const cfg = JSON.parse(v!.config) as { detailLayout: { rows: { fieldIds: string[] }[] } };
    expect(cfg.detailLayout.rows[0]!.fieldIds).toEqual([f1]);
  });

  it("③ 同内容连点两次不增版（skipIfIdentical 对 grid 同样成立）", async () => {
    const res = await request("POST", `/api/views/${gridViewId}/detail-layout`, {
      detailLayout: layoutOf([f1]),
      tabs: {},
    });
    expect((await res.json() as { version: number | null }).version).toBeNull();
    const cnt = await prisma.formLayoutVersion.count({ where: { viewId: gridViewId } });
    expect(cnt).toBe(1);
  });

  it("④ 内容变了 → +1（grid 上也能攒出可回退的历史）", async () => {
    const res = await request("POST", `/api/views/${gridViewId}/detail-layout`, {
      detailLayout: layoutOf([f1, f2]),
      tabs: {},
    });
    expect((await res.json() as { version: number | null }).version).toBe(2);
    const rows = await prisma.formLayoutVersion.findMany({ where: { viewId: gridViewId } });
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  it("⑤ 纯 grid 配置变更（无表单布局）走 PATCH → 不留版，不堆噪音", async () => {
    const before = await prisma.formLayoutVersion.count({ where: { viewId: gridViewId } });
    // 新建一张新表的 grid 视图，config 里从来没有 detailLayout：改筛选不该生版本。
    const v = await prisma.view.create({
      data: { tableId, name: "表格2", type: "grid", order: 1, config: "{}", lockMode: "collaborative" },
    });
    const res = await request("PATCH", `/api/views/${v.id}`, { config: { filter: { op: "and" } } });
    expect(res.status).toBe(200);
    expect(await prisma.formLayoutVersion.count({ where: { viewId: v.id } })).toBe(0);
    // 顺带确认这次 PATCH 没在别的视图上生版本（新建视图不得误伤既有历史）。
    expect(await prisma.formLayoutVersion.count({ where: { viewId: gridViewId } })).toBe(before);
  });
});
