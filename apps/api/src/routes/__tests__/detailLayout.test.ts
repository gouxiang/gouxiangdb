// apps/api/src/routes/__tests__/detailLayout.test.ts
// POST /api/views/:viewId/detail-layout 的定向测试（真迁移临时库 + 真 Hono 路由）。
//
// 覆盖总监点名的六条：保存一次后历史非空 / 同内容连点两次不增版 / 内容变了 +1 /
// 无权限 403 且不留版 / tabs 结构完整落库 / 非法 field id 400。

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

let viewId = "";
let tableId = "";
let c1 = "";   // tabs 容器字段
let baseId = "";
let f1 = "";   // 普通字段（布局成员）
let f2 = "";
let f3 = "";

async function getVersions(): Promise<{ items: { version: number; label: string | null }[] }> {
  const res = await request("GET", `/api/views/${viewId}/layout-versions`);
  return (await res.json()) as { items: { version: number; label: string | null }[] };
}

const layoutOf = (fieldIds: string[]) => ({
  defaultRowColumns: 2,
  rows: [{ colCount: 2, fieldIds, widths: Object.fromEntries(fieldIds.map((f) => [f, 50])) }],
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-detail-layout-"));
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

  baseId = (await prisma.base.create({ data: { name: "b", createdBy: OWNER } })).id;
  const base = { id: baseId };
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
  for (const [i, name] of ["字段1", "字段2", "字段3"].entries()) {
    const f = await prisma.field.create({ data: { tableId: table.id, name, type: "singleLineText", order: i + 1 } });
    made.push(f.id);
  }
  [f1, f2, f3] = made;
  c1 = (
    await prisma.field.create({ data: { tableId: table.id, name: "分组", type: "tabs", order: 9 } })
  ).id;
  const view = await prisma.view.create({
    data: { tableId: table.id, name: "详情", type: "detail", order: 0, config: "{}", lockMode: "collaborative" },
  });
  viewId = view.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/views/:viewId/detail-layout", () => {
  it("① 保存一次后 GET layout-versions 非空（自动留档，label=null）", async () => {
    const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
      detailLayout: layoutOf([f1]),
      tabs: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number | null };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);

    const list = await getVersions();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.version).toBe(1);
    expect(list.items[0]!.label).toBeNull();
  });

  it("② 同内容连点两次不增版（skipIfIdentical）", async () => {
    const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
      detailLayout: layoutOf([f1]),
      tabs: {},
    });
    expect((await res.json() as { version: number | null }).version).toBeNull();
    expect((await getVersions()).items).toHaveLength(1);
  });

  it("③ 内容变了 → +1（force 跳过 10 分钟窗）", async () => {
    const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
      detailLayout: layoutOf([f1, f2]),
      tabs: {},
    });
    expect((await res.json() as { version: number | null }).version).toBe(2);
    const list = await getVersions();
    expect(list.items.map((i) => i.version).sort()).toEqual([1, 2]);
  });

  it("④ tabs 结构完整落库（分组/widths/rows 逐字进 field.tabsConfig）", async () => {
    const tabsCfg = [
      { id: "t1", name: "基本信息", fieldIds: [f1], widths: { [f1]: 25 } },
      { id: "t2", name: "补充", fieldIds: [f2, f3], widths: { [f2]: 75, [f3]: 50 }, rows: [{ items: [{ fieldId: f2, widthPct: 75 }, { fieldId: f3, widthPct: 50 }] }] },
    ];
    const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
      detailLayout: layoutOf([f1]),
      tabs: { [c1]: tabsCfg },
    });
    const body = (await res.json()) as { ok: boolean; tabsUpdated: string[]; skipped: string[] };
    expect(body.ok).toBe(true);
    expect(body.tabsUpdated).toEqual([c1]);
    // skipped 必须恒定出现在响应里（空数组也要有）：前端按"有就提示"接，缺字段等于又一处静默
    expect(body.skipped).toEqual([]);

    const f = await prisma.field.findUnique({ where: { id: c1 } });
    expect(JSON.parse(f!.tabsConfig!)).toEqual(tabsCfg); // 分组/宽度/行边界一个字节都不能丢
    expect(f!.name).toBe("分组"); // 只改 tabsConfig，name 原值写回
  });

  it("⑤ 非法 field id → 400 且不留版", async () => {
    const before = (await getVersions()).items.length;
    const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
      detailLayout: layoutOf([f1, "GHOST"]),
      tabs: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fieldIds: string[] };
    expect(body.fieldIds).toContain("GHOST");
    expect((await getVersions()).items).toHaveLength(before); // 事务回滚 + 不留新版本
  });

  it("⑥ 无 schema 权限 → 403 且不留版", async () => {
    // 把 u1 从超级管理员降为阅读者，并显式给它这个库的 visible=1、canManage=0：
    // 于是 requireCanView 放行、canManageSchema 为假 —— 命中的正是"锁定的视图无权改"那条。
    await prisma.roleAssignment.deleteMany({ where: { subjectId: OWNER } });
    await prisma.roleAssignment.create({
      data: { roleId: "role_viewer", subjectType: "user", subjectId: OWNER, scopeType: "workspace", createdBy: "seed" },
    });
    await prisma.roleLibraryScope.upsert({
      where: { roleId_libraryKind_libraryId: { roleId: "role_viewer", libraryKind: "base", libraryId: baseId } },
      create: { roleId: "role_viewer", libraryKind: "base", libraryId: baseId, visible: 1, canManage: 0, canShare: 0 },
      update: { visible: 1, canManage: 0 },
    });
    try {
      const before = await prisma.formLayoutVersion.count({ where: { viewId } });
      const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
        detailLayout: layoutOf([f1, f2, f3]),
        tabs: {},
      });
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toContain("无权");
      expect(await prisma.formLayoutVersion.count({ where: { viewId } })).toBe(before);
    } finally {
      await prisma.roleAssignment.deleteMany({ where: { subjectId: OWNER } });
      await prisma.roleAssignment.create({
        data: { roleId: "role_owner", subjectType: "user", subjectId: OWNER, scopeType: "workspace", createdBy: "seed" },
      });
    }
  });

  it("⑦ 事务完整性：view.config 与 tabsConfig 同生共死（非法 tabs 键 → 400，两侧都不写）", async () => {
    const before = await prisma.field.findUnique({ where: { id: c1 } });
    const res = await request("POST", `/api/views/${viewId}/detail-layout`, {
      detailLayout: layoutOf([f1]),
      // c1 是 tabs 字段，但这里故意把键指到一个非 tabs 字段
      tabs: { [tableId]: [{ id: "t1", name: "A", fieldIds: [f1] }] },
    });
    expect(res.status).toBe(400);
    const after = await prisma.field.findUnique({ where: { id: c1 } });
    expect(after!.tabsConfig).toBe(before!.tabsConfig); // 未被半截写入
  });
});

