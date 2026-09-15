// packages/shared-types/src/policy.ts
// M4/S9 权限引擎 v1 契约 DTO（供 web M4-FE 与 api 共用，只增不改）。
//
// 与 docs/api/openapi.yaml 的命名 schema 逐字段对应；运行时 *._KEYS 常量与 openapi
// required 列表在 apps/api/src/docs/__tests__/s9-dto-openapi-cross.test.ts 交叉断言防漂移
// （沿 S2 backfill-literals 套路：类型管编译、常量管运行时对拍）。
//
// 边界：
//   - 这里是 HTTP 线上形状。api 域内 VisibleScope 多一个 sql（物化契约），路由层映射为
//     materialize 枚举，故 VisibleScopeDTO 不含 sql/expectsTempTable（见 openapi 说明）。
//   - 中断继承 DTO（InheritanceImpactDTO 等）已在 nav.ts 单一定义，本文件只 re-export，不重复。

import type { ResourceAction } from "./authz.js";
import type { NavKind } from "./nav.js";

export type {
  InheritanceDeltaKind,
  InheritanceImpactItemDTO,
  InheritanceExemptItemDTO,
  InheritanceImpactDTO,
  InheritanceChangeResultDTO,
  BreadcrumbNodeDTO,
  NodeBreadcrumbDTO,
} from "./nav.js";

/** 策略主体三源。 */
export type PolicySubjectType = "user" | "dept" | "role";

/** effective 来源种类（owner_fallback=creator/workspace owner 兜底，非真实策略行）。 */
export type EffectiveSourceKind = "direct" | "dept" | "role" | "owner_fallback";

/** 兜底来源类型。 */
export type EffectiveFallbackKind = "workspace_owner" | "creator";

/** 可见集物化方式：in_list=可直接参数化 IN；temp_table=M5 必须先物化为临时表。 */
export type ScopeMaterialize = "in_list" | "temp_table";

/** 三源主体引用 + 显示名（悬挂主体 subjectName=null）。 */
export interface PolicySubjectDTO {
  subjectType: PolicySubjectType;
  subjectId: string;
  subjectName: string | null;
}
export const POLICY_SUBJECT_KEYS = ["subjectType", "subjectId", "subjectName"] as const;

/** 字段掩码（收窄清单，不是 deny）；缺省键=不裁剪。 */
export interface FieldMaskDTO {
  allowFields?: string[];
  readOnlyFields?: string[];
}

/** GET /nodes/:id/policies 的 direct[] 行。 */
export interface PolicyRowDTO extends PolicySubjectDTO {
  id: string;
  actions: ResourceAction[];
  fieldMask: FieldMaskDTO | null;
  reason: string | null;
  createdAt: string;
}
export const POLICY_ROW_KEYS = [
  "id",
  "subjectType",
  "subjectId",
  "subjectName",
  "actions",
  "fieldMask",
  "reason",
  "createdAt",
] as const;

/** cutoff 链祖先只读继承摘要里的单行（主体 + 动作，无 id/掩码）。 */
export interface PolicyAncestorRowDTO extends PolicySubjectDTO {
  actions: ResourceAction[];
}

/** 单个祖先节点的继承策略摘要。 */
export interface PolicyAncestorSummaryDTO {
  nodeId: string;
  nodeName: string;
  policies: PolicyAncestorRowDTO[];
}
export const POLICY_ANCESTOR_SUMMARY_KEYS = ["nodeId", "nodeName", "policies"] as const;

/** GET /nodes/:id/policies 响应（管理视角）。 */
export interface NodePoliciesViewDTO {
  node: {
    id: string;
    kind: NavKind;
    resourceType: string | null;
    name: string;
    inheritAncestors: number;
  };
  inheritAncestors: boolean;
  direct: PolicyRowDTO[];
  ancestors: PolicyAncestorSummaryDTO[];
}
export const NODE_POLICIES_VIEW_KEYS = ["node", "inheritAncestors", "direct", "ancestors"] as const;
export const NODE_POLICIES_VIEW_NODE_KEYS = ["id", "kind", "resourceType", "name", "inheritAncestors"] as const;

