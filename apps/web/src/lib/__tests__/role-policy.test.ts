// apps/web/src/lib/__tests__/role-policy.test.ts
// 锁死「通讯录与权限管理同源」：两边此前各写一份角色判据，管理员 / 受限成员在权限管理里
// 能配、在通讯录里却消失。这组用例把统一口径钉住，谁再拆回两套就会红。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OrgRoleDTO } from "@gx/shared-types";
import {
  ADMIN_LEVEL_ASSIGN_BLOCK_REASON,
  LOCKED_ROLE_REASON,
  SUPER_ADMIN_LIBRARY_GRANT_REASON,
  canManageRoleAssignments,
  isCustomOrgRole,
  isLockedOrgRole,
  isOrgVisibleRole,
  isPresetOrgRole,
  isSuperAdminSystemKey,
  roleGrantBlockReason,
  roleLibraryGrantBlockReason,
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

// 「能不能赋权」是独立于 immutable 的第三把尺子：管理员 / 受限成员 immutable=0，名字照改，
// 但它们是系统预设席位，权限集合写死——不给勾任何一格的权限网格。
describe("roleGrantBlockReason（系统预设角色不给赋权）", () => {
  it("管理员不可赋权，且它不是自定义角色", () => {
    expect(isCustomOrgRole(admin)).toBe(false);
    expect(roleGrantBlockReason(admin)).toBeTruthy();
  });

  it("受限成员同样不可赋权，且它不是自定义角色", () => {
    expect(isCustomOrgRole(restricted)).toBe(false);
    expect(roleGrantBlockReason(restricted)).toBeTruthy();
  });

  it("超级管理员返回 LOCKED_ROLE_REASON", () => {
    expect(roleGrantBlockReason(superAdmin)).toBe(LOCKED_ROLE_REASON);
  });

  // owner 是超级管理员的旧 systemKey，必须落在第一档，不能被 admin 分支认领走
  it("旧值 owner 归入超级管理员那一档，不返回管理员档文案", () => {
    expect(roleGrantBlockReason(legacyOwner)).toBe(LOCKED_ROLE_REASON);
    expect(roleGrantBlockReason(legacyOwner)).not.toBe(roleGrantBlockReason(admin));
  });

  it("三档文案互不相同，各自说清楚自己的原因", () => {
    const reasons = [superAdmin, admin, restricted].map(roleGrantBlockReason);
    expect(new Set(reasons).size).toBe(3);
  });

  it("自定义角色返回 null —— 只有自定义角色能配权限", () => {
    expect(roleGrantBlockReason(custom)).toBeNull();
  });
});

describe("roleLibraryGrantBlockReason（库权限段）", () => {
  it("超级管理员保留专属文案（唯一能删库），不被通用文案覆盖", () => {
    expect(roleLibraryGrantBlockReason(superAdmin)).toBe(SUPER_ADMIN_LIBRARY_GRANT_REASON);
    expect(roleLibraryGrantBlockReason(superAdmin)).toContain("唯一能删库");
    expect(roleLibraryGrantBlockReason(legacyOwner)).toBe(SUPER_ADMIN_LIBRARY_GRANT_REASON);
  });

  it("其余角色与通用判据一致：管理员 / 受限成员仍不可赋权，自定义可赋权", () => {
    expect(roleLibraryGrantBlockReason(admin)).toBe(roleGrantBlockReason(admin));
    expect(roleLibraryGrantBlockReason(admin)).toBeTruthy();
    expect(roleLibraryGrantBlockReason(restricted)).toBe(roleGrantBlockReason(restricted));
    expect(roleLibraryGrantBlockReason(restricted)).toBeTruthy();
    expect(roleLibraryGrantBlockReason(custom)).toBeNull();
  });
});

// 同理：光有函数不够，两个配置块必须真的用它做降级判据，而不是退回裸的 isLockedOrgRole
// （那样管理员 / 受限成员又会变成能勾能存的开放口子）。
describe("权限管理两段配置都走赋权门控（源码级护栏）", () => {
  const dir = new URL("../../features/", import.meta.url).pathname;
  const src = readFileSync(`${dir}settings/role-permission/RolePermissionSection.tsx`, "utf8");
  // 每段截到自己 </PermBlock> 之前：第 0 段是通讯录权限，第 1 段是库权限
  const blocks = src.split("<PermBlock").slice(1).map((b) => b.split("</PermBlock>")[0]);

  it("两个 PermBlock 都不再用裸的 isLockedOrgRole 做降级判据", () => {
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block, "PermBlock 内不许出现 isLockedOrgRole").not.toContain("isLockedOrgRole");
    }
  });

  it("降级原因来自 role-policy 的赋权门控函数，不是组件里另算一套", () => {
    expect(src).toMatch(/const grantReason = [^\n;]*roleGrantBlockReason\(/);
    expect(src).toMatch(/const libraryGrantReason = [^\n;]*roleLibraryGrantBlockReason\(/);
    expect(blocks[0]).toContain("grantReason");
    expect(blocks[1]).toContain("libraryGrantReason");
  });

  it("超级管理员库权限专属文案收在 role-policy，组件里不重写一份", () => {
    expect(src).not.toContain("唯一能删库");
  });
});

describe("isSuperAdminSystemKey（#1046c 仅超管判据）", () => {
  it("super_admin 与旧值 owner 算超管；admin 明确不算", () => {
    expect(isSuperAdminSystemKey("super_admin")).toBe(true);
    expect(isSuperAdminSystemKey("owner")).toBe(true);
    expect(isSuperAdminSystemKey("admin")).toBe(false);
    expect(isSuperAdminSystemKey("restricted")).toBe(false);
    expect(isSuperAdminSystemKey(null)).toBe(false);
  });

  it("比 isAdminLevelSystemKey 更严：admin 落管理员级但非超管", () => {
    // 这条钉住两把尺子不能混用——封 admin/超管的身份门槛必须用仅超管判据。
    expect(isSuperAdminSystemKey("admin")).not.toBe(true);
  });
});

describe("canManageRoleAssignments（#1046c 授予主体门控）", () => {
  it("没有 assign_role_members 动作位：任何角色都不可维护", () => {
    expect(canManageRoleAssignments({ hasAssignAction: false, isSuperAdmin: true, systemKey: "super_admin" })).toBe(false);
    expect(canManageRoleAssignments({ hasAssignAction: false, isSuperAdmin: false, systemKey: null })).toBe(false);
  });

  it("管理员级角色：仅超级管理员本人可维护；admin 登录者（非超管）被拦", () => {
    for (const key of ["super_admin", "admin", "owner"] as const) {
      expect(canManageRoleAssignments({ hasAssignAction: true, isSuperAdmin: true, systemKey: key })).toBe(true);
      expect(canManageRoleAssignments({ hasAssignAction: true, isSuperAdmin: false, systemKey: key })).toBe(false);
    }
  });

  it("普通/自定义/受限角色：有动作位即可，非超管也能维护", () => {
    expect(canManageRoleAssignments({ hasAssignAction: true, isSuperAdmin: false, systemKey: null })).toBe(true);
    expect(canManageRoleAssignments({ hasAssignAction: true, isSuperAdmin: false, systemKey: "restricted" })).toBe(true);
    expect(canManageRoleAssignments({ hasAssignAction: true, isSuperAdmin: true, systemKey: null })).toBe(true);
  });

  it("禁用文案非空且点明只有超级管理员能操作", () => {
    expect(ADMIN_LEVEL_ASSIGN_BLOCK_REASON).toContain("超级管理员");
  });
});

// 光有纯判据不够：通讯录授予 UI 必须真的按它门控，而不是退回只看 assign_role_members
// 动作位（那样管理员又能封管理员/超管，点了才被后端 403 拦——假入口）。
describe("通讯录角色授予走 #1046c 门控（源码级护栏）", () => {
  const dir = new URL("../../features/", import.meta.url).pathname;
  const src = readFileSync(`${dir}contacts/RoleManager.tsx`, "utf8");
  const directorySrc = readFileSync(`${dir}contacts/ContactsDirectory.tsx`, "utf8");

  it("RoleManager 用 canManageRoleAssignments 计算当前角色能否维护授予，且喂入 isSuperAdmin", () => {
    expect(src).toMatch(/canManageRoleAssignments\(\{/);
    expect(src).toMatch(/isSuperAdmin,?\s*\n?\s*systemKey:/);
    // 不能退回只把动作位透传给授予编辑器。
    expect(src).toContain("ADMIN_LEVEL_ASSIGN_BLOCK_REASON");
  });

  it("ContactsDirectory 把登录者 isSuperAdmin 透传给 RoleManager", () => {
    expect(directorySrc).toMatch(/isSuperAdmin,?\s*isLoading/);
    expect(directorySrc).toContain("isSuperAdmin={isSuperAdmin}");
  });
});
