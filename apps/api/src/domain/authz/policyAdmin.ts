// M4/S5 节点授权策略管理域：节点/主体/字段加载、整单校验、动作规范化、旧三表反向映射判定。
//
// 纯域：只依赖注入 client（全局或交互事务），不 import Hono/guards。写事务编排见 policyAdminTx.ts，
// HTTP 鉴权/信封见 routes/v1/policies.ts。这里是整单"全合法才提交"的唯一校验真源。

import {
  normalizeActions,
  toActionString,
  resourceActionsForLegacyRole,
  type FieldMask,
  type LegacyRoleFamily,
  type RowConditions,
} from "@gx/shared-types";
import type { AuthzClient, AuthzNode } from "./types.js";
import { SUBJECT_TYPES, parseUpsert, BatchItemError } from "./policyBatchParse.js";

export type PolicySubjectType = "user" | "dept" | "role";

export interface PolicyUpsertInput {
  subjectType: PolicySubjectType;
  subjectId: string;
  /** 原始动作 token（域内规范化 + 白名单校验）。 */
  actions: string[];
  fieldMask?: FieldMask | null;
  /** 行级可见行条件；null 语义＝不设/清空（配合整单全量替换）。 */
  conditions: RowConditions | null;
}
export interface PolicyDeleteInput {
  subjectType: PolicySubjectType;
  subjectId: string;
}

/** 整单语义化失败（校验阶段聚合，路由映射为 400 + 机器码；任一失败即整单不写）。 */
export class PolicyValidationError extends Error {
  constructor(
    readonly code:
      | "POLICY_NODE_NOT_FOUND"
      | "POLICY_NODE_KIND_INVALID"
      | "POLICY_SUBJECT_INVALID"
      | "POLICY_ACTION_INVALID"
      | "POLICY_FIELD_INVALID"
      | "POLICY_BAD_INPUT",
    readonly details: Array<{ index?: number; subject?: string; message: string }>,
  ) {
    super(details[0]?.message ?? "策略整单校验失败");
    this.name = "PolicyValidationError";
  }
}

/** 旧三表反向映射落点（仅 base/kb/doc|canvas 实体节点的 per-user 授权可回写）。 */
interface LegacyTarget {
  family: LegacyRoleFamily;
  table: "member" | "kbMember" | "kbDocAcl";
  resourceId: string;
}

/** 节点 -> 旧三表落点；table/view/group 无逐资源旧行（沿 base 继承或纯新能力），返回 null。 */
export function legacyTargetForNode(node: AuthzNode): LegacyTarget | null {
  switch (node.resourceType) {
    case "base":
      return { family: "base", table: "member", resourceId: node.resourceId! };
    case "kb":
      return { family: "kb", table: "kbMember", resourceId: node.resourceId! };
    case "doc":
    case "canvas":
      return { family: "doc", table: "kbDocAcl", resourceId: node.resourceId! };
    default:
      return null;
  }
}

const FAMILY_ROLES: Record<LegacyRoleFamily, readonly string[]> = {
  base: ["owner", "creator", "editor", "commenter", "viewer"],
  kb: ["owner", "editor", "commenter", "viewer"],
  doc: ["editor", "commenter", "viewer"],
};

/** 规范化动作串 -> 恰好相等的旧角色档；无任一档匹配返回 null（非标组合，不可回写旧表）。 */
export function legacyRoleForActionString(
  family: LegacyRoleFamily,
  actionString: string,
): string | null {
  for (const role of FAMILY_ROLES[family]) {
    if (toActionString(resourceActionsForLegacyRole(family, role)) === actionString) return role;
  }
  return null;
}

/**
 * 判定单条 upsert 是否可反写旧三表，不可映射给原因（裁决 A-5：不阻断、不扩旧表）。
 * 可映射严格条件：user 主体 + 实体节点有旧表落点 + 无 fieldMask + 动作恰为某旧档串。
 */
