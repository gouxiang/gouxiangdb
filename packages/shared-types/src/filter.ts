// packages/shared-types/src/filter.ts
// 过滤引擎实现（v1 Core/FilterEngine.swift TS 同构，前后端共用）
//
// v1 把 FilterNode 编译成 SQL WHERE（因为每字段一物理列）；
// v2 records.fields 存 JSON，改为内存谓词求值。操作符语义严格对齐 v1：
//   isEmpty     : col IS NULL OR col=''
//   isNotEmpty  : col IS NULL→false, col!='' →true
//   contains    : CAST(col AS TEXT) LIKE '%v%'
//   gt/lt/...   : CAST(col AS REAL) 比较
//
// v2 相对 v1 的一处**有意修正**（已记录于 ADR）：
//   v1 的 isAnyOf/isNoneOf 用 LIKE '%"v"%' 统一匹配，对「单选字段存纯文本」的场景命中不了
//   （v1 潜在缺陷）。v2 按值形态分派：数组→包含任一；单值→等于任一。语义更符合 NocoDB。
//
// 这个实现是前后端共用的；apps/api 在 domain/filter.ts re-export 保持现有 import 不变。

import type { FilterNode, FilterCondition } from "./filters.js";
import { filterReferencesCurrentUser } from "./filters.js";

export type RawValue = unknown;

/**
 * 运行期动态变量（valueType="dynamic" 时注入）。
 * currentUserId —— 当前登录用户 id（人名字段 currentUser 比较的唯一真源）。
 * currentUserName —— 当前用户显示名（保留给将来需要按名展示/比较的场景，本轮求值不使用）。
 */
export interface FilterVars {
  currentUserId?: string | null;
  currentUserName?: string | null;
}

/**
 * 内存求值上下文。
 *
 * getActorId：取「人名字段」在**当前记录上的 actor userId**（不是显示名）。
 *   仅用于 valueType="dynamic" / dynamicValue="currentUser" 的左值。
 *   为什么需要它：内存路径在 hydrate 之后求值，此时 fields[createdByFieldId] 已是
 *   resolveUserName() 得到的**显示名**；而物理 records.createdBy 列存的是 **userId**。
 *   User.displayName 无唯一约束（username/email 才唯一），按显示名匹配会重名误命中。
 *   因此 currentUser 两路径都按 userId 精确比较 —— 物理侧 records.createdBy = :uid，
 *   内存侧 getActorId(fieldId) === vars.currentUserId。调用方（recordService）知道字段
 *   类型，可回 HydratedRecord 顶层 createdBy/updatedBy（物理 userId）。缺省回退到 get。
 */
export interface FilterEvalContext {
  vars?: FilterVars;
  getActorId?: (fieldId: string) => RawValue;
  /**
   * 高级模式公式谓词求值：对当前记录求 expression，必须返回严格布尔。
   * 由调用方（recordService）注入，内部已持有该记录的公式 source；缺省（未注入）时
   * formula 节点一律 fail-closed 返回 false。空表达式在本文件内先短路为 true（无筛选），
   * 不会走到回调。
   */
  evalFormula?: (expression: string) => boolean;
}

/** 把任意 cell 值「文本化」，模拟 v1 的 CAST(col AS TEXT) */
export function toComparableText(v: RawValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Array.isArray(v)) {
    // LinkRef[] → 用 title 拼接（v1 关联字段在 SQL 里不参与过滤，这里给出可读文本）
    if (v.length > 0 && typeof v[0] === "object" && v[0] !== null && "title" in (v[0] as object)) {
      return (v as { title: string }[]).map((x) => x.title).join(", ");
    }
    // string[]（multiSelect）→ 逗号拼接，便于 contains 语义
    return (v as unknown[]).map((x) => toComparableText(x)).join(", ");
  }
  if (typeof v === "object") {
    // 附件等复杂对象
    if ("name" in (v as object)) return String((v as { name: unknown }).name);
    return JSON.stringify(v);
  }
  return String(v);
}

/**
 * 严格的日期 / 日期时间形态（date 字段存 'YYYY-MM-DD'，datetime 存 ISO-8601）。
 * 命中才按时间戳比较，避免把普通数字/文本误当日期。
 */
const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function toNumber(v: RawValue): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const t = toComparableText(v);
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  // 日期/日期时间：Number('2026-09-11') 为 NaN，需按时间戳比较，否则 gt/lt/gte/lte/eq
  // 对日期字段恒为 false（日期区间筛选整体失效）。两侧值都经同一归一，保证比较对称。
  if (DATE_LIKE.test(t)) {
    const ts = Date.parse(t);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/** 空判定：对齐 v1 的 (col IS NULL OR col='') */
export function isEmptyValue(v: RawValue): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && Object.keys(v as object).length === 0) return true;
  return false;
}

