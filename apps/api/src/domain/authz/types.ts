// M4/S1 权限引擎领域类型（纯类型，无运行时副作用；引擎不 import Hono/guards，不查旧三表）。

import type { ResourceAction } from "@gx/shared-types";

/** 引擎可用的 Prisma 访问面（全局 client 或交互事务 tx 均可注入，便于计数测试与 S5 同事务）。 */
export type AuthzClient = import("@prisma/client").Prisma.TransactionClient;

/** 决策所需的 nav 节点最小投影（M3 nav_nodes）。 */
export interface AuthzNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: string;
  resourceType: string | null;
  resourceId: string | null;
  name: string;
  path: string;
  depth: number;
  inheritAncestors: number;
  deletedAt: Date | null;
}

/** 一条命中的 allow 策略（auth_policies 行 + 派生定位信息）。 */
export interface ScopedPolicy {
  id: string;
  nodeId: string;
  subjectType: "user" | "dept" | "role";
  subjectId: string;
  actions: ResourceAction[];
  /** 解析后的 fieldMask（无掩码为 null）。 */
  fieldMask: import("@gx/shared-types").FieldMask | null;
  /** 解析后的行级可见条件（无条件为 null=宽）。 */
  rowConditions: import("@gx/shared-types").RowConditions | null;
  /** 该策略所在节点是否经祖先链继承命中（false=节点直接策略）。 */
  viaAncestor: boolean;
}

/** resolveSubject 产物：三源主体展开。 */
export interface ResolvedSubject {
  userId: string;
  /** effectiveOrgRoles 的角色 id（role_assignments 源，含部门祖先继承，M2 已求值）。 */
  roleIds: string[];
  /** 用户各活部门（id + path），dept 源按 path 前缀匹配。 */
  departments: Array<{ id: string; path: string }>;
  /** 部门祖先闭包 id 集（各部门 path 切段的并集，含自身）；dept 源 IN 查询用，定数一条 SQL。 */
  deptAncestorIds: string[];
  /** 是否工作区 owner（持 role_owner），owner_fallback 用。 */
  isWorkspaceOwner: boolean;
}

/** 决策命中来源（O8 来源链用）。 */
export interface AllowSource {
  kind: "direct" | "dept" | "role" | "owner_fallback";
  policyId?: string;
  nodeId: string;
  nodeName?: string;
  viaAncestor: boolean;
  /** owner_fallback 子型。 */
  fallback?: "workspace_owner" | "creator";
  /** dept/role 来源的主体 id。 */
  subjectId?: string;
}

export interface Decision {
  allowed: boolean;
  action: ResourceAction;
  nodeId: string;
  /** 命中时的来源链（可能多条，O8 全部列出）；拒绝时为空。 */
  sources: AllowSource[];
  /** 拒绝原因码（拒绝时）。 */
  reason?: "no_matching_allow";
}

/** 决策上下文：字段动作带 fieldId；行级条件 M4 顺延（ctx.row 仅留参数位不实现）。 */
export interface DecisionContext {
  fieldId?: string;
  row?: unknown;
}

/** 实体 createdBy 解析器（由适配层 S3 注入；引擎不直接 import 旧表，nav 资源点查在会话内缓存）。 */
export type CreatedByResolver = (node: AuthzNode) => Promise<string | null>;
