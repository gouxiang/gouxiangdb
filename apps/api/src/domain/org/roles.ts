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
}

/**
 * 五枚系统角色单一真源（应用侧）。permissions/名称与迁移链逐字一致：
 * 20260915090000_enterprise_org_ddl 播三动作，20260916100000_owner_manage_menu
 * 只增补到四动作，20260916130000_owner_manage_share 只增补到五动作
 * （systemRolesMatchSeed 对拍测试跑在全量迁移后）。
 * owner actions 直接展开 ORG_ACTIONS 真源（不手维护本地字面量，加动作位时自动收窄）。
 * 仅 owner 持全部 manage_*，其余四枚为空（M4 资源角色命名锚点）。
 */
export const SYSTEM_ROLES: readonly SystemRoleSpec[] = [
  {
    id: "role_owner",
    systemKey: "owner",
    name: "所有者",
    description: "工作区所有者，承担组织管理面全部动作",
    actions: [...ORG_ACTIONS],
  },
  { id: "role_creator", systemKey: "creator", name: "创建者", description: "M4 资源角色命名锚点，M2 无组织管理动作", actions: [] },
  { id: "role_editor", systemKey: "editor", name: "编辑者", description: "M4 资源角色命名锚点，M2 无组织管理动作", actions: [] },
  { id: "role_commenter", systemKey: "commenter", name: "评论者", description: "M4 资源角色命名锚点，M2 无组织管理动作", actions: [] },
  { id: "role_viewer", systemKey: "viewer", name: "阅读者", description: "M4 资源角色命名锚点，M2 无组织管理动作", actions: [] },
];

export const SYSTEM_ROLE_BY_ID = new Map(SYSTEM_ROLES.map((r) => [r.id, r]));

/** owner 系统角色 id 锚点（写后守卫等处复用，避免散落裸字符串 "role_owner"）。 */
export const OWNER_ROLE_ID = SYSTEM_ROLES[0].id;

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
