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
//   - 权限核心模型重构（本次，迁移 20260921010000）：追加 role_manage 三枚、部门三枚、
//     角色成员授予一枚，共十八枚。通讯录勾选面板的可勾项见下方 ORG_DIRECTORY_ACTIONS。
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
  | "delete_users"
  | "create_roles"
  | "edit_roles"
  | "delete_roles"
  | "assign_role_members"
  | "create_departments"
  | "edit_departments"
  | "delete_departments";

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
  "create_roles",
  "edit_roles",
  "delete_roles",
  "assign_role_members",
  "create_departments",
  "edit_departments",
  "delete_departments",
];

/**
 * 通讯录（组织）勾选面板的可勾动词 —— 产品口径的十二枚。
 * 刻意不含 create_library（属"库权限"面板）与四枚历史粗粒度位
 * （manage_departments/manage_members/manage_roles/manage_menu/manage_share）：
 * 前三枚已被拆成上面的细粒度动词，拆细后不再新增授予它们；保留在 ORG_ACTIONS 里只是为了让
 * 历史 permissions 串不至于失效（一枚冗余位 >> 一次无声的能力收回）。
 * 前端渲染勾选面板与后端录入校验共用这一个真源，避免"面板能勾但后端不认"。
 */
export const ORG_DIRECTORY_ACTIONS: readonly OrgAction[] = [
  "view_directory",
  "invite_users",
  "create_users",
  "disable_users",
  "delete_users",
  "create_roles",
  "edit_roles",
  "delete_roles",
  "assign_role_members",
  "create_departments",
  "edit_departments",
  "delete_departments",
];

/**
 * 系统预设角色 key。
 * 三枚「权限核心模型」预设在前（超级管理员 / 管理员 / 受限成员），后五枚是 M4 资源授权
 * 引擎的角色名锚点（owner/creator/editor/commenter/viewer），二者同表但语义不同：
 *   - super_admin / admin / restricted 决定一个人在【通讯录 + 库】里能做什么；
 *   - 后五枚是资源策略（auth_policies）的合法主体名，本次不动。
 * 'owner' 仍留在联合类型里：它曾是超级管理员行的旧 systemKey（迁移 20260921010000
 * 起改为 super_admin），保留该字面量只为编译期兼容，运行期不再产出。
 */
export type SystemRoleKey =
  | "super_admin"
  | "admin"
  | "restricted"
  | "owner"
  | "creator"
  | "editor"
  | "commenter"
  | "viewer";

/** 系统角色固定展示顺序：三枚权限预设在前，其后为资源名锚点。 */
export const SYSTEM_ROLE_ORDER: readonly SystemRoleKey[] = [
  "super_admin",
  "admin",
  "restricted",
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
  /**
   * 不可编辑 / 不可删除标记（roles.immutable）。
   * 与 isSystem 分离：isSystem=1 只表示「系统内置、行由迁移种子拥有」，
   * immutable=1 才表示「连名称与说明都不许改、不许删」。
   * 三枚预设里只有超级管理员 immutable=1；管理员与受限成员可被超级管理员编辑/删除。
   */
  immutable: boolean;
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
  /**
   * 硬规则 B：当前登录者能否新建库 / 知识库。
   *
   * 由后端按 domain/authz/libraryPolicy 的裁决现算（超级管理员或管理员；组织角色体系尚未
   * 启用的实例按「登录即可建库」旧行为给 true），前端只读这个信号，不再自己重抄一遍角色规则。
   * 此前前端按「是否持有 create_library 动作」判断，与新模型（建库不再是可分配动作）已经
   * 漂移，会出现「按钮显示了但点了 403」或「超管反而看不到按钮」。
   *
   * 只有 GET /org/members/me/effective-roles 下发；GET /:id/effective-roles（查他人）不含。
   */
  canCreateLibrary?: boolean;
}