export function unmappableReason(
  node: AuthzNode,
  input: PolicyUpsertInput,
  actionString: string,
): string | null {
  if (input.subjectType !== "user") {
    return "旧三表仅承载 per-user 成员，角色/部门授予无法回写";
  }
  if (input.fieldMask && (input.fieldMask.allowFields || input.fieldMask.readOnlyFields)) {
    return "字段掩码（fieldMask）收窄旧表不支持";
  }
  const target = legacyTargetForNode(node);
  if (!target) {
    return "该节点类型无逐资源旧表行（table/view 沿 base 继承，group 为纯编排节点）";
  }
  const role = legacyRoleForActionString(target.family, actionString);
  if (!role) return "动作组合不匹配任一旧角色档（旧表角色档为固定动作集）";
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 解析并粗校原始请求体（类型/形状；语义与存在性在 validateBatch 查库校验）。 */
export function parsePolicyBatch(body: unknown): {
  upserts: PolicyUpsertInput[];
  deletes: PolicyDeleteInput[];
} {
  if (!isObject(body)) {
    throw new PolicyValidationError("POLICY_BAD_INPUT", [{ message: "请求体必须是 JSON 对象" }]);
  }
  const upserts: PolicyUpsertInput[] = [];
  const deletes: PolicyDeleteInput[] = [];

  const rawUpserts = body.upserts ?? [];
  const rawDeletes = body.deletes ?? [];
  if (!Array.isArray(rawUpserts) || !Array.isArray(rawDeletes)) {
    throw new PolicyValidationError("POLICY_BAD_INPUT", [{ message: "upserts/deletes 必须是数组" }]);
  }
  if (rawUpserts.length + rawDeletes.length === 0) {
    throw new PolicyValidationError("POLICY_BAD_INPUT", [{ message: "upserts/deletes 至少一项" }]);
  }
  if (rawUpserts.length > 200 || rawDeletes.length > 500) {
    throw new PolicyValidationError("POLICY_BAD_INPUT", [{ message: "单批 upserts<=200、deletes<=500" }]);
  }

  for (const [i, u] of rawUpserts.entries()) {
    try {
      upserts.push(parseUpsert(i, u));
    } catch (err) {
      if (err instanceof BatchItemError) {
        throw new PolicyValidationError(err.code, [err.detail]);
      }
      throw err;
    }
  }

  for (const [i, d] of rawDeletes.entries()) {
    if (!isObject(d) || typeof d.subjectType !== "string"
      || !(SUBJECT_TYPES as readonly string[]).includes(d.subjectType)
      || typeof d.subjectId !== "string" || !d.subjectId.trim()) {
      throw new PolicyValidationError("POLICY_BAD_INPUT", [
        { index: i, message: "deletes 每项须为 {subjectType, subjectId}" },
      ]);
    }
    deletes.push({ subjectType: d.subjectType as PolicySubjectType, subjectId: d.subjectId.trim() });
  }
  return { upserts, deletes };
}

/**
 * 动作按节点类型的合法性（整单校验唯一真源）：
 *   - manage_schema：仅 table/base 节点；
 *   - enter：库门聚合位，仅 base/kb 节点；
 *   - edit_data：库内可写并集聚合位，仅 base/kb 节点（kb 当前不投影，见下）。
 * 依据 docs/decisions/AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS.md §2.1/§4.2。
 */
export function actionLegalForNode(node: AuthzNode, action: string): boolean {
  const rt = node.resourceType;
  if (rt === "base") {
    // 库节点只接受库门聚合位与库级管理位。内容动作 r/c/u/d/comment 落在此会沿继承
    // 无 mask 下放（visibleAll，f2 泄漏），一律拒（§1.3 否决的「库节点补 r」越权口）。
    return action === "enter" || action === "edit_data"
      || action === "manage_share" || action === "manage_schema" || action === "manage_table";
  }
  if (rt === "kb") {
    // kb 库门：enter + 内容动作 + 分享/表管理合法；manage_schema 无意义、edit_data 不投影（I1）。
    return action === "enter"
      || action === "r" || action === "c" || action === "u" || action === "d" || action === "comment"
      || action === "manage_share" || action === "manage_table";
  }
  // 内容/结构节点（table/doc/canvas/view…）：两枚库级聚合位不适用；schema 位仅 table。
  if (action === "enter" || action === "edit_data") return false;
  if (action === "manage_schema") return rt === "table";
  return true;
}

/** 加载活节点（软删/缺失 -> POLICY_NODE_NOT_FOUND）；group 写策略 -> kind 非法。 */
export async function loadTargetNode(client: AuthzClient, nodeId: string): Promise<AuthzNode> {
  const node = await client.navNode.findFirst({
    where: { id: nodeId, deletedAt: null },
  });
  if (!node) {
    throw new PolicyValidationError("POLICY_NODE_NOT_FOUND", [{ message: "节点不存在或已删除", subject: nodeId }]);
  }
  return node as AuthzNode;
}

/** 校验主体存在且未悬挂（user 活账号 / dept 未删 / role 未删）。 */
async function subjectsExist(
  client: AuthzClient,
  items: Array<{ subjectType: PolicySubjectType; subjectId: string }>,
): Promise<{ ok: true } | { ok: false; missing: string }> {
  const uniq = new Map<string, PolicySubjectType>();
  for (const it of items) uniq.set(`${it.subjectType}:${it.subjectId}`, it.subjectType);
  for (const [key, type] of uniq) {
    const id = key.slice(type.length + 1);
    let exists = false;
    if (type === "user") {
      exists = !!(await client.user.findFirst({ where: { id }, select: { id: true } }));
    } else if (type === "dept") {
      exists = !!(await client.department.findFirst({ where: { id, deletedAt: null }, select: { id: true } }));
    } else {
      exists = !!(await client.role.findFirst({ where: { id, deletedAt: null }, select: { id: true } }));
    }
    if (!exists) return { ok: false, missing: `${type}:${id}` };
  }
  return { ok: true };
}

/** 校验 fieldMask 引用字段全部属于该 table 节点（活字段）。 */
async function maskFieldsBelongToTable(
  client: AuthzClient,
  node: AuthzNode,
  mask: FieldMask | null | undefined,
): Promise<{ ok: true } | { ok: false; bad: string }> {
  const ids = [...(mask?.allowFields ?? []), ...(mask?.readOnlyFields ?? [])];
  if (ids.length === 0) return { ok: true };
  if (node.resourceType !== "table") {
    return { ok: false, bad: "fieldMask 仅可挂在 table 节点" };
  }
  const rows = await client.field.findMany({
    where: { id: { in: ids }, tableId: node.resourceId!, deletedAt: null },
    select: { id: true },
  });
  if (rows.length !== new Set(ids).size) return { ok: false, bad: "fieldMask 含不属于该表或已删除的字段" };
  return { ok: true };
}

/**
 * 整单语义校验（存在性/动作合法/字段归属），任一不过抛 PolicyValidationError，整单不写。
 * 返回每条 upsert 的规范化动作串（供事务与不可映射判定复用，避免二次规范化）。
 */
export async function validateBatch(
  client: AuthzClient,
  node: AuthzNode,
  upserts: PolicyUpsertInput[],
  deletes: PolicyDeleteInput[],
): Promise<{ normalized: string[] }> {
  const subjectCheck = await subjectsExist(client, [...upserts, ...deletes]);
  if (!subjectCheck.ok) {
    throw new PolicyValidationError("POLICY_SUBJECT_INVALID", [{ message: `悬挂主体: ${subjectCheck.missing}` }]);
  }
  if (node.resourceType === null || node.kind === "group") {
    throw new PolicyValidationError("POLICY_NODE_KIND_INVALID", [{ message: "编排节点（group）不能挂资源授权策略" }]);
  }
  const normalized: string[] = [];
  for (const [i, u] of upserts.entries()) {
    const actions = normalizeActions(u.actions);
    if (actions.length === 0) {
      throw new PolicyValidationError("POLICY_ACTION_INVALID", [{ index: i, message: "动作规范化后为空" }]);
    }
    for (const a of actions) {
      if (a === "edit_data") {
        // 聚合位只接受 scope 投影派生（经 scopeProjectionTx 直接写、不走本校验）；
        // 手工 upsert 会制造与 legacy canEditData 口径不一致的越权，一律拒绝（I1）。
        throw new PolicyValidationError("POLICY_ACTION_INVALID", [
          { index: i, subject: u.subjectId, message: "edit_data 为投影派生位，不可手工授予" },
        ]);
      }
      if (!actionLegalForNode(node, a)) {
        throw new PolicyValidationError("POLICY_ACTION_INVALID", [
          { index: i, subject: u.subjectId, message: `动作 ${a} 对该节点类型非法` },
        ]);
      }
    }
    const fieldCheck = await maskFieldsBelongToTable(client, node, u.fieldMask);
    if (!fieldCheck.ok) {
      throw new PolicyValidationError("POLICY_FIELD_INVALID", [{ index: i, subject: u.subjectId, message: fieldCheck.bad }]);
    }
    if (u.conditions !== null) {
      if (node.resourceType !== "table") {
        throw new PolicyValidationError("POLICY_NODE_KIND_INVALID", [
          { index: i, subject: u.subjectId, message: "行级条件只能挂在 table 节点" },
        ]);
      }
      if (!actions.includes("r")) {
        throw new PolicyValidationError("POLICY_ACTION_INVALID", [
          { index: i, subject: u.subjectId, message: "行级条件要求动作含 r（读）" },
        ]);
      }
    }
    normalized.push(toActionString(actions));
  }
  return { normalized };
}
