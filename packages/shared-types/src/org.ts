// packages/shared-types/src/org.ts
// M2 企业组织通讯录 /api/v1/org/* 前后端契约（唯一真源；只增不改既有导出）。
//
// 边界（M2 计划 §5-A / 派工）：
//   - M2 锁定三枚组织管理动作；M3-S6 只增第四枚 manage_menu（导航菜单编排）；
//     M4-S5 只增第五枚 manage_share（授权策略/分享管理）；
//     M6 只增第六枚 create_library（建库/建知识库的权限门）；
//     企业化定位追加第七至十一枚——通讯录五件套：view_directory / invite_users /
//     create_users / disable_users / delete_users，把原先「manage_members 一把梭」的
//     成员管理面拆成可按角色分别勾选的细粒度动词，使「只能看不能动」「只能邀请不能删」
//     这类企业口径第一次可表达（此前只有「有 manage_members」与「没有 manage_members」
//     两种状态，看权限等于能改权限）。
//   - view_directory 是读动作、其余四枚（invite_users/create_users/disable_users/delete_users）
//     是写动作：写动作不含读，需要「只看不改」时必须单独勾 view_directory。
//   - 资源动作 r/c/u/d/comment/manage_share（资源空间，见 authz.ts RESOURCE_ACTIONS）一律不与
//     本 OrgAction 混用：组织空间的 manage_share 是独立第五枚，二者同名不同命名空间。
//   - create_library 是能力门而非管理面动作：持有它才允许新建 Base / 知识库。默认仅
//     role_owner 持全部动作，其余角色由管理员在后台勾选授予（按角色，不按人）。
//   - 成功响应沿用现网：资源本体 / 分页对象 {items,total,page,limit,hasMore}；错误 {error,code}。

/**
 * 组织管理动作（M3-S6 起四枚，M4-S5 起五枚，M6 起六枚，企业化定位起十一枚；
 * 只增不改既有成员顺序语义——末尾追加，历史 migrations 的 JSON 串按此顺序定序）。
 */
export type OrgAction =
  | "manage_departments"
  | "manage_members"
  | "manage_roles"
  | "manage_menu"
  | "manage_share"
  | "create_library"
  | "view_directory"
  | "invite_users"
  | "create_users"
  | "disable_users"
  | "delete_users";

export const ORG_ACTIONS: readonly OrgAction[] = [
  "manage_departments",
  "manage_members",
  "manage_roles",
  "manage_menu",
  "manage_share",
  "create_library",
  "view_directory",
  "invite_users",
  "create_users",
  "disable_users",
  "delete_users",
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
