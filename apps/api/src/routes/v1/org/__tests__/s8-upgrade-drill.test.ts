// M2/S8 升级演练（计划 §7-S8 第 4 条，DoD 第 3 条）。
//
// 构造一份"组织迁移之前的旧库"：用只含前 12 个迁移目录的临时 schema 跑
// `prisma migrate deploy`（即 M2 之前的完整现网结构：users/members/kb 等，无任何组织表）；
// 插入 3 个仅带原始列的存量用户与 base/kb 业务数据；随后用真实 22 迁移 schema 再 deploy，
// 断言：
//   - 组织/nav/manage_menu/authz 回填/scope creator 索引/manage_share 八迁移落表 applied；存量 users 全 ACTIVE/ws_default/tv0；
//   - 超级管理员自举恰好一行（createdAt 最早者，createdBy=system-bootstrap）；
//   - ws_default/七系统角色就位（超级管理员持全部组织动作）；存量 members/kb 行无损；
//   - 再跑一次 deploy 幂等：44 行 applied、无新增超级管理员。
// 注：迁移总数 12 -> 14（M2 组织）-> 16（M3 nav）-> 17（M3-S6 manage_menu）
//     -> 18（M4-S2 authz_policies_backfill）-> 19（M4-S4 createdBy 四索引）
//     -> 20（M4-S5 owner manage_share 补位）-> 21/22（M5-S1 outbox DDL/活实体播种）
//     -> 23（M6-S1 PAT/mcp_idempotency 两表），本演练直升到 23。
//     M5-S1 第 22 迁移会为旧库唯一活 kb_doc 播一条 pending change_event，本演练不断言该表。
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
  expect(dirs.length).toBe(44); // 历史累计 41（组织/nav/搜索 outbox/权限角色/分享/collab_docs/A3 autoNumber/A4 库名唯一/A6 shareEnabled/view adminConfig/view_user_prefs/attachments/record_changes/评论 threads 等）；YN0 离线同步 sync_* 四表 +1；YN 离线客户端 offline_client_ddl +1；副本树态 replica_tree_state +1。slice(0,PRE_ORG_COUNT=12) 旧库切点不变。
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

describe("旧库（前 12 迁移）升级到 44 迁移", () => {
  it("组织/nav/manage_menu/authz 回填/scope 索引/manage_share/outbox DDL+播种 等迁移 applied，存量用户回填 ACTIVE/ws_default/tv0，owner 自举恰好一行；YN0 sync 四表、离线客户端 DDL、副本树态随升级建立（默认 off 不写）", () => {
    // 真实 schema（44 迁移）对旧库 deploy：补组织/nav/manage_menu/authz/scope/manage_share/outbox/实体 icon/owner create_library 等，最新两枚为离线客户端 DDL 与副本树态。
    expect(() => deploy(path.resolve("prisma/schema.prisma"))).not.toThrow();

    db = new Database(dbFile);
    const applied = db.prepare(
      "SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY finished_at",
    ).all() as Array<{ migration_name: string }>;
    expect(applied).toHaveLength(44); // 历史 #1..#41（组织/nav/搜索/权限/视图/附件/记录变更/评论等）+ #42 YN0 sync_* 四表 + #43 离线客户端 offline_client_ddl + #44 副本树态 replica_tree_state
    expect(applied.map((r) => r.migration_name)).toContain("20260915090000_enterprise_org_ddl");
    expect(applied.map((r) => r.migration_name)).toContain("20260915090100_enterprise_org_backfill");
    expect(applied.map((r) => r.migration_name)).toContain("20260916100000_owner_manage_menu");
    expect(applied.map((r) => r.migration_name)).toContain("20260916110000_authz_policies_backfill");
    expect(applied.map((r) => r.migration_name)).toContain("20260916120000_authz_scope_creator_indexes");
    expect(applied.map((r) => r.migration_name)).toContain("20260916130000_owner_manage_share");
    expect(applied.map((r) => r.migration_name)).toContain("20260916140000_m5_search_outbox_ddl");
    expect(applied.map((r) => r.migration_name)).toContain("20260916140100_m5_search_outbox_seed");
    expect(applied.map((r) => r.migration_name)).toContain("20260919110000_owner_create_library");
    // YN 离线客户端 + 副本树态（默认 off，只建表不写数据）。
    expect(applied.map((r) => r.migration_name)).toContain("20261019120000_offline_client_ddl");
    expect(applied.map((r) => r.migration_name)).toContain("20261020120000_replica_tree_state");

    // M4-S2 回填：旧 owner 成员（m1=legacy_1 / kb viewer km1=legacy_2）投影成 legacy 策略行，
    // 不写 role_assignments（资源 owner 不抬升为工作区管理员）；行数=活 members+kb_members（无 acl）。
    const legacyPolicies = db.prepare(
      "SELECT count(*) n FROM auth_policies WHERE reason LIKE 'legacy:%'",
    ).get() as { n: number };
    expect(legacyPolicies.n).toBe(2);
    const ownerPolicies = db.prepare(
      "SELECT actions FROM auth_policies WHERE reason='legacy:member' AND subjectId='legacy_1'",
    ).all() as Array<{ actions: string }>;
    expect(ownerPolicies[0]?.actions).toBe("c,comment,d,manage_schema,manage_share,r,u");

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
    expect(roleCount.n).toBe(7);

    // 升级链上超级管理员（行 id role_owner）从三动作一路补到十八动作，串逐字同序无空格。
    const ownerPerms = db.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(ownerPerms.permissions).toBe(
      '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users","create_roles","edit_roles","delete_roles","assign_role_members","create_departments","edit_departments","delete_departments"]',
    );

    // 存量业务数据无损
    expect((db.prepare("SELECT count(*) n FROM members").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT count(*) n FROM kb_docs").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT count(*) n FROM kb_members").get() as { n: number }).n).toBe(1);
   // 120s：真实 deploy（44 迁移）实测 13s+，默认 5s 超时必红；与 beforeAll 同档。
  }, 120000);

  it("再 deploy 一次幂等：仍 44 applied，owner 六动作串不变且只一行，legacy 投影不重复增长", async () => {
    expect(() => deploy(path.resolve("prisma/schema.prisma"))).not.toThrow();
    const n = (db.prepare("SELECT count(*) n FROM _prisma_migrations").get() as { n: number }).n;
    expect(n).toBe(44);
    // 权限核心模型迁移幂等：超级管理员仍恰为全动作串，连跑不被改写/不重复追加。
    const ownerPerms = db.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(ownerPerms.permissions).toBe(
      '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users","create_roles","edit_roles","delete_roles","assign_role_members","create_departments","edit_departments","delete_departments"]',
    );
    const owners = (db.prepare(
      "SELECT count(*) n FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
    ).get() as { n: number }).n;
    expect(owners).toBe(1);
    // authz 回填幂等：legacy 策略行仍为 2（NOT EXISTS 挡住重复插入）
    const legacy = (db.prepare(
      "SELECT count(*) n FROM auth_policies WHERE reason LIKE 'legacy:%'",
    ).get() as { n: number }).n;
    expect(legacy).toBe(2);
    // 回填幂等：status/workspaceId 不变
    const bad = (db.prepare(
      "SELECT count(*) n FROM users WHERE status!='ACTIVE' OR workspaceId!='ws_default' OR tokenVersion!=0",
    ).get() as { n: number }).n;
    expect(bad).toBe(0);
    // 120s：再跑一次真实 deploy（幂等），同样不能用默认 5s。
  }, 120000);
});