describe("POST /api/views/:viewId/layout-versions（保护备份的防御）", () => {
  it("容器值发成裸数组 → 400，不静默存成空壳备份", async () => {
    const before = await prisma.formLayoutVersion.count({ where: { viewId } });
    const res = await request("POST", `/api/views/${viewId}/layout-versions`, {
      label: "回退前自动备份",
      snapshot: {
        layout: layoutOf([f1]),
        // 错误形态：把 TabConfig[] 直接当容器值；结构数组应嵌在容器对象的 tabs 键里
        tabs: { [c1]: [{ id: "t1", name: "A", fieldIds: [f1] }] },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; keys: string[] };
    expect(body.keys).toEqual([c1]);
    expect(await prisma.formLayoutVersion.count({ where: { viewId } })).toBe(before);
  });

  it("正确形态（结构数组嵌在容器对象里）→ 201 且 tabs 结构完整入库", async () => {
    const tabsCfg = [{ id: "t1", name: "A", fieldIds: [f1], widths: { [f1]: 50 } }];
    const res = await request("POST", `/api/views/${viewId}/layout-versions`, {
      label: "回退前自动备份",
      snapshot: { layout: layoutOf([f1]), tabs: { [c1]: { cards: [f1], lazyTouched: ["t1"], tabs: tabsCfg } } },
    });
    expect(res.status).toBe(201);
    const rec = await prisma.formLayoutVersion.findFirst({
      where: { viewId, label: "回退前自动备份" },
      orderBy: { version: "desc" },
    });
    expect(rec).not.toBeNull();
    const snap = JSON.parse(rec!.snapshot);
    expect(snap.tabs[c1].tabs).toEqual(tabsCfg); // 结构没被静默抹掉
    expect(snap.tabs[c1].cards).toEqual([f1]);
  });

  it("空容器在信封里的形态恒为 { cards:[], lazyTouched:[] }（无 tabs 键）—— 回退判据依赖它", async () => {
    // 前端 isEmptyTabsEntry 判定"目标版本里这个容器是 0 页"，靠的就是这个形态：
    // 三个产路口都只在非空时落 tabs 键，所以空容器【没有】tabs 键，而不是 tabs: []。
    // 谁要是改成"空数组也落键"，前端那条判据会静默失效（永远 false），故在此钉死。
    const res = await request("POST", `/api/views/${viewId}/layout-versions`, {
      label: "空容器形态",
      snapshot: { layout: layoutOf([f1]), tabs: { [c1]: { cards: [], lazyTouched: [] } } },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { version: { id: string } };

    const got = await request("GET", `/api/views/${viewId}/layout-versions/${created.version.id}`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { version: { snapshot: { tabs: Record<string, unknown> } } };
    expect(body.version.snapshot.tabs[c1]).toEqual({ cards: [], lazyTouched: [] });
    expect(Object.keys(body.version.snapshot.tabs[c1] as object).sort()).toEqual(["cards", "lazyTouched"]);
  });
});
