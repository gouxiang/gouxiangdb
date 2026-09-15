// M3/S2 回填演练：v0.1.0 风格旧库（前 12 迁移）-> 14（M2）-> 16（M3）直升，
// 断言节点数=活实体数、默认菜单容器数=活 base+活 kb、零入口 shortcut 齐、
// reconcile 只读在 path 重建前报 A6、--apply 后 0 差异、连跑第二次 no changes；
// 手工重放回填 SQL 行数零增长；软删/隐藏实体不回填。
//
// 造库技法同 s8-upgrade-drill：临时 schema 树复制前 N 迁移目录，prisma 自记校验和。
// 本文件用 PrismaClient 直连（不动态 import app），路径解析需把 prisma schema 指向临时树后
// 再 deploy；应用侧期望集计算通过直接 new PrismaClient 调 domain/nav 原语完成。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { computeDiffs, applyFixesTx } from "../reconcile.js";
import { buildExpectedNodes } from "../backfill.js";

const PRE_ORG_COUNT = 12;

let tmpRoot: string;
let dbFile: string;
let prisma: PrismaClient;

function migDirs(): string[] {
  return fs.readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m3-s2-"));
  dbFile = path.join(tmpRoot, "legacy.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.NODE_ENV = "test";

  // 1) 旧库（前 12 迁移）。
  fs.mkdirSync(path.join(tmpRoot, "migrations"));
  fs.copyFileSync(path.resolve("prisma/schema.prisma"), path.join(tmpRoot, "schema-legacy.prisma"));
  const dirs = migDirs();
  expect(dirs.length).toBe(20); // M4-S5 起 owner manage_share 补位迁移使总数 19 -> 20
  for (const name of dirs.slice(0, PRE_ORG_COUNT)) {
    fs.cpSync(path.resolve("prisma/migrations", name), path.join(tmpRoot, "migrations", name), { recursive: true });
  }
  execSync(`pnpm exec prisma migrate deploy --schema=${path.join(tmpRoot, "schema-legacy.prisma")}`, {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });

  // 2) 造存量数据：1 活 base（1 活表+1 隐藏视图表）、1 软删 base、1 活 kb（根 doc/子 doc/canvas）。
  const raw = new (await import("better-sqlite3")).default(dbFile);
  raw.pragma("foreign_keys=ON");
  const now = "2026-03-01 00:00:00";
  raw.prepare("INSERT INTO users (id,email,displayName,passwordHash,createdAt) VALUES (?,?,?,?,?)")
    .run("u1", "u1@x.com", "U1", "h", "2026-01-01 00:00:00");
  raw.prepare("INSERT INTO bases (id,name,createdBy,createdAt) VALUES (?,?,?,?)").run("b1", "活库", "u1", "2026-02-01 00:00:00");
  raw.prepare("INSERT INTO bases (id,name,createdBy,createdAt,deletedAt) VALUES (?,?,?,?,?)").run("b2", "删库", "u1", "2026-02-02 00:00:00", now);
  raw.prepare("INSERT INTO members (id,baseId,userId,role) VALUES (?,?,?,?)").run("mm1", "b1", "u1", "owner");
  raw.prepare("INSERT INTO tables (id,baseId,name,primaryFieldId,createdBy,createdAt) VALUES (?,?,?,?,?,?)")
    .run("t1", "b1", "活表", "", "u1", "2026-02-03 00:00:00");
  raw.prepare("INSERT INTO tables (id,baseId,name,primaryFieldId,createdBy,createdAt) VALUES (?,?,?,?,?,?)")
    .run("t2", "b1", "无视图的表", "", "u1", "2026-02-04 00:00:00");
  raw.prepare("INSERT INTO views (id,tableId,name,type,\"order\",config,createdAt) VALUES (?,?,?,?,?,?,?)")
    .run("v1", "t1", "网格", "grid", 0, "{}", "2026-02-03 00:00:00");

  raw.prepare("INSERT INTO knowledge_bases (id,name,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?)")
    .run("k1", "活 KB", "u1", "2026-02-10 00:00:00", "2026-02-10 00:00:00");
  raw.prepare("INSERT INTO kb_members (id,kbId,userId,role) VALUES (?,?,?,?)").run("km1", "k1", "u1", "owner");
  const insDoc = (id: string, kind: string, title: string, parent: string | null, updated: string) =>
    raw.prepare("INSERT INTO kb_docs (id,kbId,kind,title,content,parentId,createdBy,updatedBy,createdAt,updatedAt,contentVersion) VALUES (?,?,?,?,?,?,?,?,?,?,1)")
      .run(id, "k1", kind, title, kind === "canvas" ? "[]" : "", parent, "u1", "u1", updated, updated);
  insDoc("d1", "doc", "根文档", null, "2026-03-05 00:00:00");
  insDoc("d2", "doc", "子文档", "d1", "2026-03-04 00:00:00");
  insDoc("c1", "canvas", "画布", null, "2026-03-06 00:00:00");
  raw.close();

  // 3) 真实 16 迁移 schema 直升。
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
}, 180000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("12 -> 20 直升回填（nav 迁移 B SQL 首跑；M4-S5 后总数 20）", () => {
  it("迁移全 applied（20），活实体节点数精确，软删/无视图表不产生悬挂", async () => {
    const applied = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) n FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
    expect(Number(applied[0].n)).toBe(20);

    const nodes = await prisma.navNode.findMany({ where: { deletedAt: null } });
    // 活实体：b1 + t1 + t2 + v1 + k1 + d1 + d2 + c1 = 8（b2 软删不回填）。
    expect(nodes).toHaveLength(8);
    const byKind = nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.kind] = (acc[n.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind).toMatchObject({ base: 1, table: 2, view: 1, kb: 1, doc: 2, canvas: 1 });

    const child = nodes.find((n) => n.resourceId === "d2")!;
    expect(child.parentId).toBe("nav_doc_d1"); // doc 父镜像
    const rootDoc = nodes.find((n) => n.resourceId === "d1")!;
    expect(rootDoc.parentId).toBe("nav_kb_k1");
    const view = nodes.find((n) => n.resourceId === "v1")!;
    expect(view.parentId).toBe("nav_table_t1");
  });

  it("默认菜单：容器数=活 base+活 kb=2；零入口 shortcut 覆盖每 table/根 doc/canvas", async () => {
    const containers = await prisma.menuItem.count({ where: { type: "container", deletedAt: null } });
    expect(containers).toBe(2);
    const baseContainer = await prisma.menuItem.findFirstOrThrow({ where: { id: "menu_base_b1" } });
    expect(baseContainer.iconName).toBe("database");
    const kbContainer = await prisma.menuItem.findFirstOrThrow({ where: { id: "menu_kb_k1" } });
    expect(kbContainer.iconName).toBe("book");

    const shortcuts = await prisma.menuItem.findMany({ where: { type: "shortcut", deletedAt: null } });
    // 2 table（t1/t2）+ 根 doc（d1，子 doc d2 不挂）+ canvas（c1）= 4；view 无 shortcut。
    expect(shortcuts).toHaveLength(4);
    const nodeIds = shortcuts.map((s) => s.nodeId).sort();
    expect(nodeIds).toEqual(["nav_canvas_c1", "nav_doc_d1", "nav_table_t1", "nav_table_t2"]);
  });

  it("手工重放回填 SQL 行数零增长（幂等）", async () => {
    // 直接在进程内用 better-sqlite3 重放整份迁移 SQL（不走 shell，避免引号转义问题）；
    // 全部 INSERT 都带 NOT EXISTS 业务键判重，重放必须零增长。
    const sql = fs.readFileSync(
      path.resolve("prisma/migrations/20260916093000_enterprise_nav_backfill/migration.sql"),
      "utf8",
    );
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(dbFile);
    raw.pragma("foreign_keys=ON");
    raw.exec(sql);
    raw.close();
    // 重放后数量不变。
    expect(await prisma.navNode.count({ where: { deletedAt: null } })).toBe(8);
    expect(await prisma.menuItem.count({ where: { deletedAt: null } })).toBe(6);
  });
});

