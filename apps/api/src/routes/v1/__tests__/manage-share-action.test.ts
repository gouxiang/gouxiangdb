// M4/S5 manage_share 第五动作位：白名单穷举 + roleAdmin 非法文案 + owner 第 20 迁移幂等测试。
//
// - ORG_ACTIONS 恰为十八枚（真源 shared-types，M6 追加 create_library，企业化定位追加通讯录
//   五件套 view_directory/invite_users/create_users/disable_users/delete_users），逐枚经 requireOrgAction
//   构造不抛"未知动作"；
//   非法动作必须同步抛（接线纪律）。
// - 全量 deploy 后 role_owner permissions 恰为六动作固定 JSON 串（含 M6 的 create_library）。
// - 20260916130000_owner_manage_share 只把"恰为四动作"的 owner 行补到五动作：
//   连跑恒等（FOUR -> FIVE，再跑不改写）；自定义角色不触碰；THREE 行不被越级补位（须先过迁移 19）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { setupOrgHarness, type OrgHarness } from "../org/__tests__/orgHarness.js";
import { ORG_ACTIONS } from "@gx/shared-types";
import { requireOrgAction } from "../../../middleware/authActive.js";

let h: OrgHarness;
let raw: Database.Database;

const THREE = '["manage_departments","manage_members","manage_roles"]';
const FOUR = '["manage_departments","manage_members","manage_roles","manage_menu"]';
const FIVE = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share"]';
const _SIX = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library"]';
// 企业化定位（迁移 20260920220000_org_directory_actions）：owner 再追加通讯录五件套。
const EIGHTEEN = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users","create_roles","edit_roles","delete_roles","assign_role_members","create_departments","edit_departments","delete_departments"]';
const migrationSql = fs.readFileSync(
  path.resolve("prisma/migrations/20260916130000_owner_manage_share/migration.sql"),
  "utf8",
);

function setOwner(db: Database.Database, permissions: string): void {
  db.prepare(`UPDATE roles SET permissions='${permissions}' WHERE id='role_owner'`).run();
}

beforeAll(async () => {
  h = await setupOrgHarness();
  raw = new Database(path.join(h.tmpDir, "org.db"));
  raw.pragma("foreign_keys=ON");
}, 120000);

afterAll(async () => {
  raw?.close();
  await h.cleanup();
});

// 权限核心模型（一）又追加了七枚（角色三枚 + 角色成员授予一枚 + 部门三枚），故为十八枚。
describe("组织管理动作白名单（十八枚）", () => {
  it("ORG_ACTIONS 恰为十八枚：追加位是通讯录五件套 + 权限核心模型七枚，既有六枚顺序未变", () => {
    expect([...ORG_ACTIONS]).toEqual([
      "manage_departments", "manage_members", "manage_roles", "manage_menu", "manage_share",
      "create_library",
      "view_directory", "invite_users", "create_users", "disable_users", "delete_users",
      "create_roles", "edit_roles", "delete_roles", "assign_role_members",
      "create_departments", "edit_departments", "delete_departments",
    ]);
    expect([...ORG_ACTIONS].sort()).toEqual([
      "assign_role_members", "create_departments", "create_library", "create_roles", "create_users",
      "delete_departments", "delete_roles", "delete_users", "disable_users", "edit_departments",
      "edit_roles", "invite_users", "manage_departments", "manage_members", "manage_menu",
      "manage_roles", "manage_share", "view_directory",
    ]);
  });

  it.each([...ORG_ACTIONS])("requireOrgAction(%s) 构造不抛未知动作", (action) => {
    expect(() => requireOrgAction(action)).not.toThrow();
  });

  it("requireOrgAction(非法动作) 同步抛错（接线期暴露，不静默放行）", () => {
    expect(() => requireOrgAction("drop_table" as never)).toThrow(/未知组织管理动作/);
  });
});

describe("全量 deploy 后 owner 的权限位", () => {
  it("role_owner permissions 恰为十八动作固定串（迁移 19 + 20 + owner_create_library + directory_actions 链 + 权限核心模型追加）", () => {
    const owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(EIGHTEEN);
  });
});

describe("owner_manage_share 只增迁移", () => {
  it("四动作基线补到 FIVE；自定义空动作/四动作角色不被迁移改写", async () => {
    await h.prisma.role.create({
      data: { id: "role_ms_empty", workspaceId: "ws_default", systemKey: null, name: "空角色2", description: "", isSystem: 0, permissions: "[]" },
    });
    await h.prisma.role.create({
      data: { id: "role_ms_four", workspaceId: "ws_default", systemKey: null, name: "自定义四动作", description: "", isSystem: 0, permissions: FOUR },
    });
    setOwner(raw, FOUR);
    raw.exec(migrationSql);
    expect((raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string }).permissions).toBe(FIVE);
    expect((raw.prepare("SELECT permissions FROM roles WHERE id='role_ms_empty'").get() as { permissions: string }).permissions).toBe("[]");
    // 自定义角色即便恰为四动作串，也因 id 固定 role_owner 而不被触碰。
    expect((raw.prepare("SELECT permissions FROM roles WHERE id='role_ms_four'").get() as { permissions: string }).permissions).toBe(FOUR);
  });

  it("迁移 SQL 连跑两次幂等：FOUR -> FIVE，再跑恒 FIVE", () => {
    setOwner(raw, FOUR);
    raw.exec(migrationSql);
    raw.exec(migrationSql);
    expect((raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string }).permissions).toBe(FIVE);
  });

  it("只改恰好四动作的 owner 行：THREE 行不被越级补位（须先过迁移 19），FIVE 行不被改写", () => {
    setOwner(raw, THREE);
    raw.exec(migrationSql);
    expect((raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string }).permissions).toBe(THREE);

    setOwner(raw, FIVE);
    raw.exec(migrationSql);
    expect((raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string }).permissions).toBe(FIVE);
  });
});
