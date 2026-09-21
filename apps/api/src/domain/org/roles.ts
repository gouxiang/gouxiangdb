// M2/S5 组织角色：系统角色常量（与迁移种子单一真源，对拍测试）、有效角色求值导出名、
// usersWithRole 反向展开（最后 owner 保护 S6 用）。角色 CRUD/授予事务在 roleAdmin.ts（守行数）。

import type { OrgAction, SystemRoleKey } from "@gx/shared-types";
import { ORG_ACTIONS } from "@gx/shared-types";
import { prisma, type DbTx } from "../../db.js";
import { effectiveRoleRows } from "./authorization.js";

export { effectiveRoleRows };
// 派工/计划接口名：effectiveOrgRoles 即去重合并来源后的有效角色集。
export const effectiveOrgRoles = effectiveRoleRows;

/** 白名单守卫：非 ORG_ACTIONS 内的组织动作拒绝（自定义角色 actions 校验；真源在 shared-types）。 */
export function assertOrgActions(actions: readonly unknown[]): OrgAction[] {
  const out = actions.filter((a): a is OrgAction => typeof a === "string"
    && (ORG_ACTIONS as readonly string[]).includes(a));
  if (out.length !== actions.length) {
    throw new Error("存在非法组织管理动作");
  }
  return [...new Set(out)];
}

export interface SystemRoleSpec {
  id: string;
  systemKey: SystemRoleKey;
  name: string;
  description: string;
  actions: OrgAction[];
  /** 不可编辑 / 不可删除（roles.immutable）。 */
  immutable: boolean;
}

/**
 * 系统角色单一真源（应用侧）。permissions/名称/immutable 与迁移链逐字一致：
 * 20260915090000_enterprise_org_ddl 播三动作，20260916100000_owner_manage_menu 只增补到四动作，
 * 20260916130000_owner_manage_share 只增补到五动作，20260919110000_owner_create_library 只增补到六动作，
 * 20260920220000_org_directory_actions 补到十一枚，20260921010000_role_core_models 升十一枚中的
 * role_owner 为「超级管理员」并新增「管理员」「受限成员」两枚预设（systemRolesMatchSeed 对拍测试
 * 跑在全量迁移后）。
 *
 * 命名取舍：超级管理员的行 id 沿用 'role_owner'——既有 role_assignments / auth_policies 都以硬 id
 * 指向它，改 id 等于让所有现存管理员在一次发布里失去全部角色。systemKey 与展示名已改为
 * super_admin / 超级管理员，行 id 只是稳定的物理锚点（OWNER_ROLE_ID 保留为同义旧名，勿再新增引用）。
 *
 * owner / admin / restricted 的 actions 直接展开 ORG_ACTIONS 真源（不手维护本地字面量，
 * 加动作位时自动收窄）；后四枚资源锚点角色仍为空数组。
 */
export const SYSTEM_ROLES: readonly SystemRoleSpec[] = [
  {
    id: "role_owner",
    systemKey: "super_admin",
    name: "超级管理员",
    description: "系统最高权限角色：可见并管理全部库、可建库、可删库、可开关分享；本身不可编辑、不可删除",
    actions: [...ORG_ACTIONS],
    immutable: true,
  },
  {
    id: "role_admin",
    systemKey: "admin",
    name: "管理员",
    description: "系统预置：通讯录与建库能力同超级管理员，但不参与「最后一位超级管理员」保护，可被删除",
    actions: [...ORG_ACTIONS],
    immutable: false,
  },
  {
    id: "role_restricted",
    systemKey: "restricted",
    name: "受限成员",
    description: "系统预置：无通讯录权限、无任何库权限，仅可修改自己的个人信息；新建用户未指定角色时的默认值",
    actions: [],
    immutable: false,
  },
  { id: "role_creator", systemKey: "creator", name: "创建者", description: "M4 资源角色命名锚点，无组织管理动作", actions: [], immutable: true },
  { id: "role_editor", systemKey: "editor", name: "编辑者", description: "M4 资源角色命名锚点，无组织管理动作", actions: [], immutable: true },
  { id: "role_commenter", systemKey: "commenter", name: "评论者", description: "M4 资源角色命名锚点，无组织管理动作", actions: [], immutable: true },
  { id: "role_viewer", systemKey: "viewer", name: "阅读者", description: "M4 资源角色命名锚点，无组织管理动作", actions: [], immutable: true },
];

