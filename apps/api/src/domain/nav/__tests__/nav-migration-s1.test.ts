// M3/S1 迁移 A 特征测试：nav_nodes/menu_items/auth_policies DDL + workspaces 两列。
//
// 干净临时库真 prisma migrate deploy + better-sqlite3 复核：
//  - 迁移目录 14 -> 16（S1 DDL + S2 回填同 commit），DDL 迁移 applied；
//  - 三表列/索引齐；workspaces.navVersion/menuVersion 默认 0；
//  - menu_items.nodeId 对 nav_nodes 是 ON DELETE RESTRICT（先清引用才能删节点）；
//  - menu_items 自引用 ON DELETE CASCADE（删父容器连子项）；
//  - nav_nodes 与实体表无 FK（应用层保引用）；
//  - auth_policies 结构冻结：空表，且 src 业务代码（排除测试）无任何 authPolicy 读写
//    （M3 全里程碑零业务路径，M4 才启用，计划 §2.1-10/§4.1）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let tmpDir: string;
let dbFile: string;
let db: Database.Database;

function migDirs(): string[] {
  const root = path.resolve(process.cwd(), "prisma/migrations");
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function tableSql(name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}

function fkList(table: string) {
  return db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    table: string;
    on_delete: string;
    from: string;
    to: string;
  }>;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m3-s1-"));
  dbFile = path.join(tmpDir, "n.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.NODE_ENV = "test";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  db = new Database(dbFile);
  db.pragma("foreign_keys=ON");
}, 120000);

afterAll(() => {
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("迁移清单", () => {
  it("迁移目录数为 36（M6-S1 PAT/幂等两表 + init_admin_must_change + 实体 icon/iconColor DDL 后；含 M5-S1 outbox DDL/播种、M4-S5 owner manage_share 补位与角色×库 canShare 独立分享位、表单设计器布局版本表；A3 autoNumber 高水位计数表、A4 库名部分唯一索引、A6 shareEnabled 回填再 +3），nav DDL 落 applied，重跑 deploy 幂等", () => {
    const dirs = migDirs();
    expect(dirs.length).toBe(36);
    expect(dirs).toContain("20260916090000_enterprise_nav_ddl");
    expect(dirs).toContain("20260916130000_owner_manage_share");
    expect(dirs).toContain("20260916140000_m5_search_outbox_ddl");
    expect(dirs).toContain("20260918090000_mcp_pat_ddl");
    expect(dirs).toContain("20260916140100_m5_search_outbox_seed");
    expect(dirs).toContain("20260918120000_init_admin_must_change");
    expect(dirs).toContain("20260919102128_entity_icon_ddl");
    expect(dirs).toContain("20260921220000_role_scope_can_share");
    expect(dirs).toContain("20260925010000_auto_number_counters");
    expect(dirs).toContain("20260925020000_library_name_unique");
    expect(dirs).toContain("20260925030000_share_enabled_backfill");
    const applied = db.prepare("SELECT rolled_back_at FROM _prisma_migrations WHERE migration_name=?")
      .get("20260916090000_enterprise_nav_ddl") as { rolled_back_at: string | null } | undefined;
    expect(applied).toBeDefined();
    expect(applied?.rolled_back_at).toBeNull();
    expect(() =>
      execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
        cwd: process.cwd(), stdio: "ignore", env: process.env,
      })).not.toThrow();
  });
});

describe("workspaces 两列", () => {
  it("ws_default 行 navVersion/menuVersion 默认 0", () => {
    const ws = db.prepare("SELECT navVersion, menuVersion FROM workspaces WHERE id='ws_default'").get() as
      { navVersion: number; menuVersion: number } | undefined;
    expect(ws).toEqual({ navVersion: 0, menuVersion: 0 });
  });
});

