// M3/S6 manage_menu 第四动作位：白名单 + owner 迁移 19 幂等测试。
//
// 本文件只验证迁移 20260916100000_owner_manage_menu 本身：每个用例先把 role_owner
// 手工置回该迁移的三动作基线，再跑迁移 19 SQL，因此不依赖"全量 deploy 后 owner 是几枚"
// （M4-S5 第 20 迁移之后全量 deploy owner 已为五动作，由 manage-share-action.test.ts 覆盖）。
//
// - manage_menu 经 requireOrgAction 构造不抛"未知组织管理动作"；非法动作必须同步抛。
// - 迁移 19 连跑恒等（THREE -> FOUR，再跑不改写）；非 owner 行不触碰；FOUR/FIVE 行不降级。

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
const migrationSql = fs.readFileSync(
  path.resolve("prisma/migrations/20260916100000_owner_manage_menu/migration.sql"),
  "utf8",
);

function resetOwnerToThree(db: Database.Database): void {
  db.prepare(`UPDATE roles SET permissions='${THREE}' WHERE id='role_owner'`).run();
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

describe("组织管理动作白名单（manage_menu 仍在枚举内）", () => {
  it("ORG_ACTIONS 含 manage_menu（M3-S6 第四枚；M4-S5 加 manage_share 后仍保留）", () => {
    expect(ORG_ACTIONS).toContain("manage_menu");
  });

  it.each([...ORG_ACTIONS])("requireOrgAction(%s) 构造不抛未知动作", (action) => {
    expect(() => requireOrgAction(action)).not.toThrow();
  });

  it("requireOrgAction(非法动作) 同步抛错（接线期暴露，不静默放行）", () => {
    expect(() => requireOrgAction("drop_table" as never)).toThrow(/未知组织管理动作/);
  });
});

describe("owner_manage_menu 只增迁移（自三动作基线）", () => {
  it("三动作基线补到 FOUR；自定义空动作角色不被迁移改写", async () => {
    await h.prisma.role.create({
      data: { id: "role_c_empty", workspaceId: "ws_default", systemKey: null, name: "空角色", description: "", isSystem: 0, permissions: "[]" },
    });
    resetOwnerToThree(raw);
    raw.exec(migrationSql);
    const owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FOUR);
    const empty = raw.prepare("SELECT permissions FROM roles WHERE id='role_c_empty'").get() as { permissions: string };
    expect(empty.permissions).toBe("[]");
  });

  it("迁移 SQL 连跑两次幂等：THREE -> FOUR，再跑恒 FOUR，空角色仍 []", () => {
    resetOwnerToThree(raw);
    raw.exec(migrationSql);
    raw.exec(migrationSql);
    const owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FOUR);
    const empty = raw.prepare("SELECT permissions FROM roles WHERE id='role_c_empty'").get() as { permissions: string };
    expect(empty.permissions).toBe("[]");
  });

  it("只改恰好三动作的 owner 行：已是 FOUR/FIVE 的行不被迁移 19 降级或触碰", () => {
    // FOUR 行（迁移 19 目标态）：WHERE 不匹配，原样保留。
    resetOwnerToThree(raw);
    raw.exec(migrationSql);
    raw.exec(migrationSql);
    let owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FOUR);

    // 模拟 M4-S5 后 owner 已是 FIVE：迁移 19 不得把它改回 FOUR。
    const FIVE = '["manage_departments","manage_members","manage_roles","manage_menu","manage_share"]';
    raw.prepare(`UPDATE roles SET permissions='${FIVE}' WHERE id='role_owner'`).run();
    raw.exec(migrationSql);
    owner = raw.prepare("SELECT permissions FROM roles WHERE id='role_owner'").get() as { permissions: string };
    expect(owner.permissions).toBe(FIVE);
  });
});
