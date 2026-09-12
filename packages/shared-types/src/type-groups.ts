// packages/shared-types/src/type-groups.ts
// 字段类型分组与兼容判定（前后端单一真源）
// 用于：默认内容关联取值、lookup 查阅、rollup 聚合、筛选「匹配字段」、子表格结构兼容等
// 所有"字段 A 的值能否落到/比较字段 B"的判断都必须走这里，杜绝跨类型关联呈现 bug。

import type { FieldType } from "./fields.js";

/** 类型分组：同组字段的值可互相赋值/比较 */
export type FieldTypeGroup =
  | "text" // 文本类（值是字符串）
  | "number" // 数值类（值是 number）
  | "date" // 日期时间类（值是时间戳/日期串）
  | "bool" // 布尔
  | "select" // 选项（值是 option id / id[]，不与 text 互通）
  | "link" // 关联/计算引用类（LinkRef[] / 聚合值，不作标量取值源）
  | "attachment" // 附件
  | "container"; // 纯容器（tabs，无值）

const TEXT_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "singleLineText",
  "longText",
  "richText",
  "email",
  "url",
  "phone",
  "json",
  "autoNumber",
  "createdBy",
  "lastModifiedBy",
]);

const NUMBER_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "number",
  "currency",
  "percent",
  "duration",
  "rating",
]);

const DATE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "date",
  "datetime",
  "createdTime",
  "lastModifiedTime",
]);

const SELECT_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "singleSelect",
  "multiSelect",
]);

const LINK_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "links",
  "lookup",
  "rollup",
  "count",
  "subtable",
]);

/** 字段类型 → 分组 */
export function fieldTypeGroup(t: FieldType): FieldTypeGroup {
  if (TEXT_TYPES.has(t)) return "text";
  if (NUMBER_TYPES.has(t)) return "number";
  if (DATE_TYPES.has(t)) return "date";
  if (SELECT_TYPES.has(t)) return "select";
  if (t === "checkbox") return "bool";
  if (LINK_TYPES.has(t)) return "link";
  if (t === "attachment") return "attachment";
  return "container"; // tabs / formula 等无固定组
}

/**
 * 源字段类型的值能否赋给目标字段（默认内容 lookup / lookup 查阅取值）。
 * 规则：
 *  - 同组兼容；
 *  - select 组不与 text 组互通（选项存 option id，跨组会显示 id 而非名称）；
 *  - link / attachment / container 组不能作为标量取值源；
 *  - formula 字段按其产出动态判定（由调用方用 formula 字段的实际配置判断，这里保守不允许直接作为源）。
 */
export function isTypeAssignable(target: FieldType, source: FieldType): boolean {
  const tg = fieldTypeGroup(target);
  const sg = fieldTypeGroup(source);
  if (sg === "link" || sg === "attachment" || sg === "container") return false;
  if (tg === "link" || tg === "attachment" || tg === "container") return false;
  if (tg !== sg) return false;
  // 选项组内：单选存 option id 标量、多选存 id[] 数组，结构不同不可互赋
  if (tg === "select") return target === source;
  return true;
}

/**
 * 筛选「匹配字段」：对面表字段与本表字段两边值是否可比较。
 * 要求同组；bool/date/select 组尤其严格（跨组比较无意义）。
 */
export function isTypeComparable(a: FieldType, b: FieldType): boolean {
  const ag = fieldTypeGroup(a);
  const bg = fieldTypeGroup(b);
  if (ag === "link" || ag === "attachment" || ag === "container") return false;
  if (bg === "link" || bg === "attachment" || bg === "container") return false;
  if (ag !== bg) return false;
  // 单选标量 vs 多选数组：比较语义不同，仅同类型可比
  if (ag === "select") return a === b;
  return true;
}

/** rollup 数字型聚合函数（sum/avg/min/max）要求源字段为数值组 */
export function isNumericAggCapable(t: FieldType): boolean {
  return fieldTypeGroup(t) === "number";
}

export interface RollupFnOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * rollup 聚合函数选项：按源字段类型禁用不兼容项。
 * 求和/平均仅数值类；最小/最大支持数值与日期类；计数任意类型。
 */
export function rollupAggOptions(sourceType: FieldType | string | null | undefined): RollupFnOption[] {
  const g = sourceType ? fieldTypeGroup(sourceType as FieldType) : undefined;
  const numericOnly = g !== undefined && g !== "number";
  const minmaxOk = g === undefined || g === "number" || g === "date";
  return [
    { value: "sum", label: "求和 sum", disabled: numericOnly },
    { value: "avg", label: "平均 avg", disabled: numericOnly },
    { value: "min", label: "最小 min", disabled: !minmaxOk },
    { value: "max", label: "最大 max", disabled: !minmaxOk },
    { value: "count", label: "计数 count（任意类型）", disabled: false },
  ];
}

/** 分组人类可读名（用于下拉 optgroup 标签） */
export const FIELD_GROUP_LABEL: Record<FieldTypeGroup, string> = {
  text: "文本类",
  number: "数值类",
  date: "日期时间类",
  bool: "布尔",
  select: "选项类",
  link: "关联/计算类",
  attachment: "附件",
  container: "容器",
};

/**
 * 子表格整表抓取的结构兼容性判定。
 * 源表（模板表）与子表格实际关联目标表之间按「同名字段」克隆：
 *  - 至少存在 1 个同名且类型兼容（isTypeAssignable）的字段；
 *  - 返回不兼容/缺失信息用于提示。
 * 只比对物理可写字段（跳过计算/系统/容器/关联类）。
 */
export interface FieldShape {
  name: string;
  type: FieldType;
}

export interface SubtableCompatResult {
  ok: boolean;
  /** 可克隆的同名字段名 */
  compatible: string[];
  /** 源表有、目标表缺失同名字段（将被忽略） */
  missingInTarget: string[];
  /** 同名但类型不兼容（将被忽略） */
  typeMismatch: { name: string; sourceType: FieldType; targetType: FieldType }[];
}

export function checkSubtableCompatibility(
  sourceFields: FieldShape[],
  targetFields: FieldShape[],
): SubtableCompatResult {
  const targetByName = new Map<string, FieldType>();
  for (const f of targetFields) targetByName.set(f.name.trim(), f.type);

  const compatible: string[] = [];
  const missingInTarget: string[] = [];
  const typeMismatch: SubtableCompatResult["typeMismatch"] = [];

  for (const sf of sourceFields) {
    const name = sf.name.trim();
    const tt = targetByName.get(name);
    if (tt === undefined) {
      missingInTarget.push(name);
      continue;
    }
    // 克隆只写物理标量字段；关联/计算/系统/容器字段在克隆时本就跳过，这里不算不兼容
    const sg = fieldTypeGroup(sf.type);
    if (sg === "link" || sg === "attachment" || sg === "container") continue;
    if (isTypeAssignable(tt, sf.type)) {
      compatible.push(name);
    } else {
      typeMismatch.push({ name, sourceType: sf.type, targetType: tt });
    }
  }

  return {
    ok: compatible.length > 0,
    compatible,
    missingInTarget,
    typeMismatch,
  };
}