export const SYSTEM_ROLE_BY_ID = new Map(SYSTEM_ROLES.map((r) => [r.id, r]));

/**
 * 角色 id 锚点三连。OWNER_ROLE_ID 是超级管理员的旧名（等于 SUPER_ADMIN_ROLE_ID），
 * 保留仅为不改动既有调用点；新代码一律用 SUPER_ADMIN_ROLE_ID。
 */
export const SUPER_ADMIN_ROLE_ID = "role_owner";
export const ADMIN_ROLE_ID = "role_admin";
export const RESTRICTED_ROLE_ID = "role_restricted";
export const OWNER_ROLE_ID = SUPER_ADMIN_ROLE_ID;

/** 角色列表固定序：三枚权限预设在前，其后为 M4 资源名锚点，最后是自定义角色。 */
export const SYSTEM_ROLE_ID_ORDER: readonly string[] = SYSTEM_ROLES.map((r) => r.id);

export function isSystemRoleId(id: string): boolean {
  return SYSTEM_ROLE_BY_ID.has(id);
}

type Client = DbTx | typeof prisma;

/**
 * 反向展开：当前对某角色"有效"的全部 ACTIVE 用户 id（去重）。
 *   直接：role_assignments subjectType=user；
 *   部门：subjectType=dept 的授予部门 -> 其【子树】全体活部门 -> 成员（祖先授予荫及子树，
 *   与 effectiveRoleRows 的 path 祖先闭包方向互逆）。
 * 常量查询（3 次，与部门层数/兼岗数无关）：授予行 -> 子树部门 -> 成员。
 * 只计 ACTIVE（INVITED 未入职、DISABLED 已停用，均不构成在岗 owner）。
 */
export async function usersWithRole(roleId: string, client: Client = prisma): Promise<string[]> {
  const grants = await client.roleAssignment.findMany({
    where: { roleId },
    select: { subjectType: true, subjectId: true },
  });
  const directUsers: string[] = [];
  const grantedDeptIds: string[] = [];
  for (const g of grants) {
    if (g.subjectType === "user") directUsers.push(g.subjectId);
    else if (g.subjectType === "dept") grantedDeptIds.push(g.subjectId);
  }

  let subtreeDeptIds: string[] = [];
  if (grantedDeptIds.length) {
    // 取授予部门的 path（活部门），再以 path 前缀展开整棵子树。
    const granted = await client.department.findMany({
      where: { id: { in: grantedDeptIds }, deletedAt: null },
      select: { path: true },
    });
    if (granted.length) {
      const subtree = await client.department.findMany({
        where: { deletedAt: null, OR: granted.map((g) => ({ path: { startsWith: g.path } })) },
        select: { id: true },
      });
      subtreeDeptIds = subtree.map((d) => d.id);
    }
  }

  const userIds = new Set(directUsers);
  if (subtreeDeptIds.length) {
    const members = await client.deptMember.findMany({
      where: { departmentId: { in: subtreeDeptIds } },
      select: { userId: true },
    });
    for (const m of members) userIds.add(m.userId);
  }

  // 过滤为 ACTIVE（直接授予里可能含停用/待激活，不应算作在岗角色持有者）。
  if (userIds.size === 0) return [];
  const active = await client.user.findMany({
    where: { id: { in: [...userIds] }, status: "ACTIVE" },
    select: { id: true },
  });
  return active.map((u) => u.id);
}
