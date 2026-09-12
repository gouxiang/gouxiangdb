// packages/shared-types/src/permissions.ts
// RBAC 权限模型（v1 Core/PermissionChecker.swift TS 同构，1:1 对齐）

export type Role = "owner" | "creator" | "editor" | "commenter" | "viewer";

export const ROLES: Role[] = ["owner", "creator", "editor", "commenter", "viewer"];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "所有者",
  creator: "创建者",
  editor: "编辑者",
  commenter: "评论者",
  viewer: "阅读者",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "可管理 Base、成员、结构、数据与分享",
  creator: "可管理表结构与数据，不能管理 Base 成员",
  editor: "可编辑记录数据，不能改表结构",
  commenter: "可查看与评论，不能编辑数据",
  viewer: "仅可查看",
};

export interface PermissionSet {
  canManageBase: boolean; // 管理 Base 设置 / 成员 / 分享 / 删除
  canManageSchema: boolean; // 增删字段、改表结构
  canEditData: boolean; // 增删改记录
  canComment: boolean; // 发表评论
  canView: boolean; // 查看
}

// v1 权限位矩阵（严格 1:1）
const MATRIX: Record<Role, PermissionSet> = {
  owner: {
    canManageBase: true,
    canManageSchema: true,
    canEditData: true,
    canComment: true,
    canView: true,
  },
  creator: {
    canManageBase: false,
    canManageSchema: true,
    canEditData: true,
    canComment: true,
    canView: true,
  },
  editor: {
    canManageBase: false,
    canManageSchema: false,
    canEditData: true,
    canComment: true,
    canView: true,
  },
  commenter: {
    canManageBase: false,
    canManageSchema: false,
    canEditData: false,
    canComment: true,
    canView: true,
  },
  viewer: {
    canManageBase: false,
    canManageSchema: false,
    canEditData: false,
    canComment: false,
    canView: true,
  },
};

export function permissionsForRole(role: Role): PermissionSet {
  return { ...(MATRIX[role] ?? MATRIX.viewer) };
}

export function roleCanManageBase(role: Role): boolean {
  return role === "owner";
}

export function roleCanManageSchema(role: Role): boolean {
  return role === "owner" || role === "creator";
}

export function roleCanEditData(role: Role): boolean {
  return role === "owner" || role === "creator" || role === "editor";
}

export function roleCanComment(role: Role): boolean {
  return role !== "viewer";
}

// 视图锁定模式对权限的修正
// - collaborative：所有人共享同一份视图配置，有 schema 权限的人可改
// - locked：视图配置被锁定，只有 schema 权限者可改
// - personal：每人一份私有配置
export function canEditViewConfig(role: Role, lockMode: "collaborative" | "locked" | "personal"): boolean {
  if (lockMode === "personal") return true;
  return roleCanManageSchema(role);
}

// 角色等级（用于「不能修改比自己高的角色」校验）
export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  creator: 80,
  editor: 60,
  commenter: 40,
  viewer: 20,
};

export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

// MemberDTO 定义在 api.ts（HTTP 契约真源），避免重复导出
