// packages/shared-types/src/authz.ts
// M4 统一权限引擎：资源动作词汇 + 旧角色映射 + 动作串规范化 + FieldMask（唯一真源，只增）。
//
// 边界（M4 计划 §4.1/§4.4，总监裁决纯 allow）：
//   - 资源动作全集 8 枚，auth_policies.actions 存放【字典序去重】的逗号分隔串；
//   - resourceActionsForLegacyRole 是回填 SQL 与引擎的共同映射，禁止两处各写一份；
//   - FieldMask 是命中 allow 之上的能力裁剪（收窄清单，不是 deny/授权清单）：
//     缺省=不裁剪；多来源并集取最宽（见 fieldMask.ts）。

/**
 * 资源动作（auth_policies.actions 全集）。
 *
 * 后两枚是【库级聚合位】（ADR-0056 / AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS.md §4）：
 *   - enter     库级准入，恒等于第二代 access.visible；
 *   - edit_data 库内活表可写并集，恒等于第二代 perm.canEditData。
 * 只在 base/kb 节点上有语义，且【只由 scope 投影派生、不得手授】（不变量 I1）；
 * 二者都不是 r/c/u，故结构上不可能进入 fieldMask 能力并集（不变量 I2）。
 */
export type ResourceAction =
  | "r"
  | "c"
  | "u"
  | "d"
  | "comment"
  | "manage_share"
  | "manage_schema"
  | "manage_table"
  | "enter"
  | "edit_data";

/** ResourceAction 封闭枚举（白名单校验/穷举用），字典序即规范串序。 */
export const RESOURCE_ACTIONS: readonly ResourceAction[] = [
  "r",
  "c",
  "u",
  "d",
  "comment",
  "manage_share",
  "manage_schema",
  "manage_table",
  "enter",
  "edit_data",
];

/** 库节点资源类型：两枚聚合位只在这两类节点上有语义。 */
export const LIBRARY_RESOURCE_TYPES: readonly string[] = ["base", "kb"];

/** 旧角色三族（members=base 五档 / kb_members=kb 四档 / kb_doc_acls=doc 三档）。 */
export type LegacyRoleFamily = "base" | "kb" | "doc";

/** doc ACL 三档（editor/commenter/viewer）。 */
export type DocLegacyRole = "editor" | "commenter" | "viewer";
/** kb 成员四档。 */
export type KbLegacyRole = "owner" | "editor" | "commenter" | "viewer";
/** base 成员五档。 */
export type BaseLegacyRole = "owner" | "creator" | "editor" | "commenter" | "viewer";

// 各档动作映射（M4 计划 §4.1 表；manage_share/manage_schema 随祖先链继承，不做裁剪）。
const BASE_ROLE_ACTIONS: Record<BaseLegacyRole, readonly ResourceAction[]> = {
  owner: ["r", "c", "u", "d", "comment", "manage_share", "manage_schema"],
  creator: ["r", "c", "u", "d", "comment", "manage_schema"],
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};
const KB_ROLE_ACTIONS: Record<KbLegacyRole, readonly ResourceAction[]> = {
  owner: ["r", "c", "u", "d", "comment", "manage_share"],
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};
const DOC_ROLE_ACTIONS: Record<DocLegacyRole, readonly ResourceAction[]> = {
  editor: ["r", "c", "u", "d", "comment"],
  commenter: ["r", "comment"],
  viewer: ["r"],
};

/**
 * 旧资源角色 -> 标准资源动作集（回填与引擎共用）。
 * 未知名/空角色一律收敛为空集（纯 allow：无动作即无授权），不抛异常以便批量回填安全。
 */
export function resourceActionsForLegacyRole(
  family: LegacyRoleFamily,
  role: string | null | undefined,
): ResourceAction[] {
  if (!role) return [];
  const table =
    family === "base" ? BASE_ROLE_ACTIONS : family === "kb" ? KB_ROLE_ACTIONS : DOC_ROLE_ACTIONS;
  const found = (table as Record<string, readonly ResourceAction[]>)[role];
  return found ? [...found] : [];
}

/** 动作串规范化：白名单过滤非法值 + 去重 + 字典序排序（存放前统一调用）。 */
export function normalizeActions(raw: readonly string[] | null | undefined): ResourceAction[] {
  if (!raw) return [];
  const allow = new Set<string>(RESOURCE_ACTIONS);
  const valid = raw.filter((a): a is ResourceAction => typeof a === "string" && allow.has(a));
  return [...new Set(valid)].sort();
}

/** 解析存储串（逗号分隔）为规范动作数组。 */
export function parseActionString(stored: string | null | undefined): ResourceAction[] {
  if (!stored) return [];
  return normalizeActions(stored.split(",").map((s) => s.trim()).filter(Boolean));
}

/** 动作数组 -> 规范存储串（字典序逗号分隔；空集为空串）。 */
export function toActionString(actions: readonly string[]): string {
  return normalizeActions(actions).join(",");
}

