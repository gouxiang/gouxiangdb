// packages/shared-types/src/defaults.ts
// 字段「默认内容」与「自动编号规则」类型定义（前后端共用）
//
// 默认内容三态：
//   static  —— 自定义固定值，创建时填入，之后不重算
//   lookup  —— 关联已有数据（静态抓取）：按筛选从源表取唯一匹配值，仅匹配字段变化时重抓
//   formula —— 公式计算（静态）：仅本表标量字段，编辑期本表依赖字段变化时重算

import type { FilterNode } from "./filters.js";
import type { FieldType } from "./fields.js";
import type { FieldIdT, TableIdT } from "./ids.js";

// ============ 默认内容 ============

export type DefaultConfig =
  | { mode: "static"; value: unknown }
  | {
      mode: "lookup";
      /** 抓取的数据源表 */
      sourceTableId: TableIdT;
      /** 筛选条件（可含 valueType=field 的匹配字段，引用本表字段） */
      filter: FilterNode | null;
      /** 从命中记录取哪个字段的值；null = 源表主字段 */
      valueFieldId: FieldIdT | null;
    }
  | { mode: "formula"; formula: string };

// 各字段类型支持的默认来源（需求一/二/三/五）
export type DefaultSourceKind = "static" | "lookup" | "formula";

const TEXT_TYPES: FieldType[] = [
  "singleLineText", "longText", "email", "url", "phone", "json",
];
const NUMBER_TYPES: FieldType[] = [
  "number", "currency", "percent", "duration", "rating",
];
const SELECT_TYPES: FieldType[] = ["singleSelect", "multiSelect"];
// richText 单独处理：支持 static + lookup，不支持 formula（需求二）

/** 该字段类型允许的默认来源（按需求：选项/富文本无 formula；子表格仅 lookup；关联/公式/选项卡/聚合/计数/查阅/系统无） */
export function allowedDefaultSources(type: FieldType): DefaultSourceKind[] {
  if (TEXT_TYPES.includes(type) || NUMBER_TYPES.includes(type) || type === "checkbox") {
    return ["static", "lookup", "formula"];
  }
  if (SELECT_TYPES.includes(type) || type === "richText") {
    // 单选/多选/富文本：自定义 + 关联抓取，不支持公式
    return ["static", "lookup"];
  }
  if (type === "subtable") {
    // 子表格：仅关联已有数据（整表抓取模板）
    return ["lookup"];
  }
  // 关联/公式/选项卡/聚合/计数/查阅/系统/日期（日期用 defaultNow）等：无默认内容三态
  return [];
}

export function hasDefaultConfig(type: FieldType): boolean {
  return allowedDefaultSources(type).length > 0;
}

// ============ 自动编号规则 ============

export type TimeFormat = "yyyy" | "yyyyMM" | "yyyyMMdd";

export type CounterReset = "never" | "year" | "month" | "day" | "field";

export type NumberSegment =
  | { type: "fixed"; text: string }
  | { type: "time"; format: TimeFormat }
  | { type: "field"; fieldId: FieldIdT }
  | {
      type: "counter";
      /** 补零位数（如 3 → 001） */
      digits: number;
      reset: CounterReset;
      /** reset=field 时，按该字段值分组计数 */
      resetFieldId?: FieldIdT;
    };

export interface NumberRule {
  segments: NumberSegment[];
}

/** 编号规则是否为空（无片段或仅有空固定字符） */
export function isNumberRuleEmpty(rule: NumberRule | null | undefined): boolean {
  if (!rule || !Array.isArray(rule.segments)) return true;
  return rule.segments.length === 0;
}
