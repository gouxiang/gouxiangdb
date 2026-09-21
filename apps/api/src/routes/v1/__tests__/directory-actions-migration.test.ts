// 迁移 20260920220000_org_directory_actions 的只增/幂等/回滚验证（真迁移库 + 直接跑 SQL 片段）。
//
// 为什么单独锁它：这是整套改造里唯一跑一次就不可逆的环节。此前的血泪是 owner 被自己的权限门
// 锁住——只改 shared-types 而没把 permissions 列补进去的话，role_owner 在运行期拿不到任何一枚
// 新动作，而新守卫一上线就把 owner 本人挡在通讯录门外。手法与 20260919110000_owner_create_library
// 修过的 owner 建库门完全一致，所以这次连迁移本身一起钉住。
//
// 用 better-sqlite3 直接跑 SQL 而不再走一次 prisma migrate deploy：要在同一个已迁移库上
// 反复执行同一段脚本来验证幂等，并且要把列的值先改回旧串来模拟「迁移动手前的现场」。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ORG_ACTIONS } from "@gx/shared-types";
import { setupOrgHarness, type OrgHarness } from "../org/__tests__/orgHarness.js";

let h: OrgHarness;
let raw: Database.Database;

const SIX = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library"]';
const ELEVEN = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share","create_library","view_directory","invite_users","create_users","disable_users","delete_users"]';
const FIVE_NEW = ["view_directory", "invite_users", "create_users", "disable_users", "delete_users"];

const MIGRATION = "prisma/migrations/20260920220000_org_directory_actions/migration.sql";
const ROLLBACK = "prisma/docs/rollback/20260920220000_org_directory_actions.down.sql";

const migrationSql = fs.readFileSync(path.resolve(MIGRATION), "utf8");
const rollbackSql = fs.readFileSync(path.resolve(ROLLBACK), "utf8");

function perms(roleId: string): string {
  return (raw.prepare("SELECT permissions FROM roles WHERE id=?").get(roleId) as { permissions: string }).permissions;
}
function setPerms(roleId: string, permissions: string): void {
  raw.prepare("UPDATE roles SET permissions=? WHERE id=?").run(permissions, roleId);
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

describe("① 有 manage_members 的角色：补满五枚，原能力面不缩水", () => {
  it("owner 从六动作补到十一动作，且顺序与 ORG_ACTIONS 前十一枚一致", () => {
    setPerms("role_owner", SIX);
    raw.exec(migrationSql);
    expect(perms("role_owner")).toBe(ELEVEN);
    // 本迁移只负责通讯录五件套；ORG_ACTIONS 里后续的七枚（权限核心模型追加）由
    // 20260921010000_role_core_models 补，不归这段脚本管，故只比对前十一枚。
    expect(JSON.parse(perms("role_owner"))).toEqual([...ORG_ACTIONS].slice(0, 11));
  });

  it("只勾了 manage_members 的旧自定义角色同样补满五枚", async () => {
    await h.prisma.role.create({
      data: {
        id: "role_da_member_mgr",
        workspaceId: "ws_default",
        systemKey: null,
        name: "迁移前的成员管理员",
        description: "",
        isSystem: 0,
        permissions: '["manage_members"]',
      },
    });
    raw.exec(migrationSql);
    expect(JSON.parse(perms("role_da_member_mgr"))).toEqual(["manage_members", ...FIVE_NEW]);
  });
});

describe("② 无 manage_members 的角色：只补 view_directory", () => {
  it("四枚资源锚点系统角色从空串变成只含读基线", () => {
    for (const id of ["role_creator", "role_editor", "role_commenter", "role_viewer"]) {
      setPerms(id, "[]");
    }
    raw.exec(migrationSql);
    for (const id of ["role_creator", "role_editor", "role_commenter", "role_viewer"]) {
      expect(perms(id), id).toBe('["view_directory"]');
    }
  });

  it("只读型自定义角色同样只补读权限，不被派发写动作", async () => {
    await h.prisma.role.create({
      data: {
        id: "role_da_readonly",
        workspaceId: "ws_default",
        systemKey: null,
        name: "只读角色",
        description: "",
        isSystem: 0,
        permissions: '["create_library"]',
      },
    });
    raw.exec(migrationSql);
    expect(JSON.parse(perms("role_da_readonly"))).toEqual(["create_library", "view_directory"]);
  });
});

describe("③ 幂等：连跑多次不产生重复动作位", () => {
  it("脚本连跑三次结果恒等（json_insert 无去重，靠 WHERE 挡住）", () => {
    setPerms("role_owner", SIX);
    for (const id of ["role_creator", "role_editor", "role_commenter", "role_viewer"]) {
      setPerms(id, "[]");
    }
    raw.exec(migrationSql);
    raw.exec(migrationSql);
    raw.exec(migrationSql);
    expect(perms("role_owner")).toBe(ELEVEN);
    for (const id of ["role_creator", "role_editor", "role_commenter", "role_viewer"]) {
      expect(perms(id), id).toBe('["view_directory"]');
    }
    // 重复项是 json_insert 最容易犯的错：一旦出现，hasOrgAction 仍能过，但 UI 会画出两个同名勾选框。
    for (const row of raw.prepare("SELECT id, permissions FROM roles").all() as Array<{ id: string; permissions: string }>) {
      const arr = JSON.parse(row.permissions) as string[];
      expect(new Set(arr).size, row.id).toBe(arr.length);
    }
  });
});

describe("④ 回滚脚本恢复到迁移前形态", () => {
  it("owner 回到六动作；四枚锚点角色回到空串", () => {
    setPerms("role_owner", SIX);
    for (const id of ["role_creator", "role_editor", "role_commenter", "role_viewer"]) {
      setPerms(id, "[]");
    }
    raw.exec(migrationSql);
    raw.exec(rollbackSql);
    expect(perms("role_owner")).toBe(SIX);
    for (const id of ["role_creator", "role_editor", "role_commenter", "role_viewer"]) {
      expect(perms(id), id).toBe("[]");
    }
  });
});