describe("reconcile 与 path 重建", () => {
  it("path 重建前：根节点 path 正确、非根为空 -> reconcile 只读报 A6；--apply 重算后 0 差异", async () => {
    const rootBase = await prisma.navNode.findFirstOrThrow({ where: { id: "nav_base_b1" } });
    expect(rootBase.path).toBe("/nav_base_b1/");
    const nonRoot = await prisma.navNode.findFirstOrThrow({ where: { id: "nav_table_t1" } });
    expect(nonRoot.path).toBe(""); // 迁移 B 只给根节点 path

    const before = await prisma.$transaction((tx) => computeDiffs(tx));
    expect(before.A.some((d) => d.code === "A6")).toBe(true);
    expect(before.summary.A + before.summary.B + before.summary.C).toBeGreaterThan(0);

    const fix = await prisma.$transaction((tx) => applyFixesTx(tx));
    // path 重建应有非零变化。
    expect(fix.nodes.pathsRebuilt).toBeGreaterThan(0);

    const rebuilt = await prisma.navNode.findFirstOrThrow({ where: { id: "nav_view_v1" } });
    expect(rebuilt.path).toBe("/nav_base_b1/nav_table_t1/nav_view_v1/");
    expect(rebuilt.depth).toBe(3);
    const subDoc = await prisma.navNode.findFirstOrThrow({ where: { id: "nav_doc_d2" } });
    expect(subDoc.path).toBe("/nav_kb_k1/nav_doc_d1/nav_doc_d2/");
    expect(subDoc.depth).toBe(3);

    const after = await prisma.$transaction((tx) => computeDiffs(tx));
    expect(after.summary.A + after.summary.B + after.summary.C).toBe(0);
    // 迁移 B 全收纳：2 table + 根 doc + canvas 均有 shortcut，C4/C5 warning 也为 0。
    expect(after.summary.warnings).toBe(0);
  });

  it("连跑第二次 --apply：no changes（created/updated/rebuilt/softDeleted/purged 全 0）", async () => {
    const again = await prisma.$transaction((tx) => applyFixesTx(tx));
    expect(again.nodes.created).toBe(0);
    expect(again.nodes.updated).toBe(0);
    expect(again.nodes.revived).toBe(0);
    expect(again.nodes.pathsRebuilt).toBe(0);
    expect(again.softDeleted.nodes).toBe(0);
    expect(again.softDeleted.shortcuts).toBe(0);
    expect(again.purged.nodes).toBe(0);
    expect(again.purged.shortcuts).toBe(0);
    const report = await prisma.$transaction((tx) => computeDiffs(tx));
    // 迁移 B 全收纳基线：阻断 0，C4 未收纳 warning 也为 0。
    expect(report.summary.A + report.summary.B + report.summary.C).toBe(0);
    expect(report.summary.warnings).toBe(0);
  });

  it("期望集与迁移结果一致（buildExpectedNodes 同规则）", async () => {
    const expected = await prisma.$transaction((tx) => buildExpectedNodes(tx));
    expect(expected).toHaveLength(8);
    const d2 = expected.find((e) => e.resourceId === "d2")!;
    expect(d2.parentId).toBe("nav_doc_d1");
  });
});
