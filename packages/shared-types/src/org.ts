// packages/shared-types/src/org.ts
// M2 企业组织通讯录 /api/v1/org/* 前后端契约（唯一真源；只增不改既有导出）。
//
// 边界（M2 计划 §5-A / 派工）：
//   - 组织管理动作本期锁定三枚；manage_menu 属 M3，本期【不加入】联合（留只增空间）。
//   - 资源动作 r/c/u/d/comment 一律不进 OrgAction（资源权限仍走 members.role + permissions.ts）。
//   - 成功响应沿用现网：资源本体 / 分页对象 {items,total,page,limit,hasMore}；错误 {error,code}。

/** 组织管理动作（M2 三枚；M3 会只增 manage_menu，勿提前加）。 */
export type OrgAction = "manage_departments" | "manage_members" | "manage_roles";

export const ORG_ACTIONS: readonly OrgAction[] = [
  "manage_departments",
  "manage_members",
  "manage_roles",
];

/** 五枚系统组织角色 key（自定义角色 systemKey=null）。 */
export type SystemRoleKey = "owner" | "creator" | "editor" | "commenter" | "viewer";

/** 系统角色固定展示顺序（owner 在前，其余按创建者/编辑者/评论者/阅读者）。 */
export const SYSTEM_ROLE_ORDER: readonly SystemRoleKey[] = [
  "owner",
  "creator",
  "editor",
  "commenter",
  "viewer",
];

export type UserAccountStatus = "INVITED" | "ACTIVE" | "DISABLED";
export type AssignmentSubjectType = "user" | "dept";
/** M2 作用域恒为 workspace；node 为 M3+ 预留，M2 端点收到 nodeId 一律 400。 */
export type RoleScopeType = "workspace";

// ============ 部门 ============

export interface DeptDTO {
  id: string;
  workspaceId: string;
  parentId: string | null;
  /** 物化路径："/<id>/.../"，根="/<id>/"。 */
  path: string;
  name: string;
  ord: number;
  status: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string | null;
}

// ============ 角色 ============

export interface OrgRoleDTO {
  id: string;
  workspaceId: string;
  systemKey: SystemRoleKey | null;
  name: string;
  description: string;
  isSystem: boolean;
  actions: OrgAction[];
  createdAt: string;
  deletedAt: string | null;
}

export interface RoleAssignmentDTO {
  id: string;
  roleId: string;
  subjectType: AssignmentSubjectType;
  subjectId: string;
  scopeType: RoleScopeType;
  scopeNodeId: null;
  createdAt: string;
  createdBy: string | null;
}

/** PUT /roles/:id/assignments 的批量主体集条目。 */
export interface AssignmentSubjectInput {
  subjectType: AssignmentSubjectType;
  subjectId: string;
}

// ============ 成员 ============

export interface DeptMembershipDTO {
  departmentId: string;
  isMain: boolean;
  joinedAt: string;
}

export interface MemberRoleSummaryDTO {
  roleId: string;
  systemKey: SystemRoleKey | null;
  name: string;
}

export interface OrgMemberDTO {
  id: string;
  email: string;
  displayName: string;
  status: UserAccountStatus;
  avatarUrl: string | null;
  invitedAt: string | null;
  createdAt: string;
  deptMemberships: DeptMembershipDTO[];
  directRoles: MemberRoleSummaryDTO[];
}

export interface PaginatedMembers {
  items: OrgMemberDTO[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// ============ 有效组织角色求值 ============

/** 一条角色来源：直接授予用户，或经某（祖先）部门授予。name 为部门名（dept 来源时）。 */
export interface EffectiveRoleSource {
  type: AssignmentSubjectType;
  id: string;
  name?: string;
}

/**
 * 有效组织角色 = 直接授予 ∪ 用户各活部门祖先闭包上的 dept 授予（去重并合并来源）。
 * 供 M2 展示与 M4 subjectType=role 展开；求值为定数查询，不随部门层数/兼岗数 N+1。
 */
export interface EffectiveRoleDTO {
  roleId: string;
  systemKey: SystemRoleKey | null;
  name: string;
  isSystem: boolean;
  actions: OrgAction[];
  sources: EffectiveRoleSource[];
}

export interface EffectiveRolesResponse {
  userId: string;
  roles: EffectiveRoleDTO[];
}
