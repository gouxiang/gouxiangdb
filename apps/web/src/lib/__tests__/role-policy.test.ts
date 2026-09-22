// apps/web/src/lib/__tests__/role-policy.test.ts
// 锁死「通讯录与权限管理同源」：两边此前各写一份角色判据，管理员 / 受限成员在权限管理里
// 能配、在通讯录里却消失。这组用例把统一口径钉住，谁再拆回两套就会红。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OrgRoleDTO } from "@gx/shared-types";
import {
  isCustomOrgRole,
  isLockedOrgRole,
  isOrgVisibleRole,
  isPresetOrgRole,
} from "../role-policy";

function role(p: Partial<OrgRoleDTO> & { id: string }): OrgRoleDTO {
  return {
    workspaceId: "ws",
    systemKey: null,
    name: p.id,
    description: "",
    isSystem: false,
    immutable: false,
    actions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...p,
  };
}

// 后端 domain/org/roles.ts SYSTEM_ROLES 的镜像（含迁移落库后的真实取值）
const superAdmin = role({ id: "role_owner", systemKey: "super_admin", isSystem: true, immutable: true });
const admin = role({ id: "role_admin", systemKey: "admin", isSystem: true, immutable: false });
const restricted = role({ id: "role_restricted", systemKey: "restricted", isSystem: true, immutable: false });
const legacyOwner = role({ id: "role_owner_legacy", systemKey: "owner", isSystem: true, immutable: true });
const creator = role({ id: "role_creator", systemKey: "creator", isSystem: true, immutable: true });
const editor = role({ id: "role_editor", systemKey: "editor", isSystem: true, immutable: true });
const commenter = role({ id: "role_commenter", systemKey: "commenter", isSystem: true, immutable: true });
const viewer = role({ id: "role_viewer", systemKey: "viewer", isSystem: true, immutable: true });
const custom = role({ id: "role_hr", systemKey: null, isSystem: false, immutable: false });

describe("isOrgVisibleRole", () => {
  it("四枚组织层系统预设都要显示（含旧值 owner）", () => {
    expect(isOrgVisibleRole(superAdmin)).toBe(true);
    expect(isOrgVisibleRole(admin)).toBe(true);
    expect(isOrgVisibleRole(restricted)).toBe(true);
    expect(isOrgVisibleRole(legacyOwner)).toBe(true);
  });

  // 回归：通讯录原来的判据是 `!r.isSystem`，管理员 / 受限成员 isSystem=1 会被它挡掉
  it("管理员与受限成员不被 isSystem 误挡（原通讯录口径的核心 bug）", () => {
    expect(admin.isSystem).toBe(true);
    expect(restricted.isSystem).toBe(true);
    expect(isOrgVisibleRole(admin)).toBe(true);
    expect(isOrgVisibleRole(restricted)).toBe(true);
  });

  it("自定义角色要显示", () => {
    expect(isOrgVisibleRole(custom)).toBe(true);
  });

  it("四枚资源锚点角色不显示（组织层零动作，只是策略主体名）", () => {
    for (const r of [creator, editor, commenter, viewer]) {
      expect(isOrgVisibleRole(r)).toBe(false);
    }
  });
});

describe("isPresetOrgRole / isCustomOrgRole", () => {
  it("预设与自定义互斥且覆盖全部可见角色", () => {
    const all = [superAdmin, admin, restricted, legacyOwner, creator, editor, commenter, viewer, custom];
    for (const r of all) {
      expect(isPresetOrgRole(r) && isCustomOrgRole(r)).toBe(false);
      if (isOrgVisibleRole(r)) {
        expect(isPresetOrgRole(r) || isCustomOrgRole(r)).toBe(true);
      }
    }
  });

  it("资源锚点是系统角色但不属于组织层预设", () => {
    expect(isPresetOrgRole(creator)).toBe(false);
    expect(isCustomOrgRole(creator)).toBe(false);
  });
});

// 光有同一份函数不够——必须确认两边真的都用了它。历史上就是「函数在那儿，但一边自己又写了一份」。
describe("通讯录与权限管理同源（源码级护栏）", () => {
  // 本文件在 src/lib/__tests__/ 下：上两级即 src/features/
  const dir = new URL("../../features/", import.meta.url).pathname;
  const contactsSrc = readFileSync(`${dir}contacts/RoleManager.tsx`, "utf8");
  const sectionSrc = readFileSync(`${dir}settings/role-permission/RolePermissionSection.tsx`, "utf8");
  const listSrc = readFileSync(`${dir}settings/role-permission/RoleListPanel.tsx`, "utf8");

  it("两边都从 lib/role-policy 取角色可见性判据", () => {
    for (const [who, src] of [
      ["通讯录 RoleManager", contactsSrc],
      ["权限管理 RolePermissionSection", sectionSrc],
    ] as const) {
      expect(src, `${who} 未引用 lib/role-policy`).toContain("lib/role-policy");
      expect(src, `${who} 未使用统一判据 isOrgVisibleRole`).toContain("isOrgVisibleRole");
    }
  });

  it("两边都不再自己写 systemKey 白名单或按 isSystem 过滤", () => {
    for (const src of [contactsSrc, sectionSrc, listSrc]) {
      expect(src).not.toContain("PRESET_KEYS");
      expect(src).not.toContain("isDirectoryVisibleRole");
      // isSystem 只应出现在类型/注释里；真实过滤一律走 immutable 与统一判据
      expect(src).not.toMatch(/filter\([^)]*isSystem/);
      expect(src).not.toMatch(/!r\.isSystem/);
    }
  });
});

describe("isLockedOrgRole", () => {
  it("只按 immutable 判，不按 isSystem 判", () => {
    expect(isLockedOrgRole(superAdmin)).toBe(true);
    expect(isLockedOrgRole(admin)).toBe(false);
    expect(isLockedOrgRole(restricted)).toBe(false);
    expect(isLockedOrgRole(custom)).toBe(false);
  });

  it("资源锚点 immutable=1 但它们根本不显示，不参与改删判定", () => {
    expect(isLockedOrgRole(creator)).toBe(true);
    expect(isOrgVisibleRole(creator)).toBe(false);
  });
});