/** 规范判定：动作集是否含某动作。 */
export function hasAction(actions: readonly string[], action: ResourceAction): boolean {
  return actions.includes(action);
}

/**
 * fieldMask JSON 形状（挂在 table 节点的策略行 fieldMask 列；M3 裁决 3：不建 field 节点）。
 * 缺省字段=不裁剪；allowFields 是收窄可见清单，readOnlyFields 是该来源下只读清单。
 */
export interface FieldMask {
  allowFields?: string[];
  readOnlyFields?: string[];
}

/**
 * 行级条件策略契约（P1 §6.3；auth_policies.conditions 列 JSON）。
 * fail-closed：结构任何一处不合法即抛 PolicyValidationError，绝不返回半截对象。
 */
import type { FilterNode, FilterOp, FilterCondition } from "./filters.js";

/** 行级条件解析/校验失败（坏 JSON 或结构不合法）。 */
export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

/** 可见行条件（最小形态，v1）：filter 为真的行才可见、才可写。 */
export interface RowConditions {
  version: 1;
  filter: FilterNode;
}

/** filters.ts FilterOp 全集白名单（必须与 FilterOp 字面量保持同步）。 */
const FILTER_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  "is",
  "isNot",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "isEmpty",
  "isNotEmpty",
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "checked",
  "unchecked",
  "isAnyOf",
  "isNoneOf",
]);

/** 无需比较值的操作符（不要求 value / valueFieldId / dynamicValue）。 */
const NO_VALUE_OPS: ReadonlySet<string> = new Set([
  "isEmpty",
  "isNotEmpty",
  "checked",
  "unchecked",
]);

const VALUE_TYPES: ReadonlySet<string> = new Set(["literal", "field", "dynamic"]);

/**
 * condition 节点校验形状（对齐 FilterCondition，但 value 不强制：
 * 无值操作符 isEmpty/checked 等不要求 value，交由求值侧按既有口径处理）。
 */
type LooseCondition = Pick<FilterCondition, "kind" | "fieldId" | "op"> &
  Partial<Pick<FilterCondition, "value" | "valueType" | "valueFieldId" | "dynamicValue">>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertConditionNode(raw: Record<string, unknown>): void {
  const node = raw as LooseCondition;
  const { fieldId, op } = node;
  if (typeof fieldId !== "string" || fieldId.trim() === "") {
    throw new PolicyValidationError("condition.fieldId 必须是非空字符串");
  }
  if (typeof op !== "string" || !FILTER_OPS.has(op as FilterOp)) {
    throw new PolicyValidationError(`不支持的过滤操作符：${String(op)}`);
  }

  const rawValueType = node.valueType;
  const valueType = rawValueType === undefined ? "literal" : rawValueType;
  if (typeof valueType !== "string" || !VALUE_TYPES.has(valueType)) {
    throw new PolicyValidationError(`非法 valueType：${String(rawValueType)}`);
  }

  if (!NO_VALUE_OPS.has(op)) {
    if (valueType === "field") {
      const { valueFieldId } = node;
      if (typeof valueFieldId !== "string" || valueFieldId.trim() === "") {
        throw new PolicyValidationError("valueType=field 时 valueFieldId 必须是非空字符串");
      }
    } else if (valueType === "dynamic") {
      if (node.dynamicValue !== "currentUser") {
        throw new PolicyValidationError('valueType=dynamic 时 dynamicValue 必须是 "currentUser"');
      }
    }
  }
}

function assertFilterNode(raw: unknown, path: string): void {
  if (!isPlainObject(raw)) {
    throw new PolicyValidationError(`${path} 必须是 FilterNode 对象`);
  }
  const kind = raw.kind;
  if (kind === "condition") {
    assertConditionNode(raw);
  } else if (kind === "and" || kind === "or") {
    const { children } = raw;
    if (!Array.isArray(children) || children.length === 0) {
      throw new PolicyValidationError(`${path}.children 必须是非空数组`);
    }
    children.forEach((child, i) => assertFilterNode(child, `${path}.children[${i}]`));
  } else if (kind === "not") {
    assertFilterNode(raw.child, `${path}.child`);
  } else {
    throw new PolicyValidationError(`${path} 未知节点 kind：${String(kind)}`);
  }
}

/**
 * 解析 auth_policies.conditions 存储串为 RowConditions（纯函数，无 IO）。
 * null/undefined/空白串 -> null（无条件，不报错）；坏 JSON / 结构非法 -> PolicyValidationError。
 */
export function parseRowConditions(raw: string | null | undefined): RowConditions | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PolicyValidationError(`conditions 不是合法 JSON：${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new PolicyValidationError("conditions 顶层必须是对象");
  }
  if (parsed.version !== 1) {
    throw new PolicyValidationError("conditions.version 必须严格等于 1");
  }
  assertFilterNode(parsed.filter, "conditions.filter");

  return { version: 1, filter: parsed.filter as FilterNode };
}