/** PUT upserts[] 单项（整单全合法才提交；conditions 键本期不读不存）。 */
export interface PolicyUpsertDTO {
  subjectType: PolicySubjectType;
  subjectId: string;
  actions: ResourceAction[];
  fieldMask?: FieldMaskDTO | null;
}
export const POLICY_UPSERT_KEYS = ["subjectType", "subjectId", "actions"] as const;

/** PUT deletes[] 单项。 */
export interface PolicyDeleteDTO {
  subjectType: PolicySubjectType;
  subjectId: string;
}
export const POLICY_DELETE_KEYS = ["subjectType", "subjectId"] as const;

/** PUT /nodes/:id/policies 请求体。 */
export interface PolicyWriteRequestDTO {
  upserts?: PolicyUpsertDTO[];
  deletes?: PolicyDeleteDTO[];
}

/** 不可反写旧三表的授权明细（200 成功载荷，非错误码）。 */
export interface LegacyUnmappableItemDTO {
  subjectType: PolicySubjectType;
  subjectId: string;
  reasons: string[];
}
export const LEGACY_UNMAPPABLE_ITEM_KEYS = ["subjectType", "subjectId", "reasons"] as const;

/** PUT /nodes/:id/policies 200 响应。 */
export interface PolicyWriteResultDTO {
  node: {
    id: string;
    kind: NavKind;
    resourceType: string | null;
    resourceId: string | null;
    name: string;
  };
  policyVersion: number;
  upserted: number;
  deleted: number;
  legacyUnmappable: LegacyUnmappableItemDTO[];
}
export const POLICY_WRITE_RESULT_KEYS = ["node", "policyVersion", "upserted", "deleted", "legacyUnmappable"] as const;
export const POLICY_WRITE_RESULT_NODE_KEYS = ["id", "kind", "resourceType", "resourceId", "name"] as const;

/** effective perAction.sources[] 单条授予来源（O8 可解释来源链）。 */
export interface EffectiveSourceDTO extends PolicySubjectDTO {
  kind: EffectiveSourceKind;
  policyId: string | null;
  nodeId: string;
  nodeName: string | null;
  viaAncestor: boolean;
  fallback: EffectiveFallbackKind | null;
}
export const EFFECTIVE_SOURCE_KEYS = [
  "kind",
  "policyId",
  "nodeId",
  "nodeName",
  "viaAncestor",
  "subjectType",
  "subjectId",
  "subjectName",
  "fallback",
] as const;

/** effective perAction[] 单项：一枚资源动作的最终判定与来源链。 */
export interface EffectivePermissionDTO {
  action: ResourceAction;
  allowed: boolean;
  sources: EffectiveSourceDTO[];
}
export const EFFECTIVE_PERMISSION_KEYS = ["action", "allowed", "sources"] as const;

/** GET /nodes/:id/effective 响应。 */
export interface EffectiveViewDTO {
  node: {
    id: string;
    kind: NavKind;
    resourceType: string | null;
    name: string;
  };
  userId: string;
  actions: ResourceAction[];
  policyVersion: number;
  perAction: EffectivePermissionDTO[];
}
export const EFFECTIVE_VIEW_KEYS = ["node", "userId", "actions", "policyVersion", "perAction"] as const;
export const EFFECTIVE_VIEW_NODE_KEYS = ["id", "kind", "resourceType", "name"] as const;

/** GET /authz/visible-scope 响应（HTTP 层；域内 sql 物化为 materialize 枚举）。 */
export interface VisibleScopeDTO {
  userId: string;
  actions: ResourceAction[];
  kinds: NavKind[] | null;
  nodeIds: string[];
  resourceIdsByType: Record<string, string[]>;
  maskedTableFields: Record<string, string[]>;
  truncated: boolean;
  policyVersion: number;
  budget: number;
  evaluated: number;
  visibleTotal: number;
  materialize: ScopeMaterialize;
  count: number;
}
export const VISIBLE_SCOPE_KEYS = [
  "userId",
  "actions",
  "kinds",
  "nodeIds",
  "resourceIdsByType",
  "maskedTableFields",
  "truncated",
  "policyVersion",
  "budget",
  "evaluated",
  "visibleTotal",
  "materialize",
  "count",
] as const;
