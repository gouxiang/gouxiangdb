// M2/S8 升级演练（计划 §7-S8 第 4 条，DoD 第 3 条）。
//
// 构造一份"组织迁移之前的旧库"：用只含前 12 个迁移目录的临时 schema 跑
// `prisma migrate deploy`（即 M2 之前的完整现网结构：users/members/kb 等，无任何组织表）；
// 插入 3 个仅带原始列的存量用户与 base/kb 业务数据；随后用真实 16 迁移 schema 再 deploy，
// 断言：
//   - 组织两迁移落表 applied；存量 users 全 ACTIVE/ws_default/tv0；
//   - owner 自举恰好一行（createdAt 最早者，createdBy=system-bootstrap）；
//   - ws_default/五系统角色就位；存量 members/kb 行无损；
//   - 再跑一次 deploy 幂等：16 行 applied、无新增 owner。
// 注：M3 起迁移总数 14 -> 16（nav DDL + nav 回填），本演练随直升到 16。
// 用临时 migrations 目录而非手写 _prisma_migrations，保证校验和由 prisma 自己记录。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

const PRE_ORG_COUNT = 12; // M2 之前的迁移目录数

let tmpRoot: string;
let dbFile: string;
let db: Database.Database;

function migDirs(): string[] {
  return fs.readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function deploy(schemaPath: string) {
  execSync(`pnpm exec prisma migrate deploy --schema=${schemaPath}`, {
    cwd: process.cwd(), stdio: "pipe", env: process.env,
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s8-upgrade-"));
  dbFile = path.join(tmpRoot, "legacy.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpRoot;

  // 1) 临时 schema 树：复制 schema.prisma 与前 12 个迁移目录。
  fs.mkdirSync(path.join(tmpRoot, "migrations"));
  fs.copyFileSync(path.resolve("prisma/schema.prisma"), path.join(tmpRoot, "schema.prisma"));
  const dirs = migDirs();
  expect(dirs.length).toBe(16); // M3 起 14 -> 16（nav DDL + nav 回填）
  for (const name of dirs.slice(0, PRE_ORG_COUNT)) {
    fs.cpSync(path.resolve("prisma/migrations", name), path.join(tmpRoot, "migrations", name), { recursive: true });
  }

  // 2) 旧库部署到 M2 之前。
  deploy(path.join(tmpRoot, "schema.prisma"));
  db = new Database(dbFile);
  db.pragma("foreign_keys=ON");

  // 3) 旧库不存在任何组织表/列。
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
  for (const t of ["workspaces", "departments", "dept_members", "role_assignments"]) expect(tables.has(t)).toBe(false);
  const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols).not.toContain("status");

  // 4) 写存量 v0.1 数据：3 个仅原始列的用户 + base 成员 + 知识库。
  db.prepare("INSERT INTO bases (id,name,createdBy) VALUES (?,?,?)").run("b1", "旧库 base", "legacy_2");
  const insUser = db.prepare("INSERT INTO users (id,email,displayName,passwordHash,createdAt) VALUES (?,?,?,?,?)");
  insUser.run("legacy_2", "two@old.example.com", "老二", "hash2", "2026-02-02 00:00:00");
  insUser.run("legacy_1", "one@old.example.com", "老大", "hash1", "2026-01-01 00:00:00"); // 最早
  insUser.run("legacy_3", "three@old.example.com", "老三", "hash3", "2026-03-03 00:00:00");
  db.prepare("INSERT INTO members (id,baseId,userId,role) VALUES (?,?,?,?)").run("m1", "b1", "legacy_1", "owner");
  // updatedAt 为 Prisma 应用层 @updatedAt（无 DB 默认），裸 SQL 造旧数据需显式给值。
  db.prepare("INSERT INTO knowledge_bases (id,name,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?)")
    .run("kb1", "旧库 KB", "legacy_1", "2026-02-10 00:00:00", "2026-02-10 00:00:00");
  db.prepare("INSERT INTO kb_docs (id,kbId,kind,title,content,createdBy,updatedBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("doc1", "kb1", "doc", "旧文档", "正文", "legacy_1", "legacy_1", "2026-02-11 00:00:00", "2026-02-11 00:00:00");
  db.prepare("INSERT INTO kb_members (id,kbId,userId,role) VALUES (?,?,?,?)").run("km1", "kb1", "legacy_2", "viewer");
  db.close();
}, 120000);

afterAll(() => {
  if (db?.open) db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("旧库（前 12 迁移）升级到 16 迁移", () => {
  it("两条组织迁移 applied，存量用户回填 ACTIVE/ws_default/tv0，owner 自举恰好一行", () => {
    // 真实 schema（16 迁移）对旧库 deploy：补两条组织 + 两条 nav。
    expect(() => deploy(path.resolve("prisma/schema.prisma"))).not.toThrow();

    db = new Database(dbFile);
    const applied = db.prepare(
      "SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY finished_at",
    ).all() as Array<{ migration_name: string }>;
    expect(applied).toHaveLength(16);
    expect(applied.map((r) => r.migration_name)).toContain("20260915090000_enterprise_org_ddl");
    expect(applied.map((r) => r.migration_name)).toContain("20260915090100_enterprise_org_backfill");

    const users = db.prepare("SELECT id,status,workspaceId,tokenVersion FROM users ORDER BY createdAt,id").all() as
      Array<{ id: string; status: string; workspaceId: string | null; tokenVersion: number }>;
    expect(users).toHaveLength(3);
    for (const u of users) {
      expect(u.status).toBe("ACTIVE");
      expect(u.workspaceId).toBe("ws_default");
      expect(u.tokenVersion).toBe(0);
    }

    const owners = db.prepare(
      "SELECT subjectId, createdBy FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
    ).all() as Array<{ subjectId: string; createdBy: string }>;
    expect(owners).toHaveLength(1);
    expect(owners[0].subjectId).toBe("legacy_1"); // createdAt 最早
    expect(owners[0].createdBy).toBe("system-bootstrap");

    const ws = db.prepare("SELECT id FROM workspaces").all() as Array<{ id: string }>;
    expect(ws.map((w) => w.id)).toEqual(["ws_default"]);
    const roleCount = db.prepare("SELECT count(*) n FROM roles WHERE isSystem=1").get() as { n: number };
    expect(roleCount.n).toBe(5);

    // 存量业务数据无损
    expect((db.prepare("SELECT count(*) n FROM members").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT count(*) n FROM kb_docs").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT count(*) n FROM kb_members").get() as { n: number }).n).toBe(1);
  });

  it("再 deploy 一次幂等：仍 16 applied，owner 仍只有一行，无额外迁移记录", async () => {
    expect(() => deploy(path.resolve("prisma/schema.prisma"))).not.toThrow();
    const n = (db.prepare("SELECT count(*) n FROM _prisma_migrations").get() as { n: number }).n;
    expect(n).toBe(16);
    const owners = (db.prepare(
      "SELECT count(*) n FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
    ).get() as { n: number }).n;
    expect(owners).toBe(1);
    // 回填幂等：status/workspaceId 不变
    const bad = (db.prepare(
      "SELECT count(*) n FROM users WHERE status!='ACTIVE' OR workspaceId!='ws_default' OR tokenVersion!=0",
    ).get() as { n: number }).n;
    expect(bad).toBe(0);
  });
});
