// apps/web/src/lib/role-policy.ts
// 角色口径单一真源：通讯录（features/contacts）与权限管理（features/settings/role-permission）
// 必须显示同一批角色、用同一把尺子判「能不能改 / 能不能删」。
//
// 背景（本次修的 bug）：两边原先各写一套判据——
//   通讯录   RoleManager：systemKey ∈ {super_admin, owner} ∪ 非系统角色（按 r.isSystem 判）
//   权限管理 RoleListPanel：systemKey ∈ {super_admin, admin, restricted, owner} ∪ 非系统角色
// 于是「管理员」「受限成员」在权限管理里能配，在通讯录里却凭空消失——同一个组织两套角色表。
//
// 统一后的口径（后端 domain/org/roles.ts 的 SYSTEM_ROLES 是同一事实的另一面）：
//   ① 显不显示：组织层角色 = 四枚组织预设（super_admin / admin / restricted / owner 旧值）
//      ∪ 全部自定义角色。creator/editor/commenter/viewer 是资源授权策略（auth_policies）的
//      合法主体名，组织层零动作，只在 UI 过滤掉——从库里挖会让既有策略变成悬挂主体。
//   ② 能不能改删：只认 immutable。绝不按 isSystem 判——管理员与受限成员 isSystem=1 但
//      immutable=0，后端允许改允许删；按 isSystem 判会把它们误锁成「不可编辑」。

import type { OrgRoleDTO } from "@gx/shared-types";
import type { IconName } from "../components/icons";

/** 组织层要展示的系统预设角色的 systemKey。'owner' 是超级管理员的旧值，存量库仍可能挂着。 */
export const ORG_PRESET_ROLE_KEYS: ReadonlySet<NonNullable<OrgRoleDTO["systemKey"]>> = new Set([
  "super_admin",
  "admin",
  "restricted",
  "owner",
]);

/** 系统预设角色（含旧值 owner）。 */
export function isPresetOrgRole(r: OrgRoleDTO): boolean {
  return !!r.systemKey && ORG_PRESET_ROLE_KEYS.has(r.systemKey);
}

/** 自定义角色：没有 systemKey。 */
export function isCustomOrgRole(r: OrgRoleDTO): boolean {
  return !r.systemKey;
}

/** 组织层可见角色 = 组织预设 ∪ 自定义。两边界面都只显示这一批。 */
export function isOrgVisibleRole(r: OrgRoleDTO): boolean {
  return isPresetOrgRole(r) || isCustomOrgRole(r);
}

/** 不可编辑、不可删除：与后端 roles.immutable 同源，不看 isSystem。 */
export function isLockedOrgRole(r: OrgRoleDTO): boolean {
  return r.immutable;
}

/**
 * 「管理员级」系统角色：超级管理员 / 管理员（以及旧值 owner）。
 * 这是**特权**判据，与「组织层可见」是两把不同的尺子——工作区门控（谁能进设置分区、
 * 谁能建库）用它；角色列表显示用 isOrgVisibleRole。别混。
 * 入参只吃 systemKey：`myEffectiveRoles` 返回的是 MemberRoleSummaryDTO，没有 immutable/isSystem。
 */
export function isAdminLevelSystemKey(systemKey: OrgRoleDTO["systemKey"]): boolean {
  return systemKey === "super_admin" || systemKey === "admin" || systemKey === "owner";
}

/** 角色图标：三枚组织预设各有辨识度，自定义角色统一用盾牌。 */
export function roleIconName(r: OrgRoleDTO): IconName {
  if (r.systemKey === "super_admin" || r.systemKey === "owner") return "crown";
  if (r.systemKey === "restricted") return "userSlash";
  if (r.systemKey === "admin") return "shield";
  return "shield";
}

/** 不可编辑 / 不可删除的原因（界面文案同源，不各写一份）。 */
export const LOCKED_ROLE_REASON =
  "超级管理员是系统内置角色，不能改名字和权限，也不能删除——否则可能被摘掉权限位，把真正的管理员锁在系统外面。";