function splitMulti(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function arrayContainsAny(arr: RawValue, items: string[]): boolean {
  if (!Array.isArray(arr)) return false;
  // isAnyOf/isNoneOf 用：任一元素（title/文本化）字符串严格等于 items 中任一。
  // 大小写不敏感对齐 v1 CAST(col AS TEXT) LIKE 行为。
  return arr.some((x) => {
    const t = typeof x === "object" && x !== null && "title" in (x as object)
      ? (x as { title: string }).title
      : toComparableText(x);
    return items.some((item) => t.toLowerCase() === item.toLowerCase());
  });
}

/** 数组 contains（子串）：任一元素（title/文本化）的字符串包含 needle（大小写不敏感） */
function arrayContains(arr: RawValue, needle: string): boolean {
  if (!Array.isArray(arr)) return false;
  const needleLower = needle.toLowerCase();
  return arr.some((x) => {
    const t = typeof x === "object" && x !== null && "title" in (x as object)
      ? (x as { title: string }).title
      : toComparableText(x);
    return t.toLowerCase().includes(needleLower);
  });
}

/** 把 actor 左值归一为 userId 字符串；空 -> null（对齐物理 NOT NULL 列 + SQL 三值逻辑） */
function normalizeActorId(v: RawValue): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v;
  const t = toComparableText(v);
  return t === "" ? null : t;
}

/**
 * 求值一个条件。
 * @param get     取「目标表（被筛选）记录」字段值
 * @param getSelf 取「本表当前记录」字段值 —— 仅当条件 valueType="field"（匹配字段）时使用；
 *                缺省回退到 get（视图级同表筛选时即自比较）。
 * @param ctx     动态变量上下文 —— 仅当 valueType="dynamic"（当前用户）时使用。
 */
function evalCondition(
  c: FilterCondition,
  get: (fieldId: string) => RawValue,
  getSelf?: (fieldId: string) => RawValue,
  ctx?: FilterEvalContext,
): boolean {
  let v: RawValue = get(c.fieldId);

  // 「当前用户」：比较值来自运行期登录用户。
  // 仅对需要值的操作符生效；无值操作符（isEmpty 等）不引用 currentUser，照常求值。
  const dynamicMatch = c.valueType === "dynamic" && operatorNeedsValueFor(c.op);
  if (dynamicMatch) {
    // fail-closed：无登录用户（未登录 / 分享外链 / 空 userId）或不支持的动态变量，
    // 一律不放行 —— 包括 isNot/notContains 等反向操作，避免反向条件放开全表。
    const uid = ctx?.vars?.currentUserId ?? null;
    if (!uid || c.dynamicValue !== "currentUser") return false;
    // 左值取 actor userId（非显示名），与物理 records.createdBy 列口径一致。
    const actorId = normalizeActorId((ctx?.getActorId ?? get)(c.fieldId));
    // 物理 createdBy 为 NOT NULL；SQL 中 NULL <> uid 结果为 NULL（行被排除）。
    // actorId 缺失时同样判 false，保证内存 / 物理逐值等价。
    if (!actorId) return false;
    v = actorId;
    // 落到下面的通用操作符 machinery：把比较值绑定为当前 userId，复用 is/isNot/contains 等，
    // 无需为动态值另写一套操作符实现（避免语义分叉）。
  }

  const text = toComparableText(v);

  // 「匹配字段」：比较值来自本表字段（两字段值相等/比较）。
  // 仅对需要值的操作符生效；无值操作符（isEmpty/checked 等）忽略 valueType。
  const fieldMatch = c.valueType === "field" && operatorNeedsValueFor(c.op);
  const resolveSelf = getSelf ?? get;
  /** 比较值：dynamic 模式绑定当前 userId，否则用字面量 */
  const lit = dynamicMatch ? (ctx?.vars?.currentUserId as string) : c.value;
  /** 匹配字段模式下的本字段值（文本/数值两种形态） */
  const fv = fieldMatch ? resolveSelf(c.valueFieldId ?? "") : null;
  const fText = fieldMatch ? toComparableText(fv) : "";
  /** 比较用文本：field 模式用本表字段文本，否则用字面量 */
  const cmpText = fieldMatch ? fText : lit;
  /** 比较用数值（field 模式取本表字段数值） */
  const cmpNum = fieldMatch ? toNumber(fv) : null;

  switch (c.op) {
    case "isEmpty":
      return isEmptyValue(v);
    case "isNotEmpty":
      return !isEmptyValue(v);

    case "checked":
      return v === true || v === 1 || text === "1" || text === "true";
    case "unchecked":
      return v === false || v === 0 || isEmptyValue(v) || text === "0" || text === "false";

    case "is":
      return text === cmpText;
    case "isNot":
      return text !== cmpText;
    case "eq": {
      const a = toNumber(v);
      const b = fieldMatch ? cmpNum : toNumber(lit);
      if (a === null || b === null) return text === cmpText;
      return a === b;
    }
    case "neq": {
      const a = toNumber(v);
      const b = fieldMatch ? cmpNum : toNumber(lit);
      if (a === null || b === null) return text !== cmpText;
      return a !== b;
    }
    case "contains":
      if (Array.isArray(v)) return arrayContains(v, cmpText);
      return text.toLowerCase().includes(cmpText.toLowerCase());
    case "notContains":
      if (Array.isArray(v)) return !arrayContains(v, cmpText);
      return !text.toLowerCase().includes(cmpText.toLowerCase());
    case "startsWith":
      return text.toLowerCase().startsWith(cmpText.toLowerCase());
    case "endsWith":
      return text.toLowerCase().endsWith(cmpText.toLowerCase());

    case "gt": {
      const a = toNumber(v);
      const b = fieldMatch ? cmpNum : toNumber(lit);
      if (a === null || b === null) return false;
      return a > b;
    }
    case "lt": {
      const a = toNumber(v);
      const b = fieldMatch ? cmpNum : toNumber(lit);
      if (a === null || b === null) return false;
      return a < b;
    }
    case "gte": {
      const a = toNumber(v);
      const b = fieldMatch ? cmpNum : toNumber(lit);
      if (a === null || b === null) return false;
      return a >= b;
    }
    case "lte": {
      const a = toNumber(v);
      const b = fieldMatch ? cmpNum : toNumber(lit);
      if (a === null || b === null) return false;
      return a <= b;
    }

    case "isAnyOf": {
      if (fieldMatch) {
        // 匹配字段：目标值（含数组任一元素）与本表字段值相等
        const target = toComparableText(v);
        const items = splitMulti(fText);
        if (items.length === 0) return false;
        if (Array.isArray(v)) return arrayContainsAny(v, [fText]);
        return items.includes(target) || target === fText;
      }
      const items = splitMulti(lit);
      if (items.length === 0) return false;
      if (Array.isArray(v)) return arrayContainsAny(v, items);
      return items.includes(text);
    }
    case "isNoneOf": {
      if (fieldMatch) {
        const target = toComparableText(v);
        const items = splitMulti(fText);
        if (items.length === 0) return true;
        if (Array.isArray(v)) return !arrayContainsAny(v, [fText]);
        return !(items.includes(target) || target === fText);
      }
      const items = splitMulti(lit);
      if (items.length === 0) return true;
      if (Array.isArray(v)) return !arrayContainsAny(v, items);
      return !items.includes(text);
    }

    default:
      return text === cmpText;
  }
}

