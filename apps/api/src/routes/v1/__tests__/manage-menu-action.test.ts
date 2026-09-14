// M3/S6 manage_menu 第四动作位：白名单穷举 + owner 迁移幂等测试。
//
// - 四枚动作（departments/members/roles/menu）经 requireOrgAction 构造均不抛
//   "未知组织管理动作"；非法动作必须同步抛（authActive 接线纪律）。
// - 20260916100000_owner_manage_menu 迁移手工连跑两次：role_owner permissions
//   恒为四动作固定 JSON 串（幂等：已含 manage_menu 不被改写）；非 owner 行不触碰。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { setupOrgHarness, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { ORG_ACTIONS } from "@gx/shared-types";
import { requireOrgAction } from "../../../middleware/authActive.js";

let h: OrgHarness;
let raw: Database.Database;

beforeAll(async () => {
  h = await setupOrgHarness();
  raw = new Database(path.join(h.tmpDir, "org.db"));
  raw.pragma("foreign_keys=ON");
}, 120000);

afterAll(async () => {
  raw?.close();
  await h.cleanup();
});

describe("组织管理动作白名单", () => {
  it("ORG_ACTIONS 恰为四枚且含 manage_menu", () => {
    expect([...ORG_ACTIONS].sort()).toEqual([
      "manage_departments", "manage_members", "manage_menu", "manage_roles",
    ]);
  });

  it.each([...ORG_ACTIONS])("requireOrgAction(%s) 构造不抛未知动作", (action) => {
    expect(() => requireOrgAction(action)).not.toThrow();
  });

  it("requireOrgAction(非法动作) 同步抛错（接线期暴露，不静默放行）", () => {
    expect(() => requireOrgAction("drop_table" as never)).toThrow(/未知组织管理动作/);
  });
});

describe("owner_manage_menu 只增迁移", () => {
  const FOUR = '["manage_departments","manage_members","manage_roles","manage_menu"]';
  const migrationSql = fs.readFileSync(
    path.resolve("prisma/migrations/20260916100000_owner_manage_menu/migration.sql"),
    "utf8",
  );

  it("deploy 后 owner 已持四动作；自定义空动作角色不被迁移改写", async () => {
    await h.prisma.role.create({
      data: { id: "role_c_empty", workspaceId: "ws_default", systemKey: null, name: "空角色", description: "", isSystem: 0, permissions: "[]" },
    });
    const owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FOUR);
  });

  it("迁移 SQL 连跑两次幂等：owner 恒四动作，空角色仍 []", () => {
    raw.exec(migrationSql);
    raw.exec(migrationSql);
    const owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FOUR);
    const empty = raw.prepare("SELECT permissions FROM roles WHERE id='role_c_empty'").get() as { permissions: string };
    expect(empty.permissions).toBe("[]");
  });

  it("迁移只改恰好三动作的 owner 行：手工置回三动作再跑可补，已四动作不被无意义改写", () => {
    raw.prepare(
      `UPDATE roles SET permissions='["manage_departments","manage_members","manage_roles"]' WHERE id='role_owner'`,
    ).run();
    raw.exec(migrationSql);
    const owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FOUR);
  });
});
