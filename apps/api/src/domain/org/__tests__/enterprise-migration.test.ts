// M2/S1 迁移/回填特征测试（干净临时库 + 真 prisma migrate deploy + better-sqlite3 复核）。
//
// 覆盖：
//  - 迁移目录数 12 -> 14；两条新迁移都被记录为 applied；
//  - ws_default 幂等单播；五枚系统角色（仅 owner 持三 manage_*，余 permissions=[]）；
//  - 空库 backfill 不产生 owner 自举；新 users 列默认 status=ACTIVE/tv0/workspaceId=NULL；
//  - 手动重放 backfill：全部用户置 ACTIVE/ws_default/0、最早用户恰好获一枚 owner 授予；
//    再重放两次仍只一枚（幂等可重入）；
//  - 一人一主部门部分唯一索引生效；integrity_check=ok；deploy 重跑 rc=0（已应用跳过）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let tmpDir: string;
let dbFile: string;
let db: Database.Database;
let backfillSql: string;

function migDirs(): string[] {
  const root = path.resolve(process.cwd(), "prisma/migrations");
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m2-mig-"));
  dbFile = path.join(tmpDir, "m.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.NODE_ENV = "test";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  db = new Database(dbFile);
  db.pragma("foreign_keys=ON");
  backfillSql = fs.readFileSync(
    path.resolve(process.cwd(), "prisma/migrations/20260915090100_enterprise_org_backfill/migration.sql"),
    "utf8",
  );
}, 120000);

afterAll(() => {
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("迁移清单与部署", () => {
  it("M2 两条迁移在目录中且落表为 applied（目录总数随后续里程碑只增，M3 起 >=14）", () => {
    const dirs = migDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(14);
    expect(dirs).toContain("20260915090000_enterprise_org_ddl");
    expect(dirs).toContain("20260915090100_enterprise_org_backfill");
    const applied = db.prepare("SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations")
      .all() as Array<{ migration_name: string; finished_at: string | null; rolled_back_at: string | null }>;
    for (const name of ["20260915090000_enterprise_org_ddl", "20260915090100_enterprise_org_backfill"]) {
      const row = applied.find((r) => r.migration_name === name);
      expect(row?.finished_at).not.toBeNull();
      expect(row?.rolled_back_at).toBeNull();
    }
  });

  it("prisma migrate deploy 重跑 rc=0（已应用全部跳过，可重入）", () => {
    expect(() =>
      execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
        cwd: process.cwd(), stdio: "ignore", env: process.env,
      })).not.toThrow();
  });
});

describe("系统种子（幂等单播）", () => {
  it("workspaces 恰好一个 ws_default", () => {
    const ws = db.prepare("SELECT id, name, policyVersion FROM workspaces").all() as
      Array<{ id: string; name: string; policyVersion: number }>;
    expect(ws).toEqual([{ id: "ws_default", name: "默认工作区", policyVersion: 0 }]);
  });

  it("五枚系统角色，仅 owner 持三枚 manage_*，其余 permissions=[]", () => {
    const ORDER: Record<string, number> = { owner: 0, creator: 1, editor: 2, commenter: 3, viewer: 4 };
    const roles = (db.prepare("SELECT systemKey, isSystem, permissions FROM roles").all() as
      Array<{ systemKey: string; isSystem: number; permissions: string }>)
      .sort((a, b) => ORDER[a.systemKey] - ORDER[b.systemKey]);
    expect(roles.map((r) => r.systemKey)).toEqual(["owner", "creator", "editor", "commenter", "viewer"]);
    expect(roles.every((r) => r.isSystem === 1)).toBe(true);
    const byKey = Object.fromEntries(roles.map((r) => [r.systemKey, JSON.parse(r.permissions) as string[]]));
    expect(byKey.owner.sort()).toEqual(["manage_departments", "manage_members", "manage_menu", "manage_roles"]);
    for (const k of ["creator", "editor", "commenter", "viewer"]) expect(byKey[k]).toEqual([]);
  });

  it("空库 backfill 不产生 owner 自举", () => {
    const n = db.prepare("SELECT count(*) n FROM role_assignments").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("users 扩列默认值与幂等回填", () => {
  it("新插入用户默认 status=ACTIVE、tokenVersion=0、workspaceId 留待回填（NULL）", () => {
    db.prepare("INSERT INTO users (id,email,displayName,passwordHash) VALUES (?,?,?,?)")
      .run("u0", "u0@x.com", "U0", "x");
    const u = db.prepare("SELECT status, workspaceId, tokenVersion, disabledAt, inviteTokenHash, invitedAt FROM users WHERE id='u0'")
      .get() as Record<string, unknown>;
    expect(u.status).toBe("ACTIVE");
    expect(u.workspaceId).toBeNull();
    expect(u.tokenVersion).toBe(0);
    expect(u.disabledAt).toBeNull();
    expect(u.inviteTokenHash).toBeNull();
    expect(u.invitedAt).toBeNull();
  });

  it("backfill：全部用户 ACTIVE/ws_default/0，最早用户恰好获一枚 owner；重放仍一枚", () => {
    const insert = db.prepare(
      "INSERT INTO users (id,email,displayName,passwordHash,createdAt) VALUES (?,?,?,?,?)",
    );
    // u0 用更早 createdAt；u1 最早（createdAt 最小），u2 次之——先清 u0 重建以控制序。
    db.prepare("DELETE FROM users").run();
    insert.run("u2", "u2@x.com", "U2", "x", "2026-03-03 00:00:00");
    insert.run("u1", "u1@x.com", "U1", "x", "2026-03-01 00:00:00");
    insert.run("u3", "u3@x.com", "U3", "x", "2026-03-02 00:00:00");

    db.exec(backfillSql);
    const users = db.prepare("SELECT id,status,workspaceId,tokenVersion FROM users ORDER BY id").all() as
      Array<{ id: string; status: string; workspaceId: string; tokenVersion: number }>;
    expect(users).toHaveLength(3);
    for (const u of users) {
      expect(u.status).toBe("ACTIVE");
      expect(u.workspaceId).toBe("ws_default");
      expect(u.tokenVersion).toBe(0);
    }
    const owners = db.prepare(
      "SELECT subjectId FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
    ).all() as Array<{ subjectId: string }>;
    expect(owners.map((o) => o.subjectId)).toEqual(["u1"]); // createdAt 最小者

    db.exec(backfillSql);
    db.exec(backfillSql);
    const again = db.prepare(
      "SELECT count(*) n FROM role_assignments WHERE roleId='role_owner' AND subjectType='user'",
    ).get() as { n: number };
    expect(again.n).toBe(1);
  });
});

describe("部分唯一索引与完整性", () => {
  it("同一用户两个 isMain=1 被部分唯一索引拒绝", () => {
    db.prepare("INSERT INTO departments (id,workspaceId,path,name) VALUES (?,?,?,?)")
      .run("dA", "ws_default", "/dA/", "DA");
    db.prepare("INSERT INTO departments (id,workspaceId,path,name) VALUES (?,?,?,?)")
      .run("dB", "ws_default", "/dB/", "DB");
    db.prepare("INSERT INTO dept_members (id,departmentId,userId,isMain) VALUES (?,?,?,1)")
      .run("m1", "dA", "u1");
    expect(() =>
      db.prepare("INSERT INTO dept_members (id,departmentId,userId,isMain) VALUES (?,?,?,1)")
        .run("m2", "dB", "u1"),
    ).toThrow(/UNIQUE/);
  });

  it("integrity_check=ok", () => {
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