/** 操作符是否需要比较值（与 filters.operatorNeedsValue 同构，filter.ts 不反向依赖 filters.ts 的运行时函数） */
function operatorNeedsValueFor(op: string): boolean {
  return !["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(op);
}

export function evalFilter(
  node: FilterNode | null | undefined,
  get: (fieldId: string) => RawValue,
  getSelf?: (fieldId: string) => RawValue,
  ctx?: FilterEvalContext,
): boolean {
  if (!node) return true;
  // fail-closed 顶层短路：树引用 currentUser 而当前无登录用户（未登录 / 分享外链 / 空 userId）
  // 时，整棵过滤恒 false。必须在树顶层判定而非叶子，否则叶子可能被 NOT 包裹，!(false)=true
  // 会放开全表（见 filters.filterReferencesCurrentUser 注释）。
  if (filterReferencesCurrentUser(node) && !(ctx?.vars?.currentUserId ?? null)) {
    return false;
  }
  // 防御：脏 FilterNode（缺 children/child/未知 kind）按「无约束」处理，
  // 不抛 TypeError —— 一个坏视图配置不应炸掉整张表的列表/详情（历史 bug）。
  switch (node.kind) {
    case "and": {
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length === 0) return true;
      return children.every((c) => evalFilter(c, get, getSelf, ctx));
    }
    case "or": {
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length === 0) return true;
      return children.some((c) => evalFilter(c, get, getSelf, ctx));
    }
    case "not":
      if (!node.child) return true;
      return !evalFilter(node.child, get, getSelf, ctx);
    case "condition":
      return evalCondition(node, get, getSelf, ctx);
    case "formula": {
      const expression = node.expression;
      // 空表达式（含纯空白）视为「无筛选」
      if (typeof expression !== "string" || expression.trim() === "") return true;
      const fn = ctx?.evalFormula;
      // 未注入公式求值器（前端预览 / 未接线路径）：fail-closed 不放行
      if (typeof fn !== "function") return false;
      try {
        const result = fn(expression);
        // 严格布尔：truthy（数值 1 / 非空字符串）不等于命中，非布尔一律 false
        return result === true;
      } catch {
        // 公式解析 / 求值异常：fail-closed
        return false;
      }
    }
    default:
      return true;
  }
}

/** 全文搜索：所有「可文本化」字段逐一 contains（不区分大小写） */
export function matchesSearch(values: RawValue[], keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (kw === "") return true;
  return values.some((v) => toComparableText(v).toLowerCase().includes(kw));
}