describe("nav_nodes DDL", () => {
  it("七类 kind 列齐、布尔列默认 INTEGER 0/1、path 默认空串", () => {
    const cols = db.prepare("PRAGMA table_info(nav_nodes)").all() as Array<{ name: string; dflt_value: string | null }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c.dflt_value]));
    for (const c of ["id", "workspaceId", "parentId", "kind", "resourceType", "resourceId", "name",
      "ord", "path", "depth", "isSystem", "config", "iconName", "inheritAncestors", "createdAt", "updatedAt", "deletedAt"]) {
      expect(byName[c]).toBeDefined();
    }
    expect(byName.isSystem).toBe("1");
    expect(byName.inheritAncestors).toBe("1");
    expect(byName.path).toBe("''");
  });

  it("workspace FK cascade、parentId 自引用 RESTRICT、与实体表无任何 FK", () => {
    const fks = fkList("nav_nodes");
    const ws = fks.find((f) => f.table === "workspaces");
    expect(ws?.on_delete).toBe("CASCADE");
    const self = fks.find((f) => f.table === "nav_nodes");
    expect(self?.on_delete).toBe("RESTRICT");
    const entityTables = fks.map((f) => f.table);
    for (const t of ["bases", "tables", "views", "knowledge_bases", "kb_docs"]) {
      expect(entityTables).not.toContain(t);
    }
  });

  it("一资源一权威挂载唯一索引；group 多 NULL 行不冲突", () => {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name='nav_nodes_workspace_resource_key'").get() as
      { sql: string } | undefined;
    expect(idx?.sql).toContain("CREATE UNIQUE INDEX");
    db.prepare("INSERT INTO nav_nodes (id,workspaceId,kind,name,resourceType,resourceId) VALUES (?,?,?,?,?,?)")
      .run("n1", "ws_default", "base", "b", "base", "b1");
    expect(() =>
      db.prepare("INSERT INTO nav_nodes (id,workspaceId,kind,name,resourceType,resourceId) VALUES (?,?,?,?,?,?)")
        .run("n2", "ws_default", "base", "b2", "base", "b1"),
    ).toThrow(/UNIQUE/);
    // group 资源两列均 NULL：SQLite NULL 互不相等，可多行。
    db.prepare("INSERT INTO nav_nodes (id,workspaceId,kind,name,isSystem) VALUES (?,?,?,?,0)")
      .run("g1", "ws_default", "group", "G1");
    db.prepare("INSERT INTO nav_nodes (id,workspaceId,kind,name,isSystem) VALUES (?,?,?,?,0)")
      .run("g2", "ws_default", "group", "G2");
    expect(db.prepare("SELECT count(*) n FROM nav_nodes WHERE kind='group'").get() as { n: number })
      .toMatchObject({ n: 2 });
  });
});

describe("menu_items FK 语义", () => {
  it("nodeId 引用 RESTRICT：有 shortcut 时节点不可删，清引用后可删", () => {
    db.prepare("INSERT INTO nav_nodes (id,workspaceId,kind,name,resourceType,resourceId) VALUES (?,?,?,?,?,?)")
      .run("vn", "ws_default", "view", "v", "view", "v1");
    db.prepare("INSERT INTO menu_items (id,workspaceId,type,nodeId) VALUES (?,?,?,?)")
      .run("m1", "ws_default", "shortcut", "vn");
    expect(() => db.prepare("DELETE FROM nav_nodes WHERE id='vn'").run()).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM menu_items WHERE id='m1'").run();
    db.prepare("DELETE FROM nav_nodes WHERE id='vn'").run();
    expect(db.prepare("SELECT count(*) n FROM nav_nodes WHERE id='vn'").get() as { n: number })
      .toMatchObject({ n: 0 });
  });

  it("自引用 cascade：删父容器连删子菜单项", () => {
    db.prepare("INSERT INTO menu_items (id,workspaceId,type) VALUES (?,?,?)").run("root", "ws_default", "container");
    db.prepare("INSERT INTO menu_items (id,workspaceId,type,parentId) VALUES (?,?,?,?)")
      .run("child", "ws_default", "container", "root");
    db.prepare("DELETE FROM menu_items WHERE id='root'").run();
    expect(db.prepare("SELECT count(*) n FROM menu_items WHERE id IN ('root','child')").get() as { n: number })
      .toMatchObject({ n: 0 });
  });
});

describe("auth_policies 冻结", () => {
  it("表/唯一索引存在且为空", () => {
    expect(tableSql("auth_policies")).toContain("CREATE TABLE");
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name='auth_policies_node_subject_key'").get() as
      { sql: string } | undefined;
    expect(idx?.sql).toContain("CREATE UNIQUE INDEX");
    expect(db.prepare("SELECT count(*) n FROM auth_policies").get() as { n: number }).toMatchObject({ n: 0 });
  });

  it("src 业务代码（排除 __tests__）authPolicy 直接委托仅限 S5 授权三落点（其余模块零直触）", () => {
    // M3 冻结期：任何业务模块都不得直接 prisma/tx.authPolicy（S1/S2 经注入 client 的纯域
    // repository/backfill 不匹配本正则）。M4/S5 打开写路径后，允许直接委托的模块精确收敛为：
    //   - domain/authz/policyAdminTx.ts：PUT policies 整单写；
    //   - domain/authz/projection.ts ：旧三表 -> auth_policies 投影双写；
    //   - domain/nav/sync.ts          ：purge view/table/doc 同事务清孤儿策略。
    // 任何其它模块新增 prisma/tx.authPolicy 都应在此显式登记，防止绕过纯域边界散落直写。
    const S5_ALLOWED = new Set([
      "domain/authz/policyAdminTx.ts",
      "domain/authz/projection.ts",
      "domain/nav/sync.ts",
    ]);
    const srcRoot = path.resolve(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "__tests__") continue;
          walk(full);
        } else if (/\.(ts|tsx|mjs|js)$/.test(ent.name)) {
          const rel = path.relative(srcRoot, full);
          const text = fs.readFileSync(full, "utf8");
          if (/\b(?:prisma|tx)\.authPolicy\b/.test(text) && !S5_ALLOWED.has(rel)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
