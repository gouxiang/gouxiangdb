// packages/shared-types/src/filters.ts
// 过滤引擎类型（v1 Core/FilterEngine.swift TS 同构）
//
// v1 是「编译成 SQL WHERE」；v2 因为 records.fields 存 JSON，
// 改为「内存谓词求值」—— 但操作符语义、每个字段类型可用的操作符清单 1:1 对齐 v1。

export type FilterOp =
  // 文本
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  // 空值
  | "isEmpty"
  | "isNotEmpty"
  // 数值 / 日期
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  // 布尔
  | "checked"
  | "unchecked"
  // 集合
  | "isAnyOf"
  | "isNoneOf";

export interface FilterCondition {
  kind: "condition";
  fieldId: string;
  op: FilterOp;
  value: string;
  /**
   * 比较值来源：
   *   "literal"（缺省，旧数据）—— 用 value 字面量
   *   "field"               —— 用 valueFieldId 指向的「本表字段」当前值进行匹配（两字段值比较）
   *   "dynamic"             —— 用 dynamicValue 指定的运行期动态变量（如当前登录用户），由求值/编译期注入
   */
  valueType?: "literal" | "field" | "dynamic";
  /** valueType=field 时：本表字段 id（被比较的参照字段） */
  valueFieldId?: string;
  /**
   * valueType=dynamic 时：动态变量枚举。
   *   "currentUser" —— 当前登录用户（人名字段按 userId 精确匹配，见 filter.ts / compile.ts）
   * 枚举保留扩展口：将来可加入 currentDate 等，本轮仅实现 currentUser。
   */
  dynamicValue?: DynamicFilterValue;
}

/** 运行期动态筛选变量（可扩展枚举，本轮仅 "currentUser"） */
export type DynamicFilterValue = "currentUser";

export interface FilterGroup {
  kind: "and" | "or";
  children: FilterNode[];
}

export interface FilterNot {
  kind: "not";
  child: FilterNode;
}

export type FilterNode = FilterCondition | FilterGroup | FilterNot;

/** 操作符是否需要引用比较值（无值操作符不引用 currentUser） */
function opNeedsRef(op: string): boolean {
  return !["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(op);
}

/**
 * 过滤树是否引用了「当前登录用户」动态值（valueType=dynamic / currentUser），
 * 且该条件确实需要比较值（无值操作符 isEmpty 等不算）。
 *
 * 用途（fail-closed 安全）：当树引用 currentUser 而当前无登录用户（未登录 / 分享外链 /
 * 空 userId）时，内存求值与 SQL 编译都必须把【整棵过滤】判定为不匹配 —— 不能只让叶子
 * 返回 false，因为该叶子可能被 NOT 包裹，!(false)=true 会放开全表。故在整棵树顶层短路。
 */
export function filterReferencesCurrentUser(node: FilterNode | null | undefined): boolean {
  if (!node) return false;
  switch (node.kind) {
    case "condition":
      return (
        node.valueType === "dynamic" &&
        node.dynamicValue === "currentUser" &&
        opNeedsRef(node.op)
      );
    case "not":
      return filterReferencesCurrentUser(node.child);
    default:
      return (node.children ?? []).some((ch) => filterReferencesCurrentUser(ch));
  }
}

export interface FilterOperatorDef {
  id: FilterOp;
  label: string;
}

// 各字段类型支持的操作符（v1 FilterEngine.operators(for:) 1:1）
const TEXT_OPS: FilterOperatorDef[] = [
  { id: "is", label: "是" },
  { id: "isNot", label: "不是" },
  { id: "contains", label: "包含" },
  { id: "notContains", label: "不包含" },
  { id: "startsWith", label: "开头是" },
  { id: "endsWith", label: "结尾是" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const NUMBER_OPS: FilterOperatorDef[] = [
  { id: "eq", label: "=" },
  { id: "neq", label: "≠" },
  { id: "gt", label: ">" },
  { id: "lt", label: "<" },
  { id: "gte", label: "≥" },
  { id: "lte", label: "≤" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const DATE_OPS: FilterOperatorDef[] = [
  { id: "is", label: "是" },
  { id: "isNot", label: "不是" },
  { id: "gt", label: "晚于" },
  { id: "lt", label: "早于" },
  { id: "gte", label: "不早于" },
  { id: "lte", label: "不晚于" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const SINGLE_SELECT_OPS: FilterOperatorDef[] = [
  { id: "is", label: "是" },
  { id: "isNot", label: "不是" },
  { id: "isAnyOf", label: "是其中之一" },
  { id: "isNoneOf", label: "都不是" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const MULTI_SELECT_OPS: FilterOperatorDef[] = [
  { id: "contains", label: "包含" },
  { id: "notContains", label: "不包含" },
  { id: "isAnyOf", label: "是其中之一" },
  { id: "isNoneOf", label: "都不是" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const CHECKBOX_OPS: FilterOperatorDef[] = [
  { id: "checked", label: "已勾选" },
  { id: "unchecked", label: "未勾选" },
];

// 关联/子表格：值是 LinkRef[]，contains/notContains 按关联记录标题子串匹配（引擎 arrayContains 已支持 title）
const LINK_OPS: FilterOperatorDef[] = [
  { id: "contains", label: "包含" },
  { id: "notContains", label: "不包含" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const EMPTY_ONLY_OPS: FilterOperatorDef[] = [
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

const FALLBACK_OPS: FilterOperatorDef[] = [
  { id: "is", label: "是" },
  { id: "isEmpty", label: "为空" },
  { id: "isNotEmpty", label: "不为空" },
];

export function operatorsForFieldType(type: string): FilterOperatorDef[] {
  switch (type) {
    case "singleLineText":
    case "longText":
    case "richText":
    case "phone":
    case "email":
    case "url":
    case "json":
    case "createdBy":
    case "lastModifiedBy":
      return TEXT_OPS;
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "rating":
    case "autoNumber":
    case "count":
    case "rollup":
      return NUMBER_OPS;
    case "date":
    case "datetime":
    case "createdTime":
    case "lastModifiedTime":
      return DATE_OPS;
    case "singleSelect":
      return SINGLE_SELECT_OPS;
    case "multiSelect":
      return MULTI_SELECT_OPS;
    case "checkbox":
      return CHECKBOX_OPS;
    case "links":
    case "subtable":
      return LINK_OPS;
    case "attachment":
      return EMPTY_ONLY_OPS;
    default:
      return FALLBACK_OPS;
  }
}

// 该操作符是否需要用户输入值
export function operatorNeedsValue(op: FilterOp): boolean {
  return !["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(op);
}

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  is: "是",
  isNot: "不是",
  contains: "包含",
  notContains: "不包含",
  startsWith: "开头是",
  endsWith: "结尾是",
  isEmpty: "为空",
  isNotEmpty: "不为空",
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  checked: "已勾选",
  unchecked: "未勾选",
  isAnyOf: "是其中之一",
  isNoneOf: "都不是",
};
