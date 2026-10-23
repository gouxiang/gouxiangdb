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

/**
 * 「仅超级管理员本人」判据（#1046c）：比 {@link isAdminLevelSystemKey} 更严——
 * 管理员（admin）与超级管理员权限位完全相同，能授予 admin 就等于能封 super_admin，
 * 故管理员/超管这两枚角色的【授予主体】只允许超级管理员本人调整。'owner' 是超级管理员
 * 的旧 systemKey，存量库仍可能挂着，一并认作超管；admin 明确【不算】。
 */
export function isSuperAdminSystemKey(systemKey: OrgRoleDTO["systemKey"]): boolean {
  return systemKey === "super_admin" || systemKey === "owner";
}

/**
 * 当前登录者能否维护某角色的授予主体（添加/移除成员、部门）——#1046c 前端镜像门控。
 * 与后端 PUT /org/roles/:id/assignments 的 assertCanAssignPrivilegedRole 同一裁决：
 *   - 先要有 assign_role_members 动作位；
 *   - 目标角色是管理员级（super_admin/admin/旧 owner）时，还必须本人是超级管理员；
 *   - 其余角色维持仅看动作位。
 * 纯函数（不碰 React/query），便于表驱动单测。
 */
export function canManageRoleAssignments(input: {
  hasAssignAction: boolean;
  isSuperAdmin: boolean;
  systemKey: OrgRoleDTO["systemKey"];
}): boolean {
  if (!input.hasAssignAction) return false;
  if (isAdminLevelSystemKey(input.systemKey)) return input.isSuperAdmin;
  return true;
}

/** 非超级管理员维护管理员级角色授予时的禁用说明（与后端 403 文案口径一致）。 */
export const ADMIN_LEVEL_ASSIGN_BLOCK_REASON =
  "管理员与超级管理员权限相同，只有超级管理员本人能调整这两个角色的成员——请联系超级管理员操作。";

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

// 「不能赋权」是第三把尺子，独立于上面两把：
//   immutable 只管「能不能改名字、能不能删」（管理员 / 受限成员 immutable=0，名字和说明照改）；
//   「能不能勾权限格」看的是角色本身的系统语义——预设席位的权限集合由系统写死，不给配。
const ADMIN_GRANT_BLOCK_REASON =
  "管理员与超级管理员同权：天然能进全部库、管全部库，也能管通讯录和角色。这套权限是系统写死的，不需要配、也不能摘掉其中任何一项。";
const RESTRICTED_GRANT_BLOCK_REASON =
  "受限成员是系统预设的最低权限角色：只看得到显式分享给它的内容，不参与赋权。要给它权限请新建一个自定义角色，再把成员放进去。";

/** 超级管理员在「库权限」段的专属说明，比通用文案多一句「唯一能删库」——别用上面的通用文案覆盖它。 */
export const SUPER_ADMIN_LIBRARY_GRANT_REASON =
  "超级管理员不用配库权限：它天然能进全部库、管全部库，也是唯一能删库的角色。";

/**
 * 这个角色为什么不能被赋权（通讯录权限 / 库权限 两段共用的判据）。返回 null 表示可以赋权。
 * 档位顺序不能调换：owner 是超级管理员的旧 systemKey 且 immutable=1，必须落在第一档，
 * 不能被后面的 admin 分支认领走。
 */
export function roleGrantBlockReason(r: OrgRoleDTO): string | null {
  if (isLockedOrgRole(r)) return LOCKED_ROLE_REASON;
  if (r.systemKey === "admin") return ADMIN_GRANT_BLOCK_REASON;
  if (r.systemKey === "restricted") return RESTRICTED_GRANT_BLOCK_REASON;
  return null;
}

/** 库权限段的版本：仅超级管理员换成更具体的那句（保留「唯一能删库」），其余同 {@link roleGrantBlockReason}。 */
export function roleLibraryGrantBlockReason(r: OrgRoleDTO): string | null {
  if (isLockedOrgRole(r)) return SUPER_ADMIN_LIBRARY_GRANT_REASON;
  return roleGrantBlockReason(r);
}
