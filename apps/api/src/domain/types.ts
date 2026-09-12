// apps/api/src/domain/types.ts
// domain 层核心类型（不依赖 Prisma，便于单测注入）

export type FieldType =
  | "singleLineText"
  | "longText"
  | "richText"
  | "number"
  | "currency"
  | "percent"
  | "duration"
  | "date"
  | "datetime"
  | "checkbox"
  | "singleSelect"
  | "multiSelect"
  | "email"
  | "url"
  | "phone"
  | "rating"
  | "autoNumber"
  | "json"
  | "attachment"
  | "links"
  | "lookup"
  | "rollup"
  | "count"
  | "formula"
  | "tabs"
  | "subtable"
  | "createdTime"
  | "lastModifiedTime"
  | "createdBy"
  | "lastModifiedBy";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

/** tabs 字段内单个分组（与 shared-types 同构） */
export interface TabLayoutItem {
  fieldId: string;
  widthPct: 25 | 50 | 75 | 100;
}
export interface TabLayoutRow {
  items: TabLayoutItem[];
}
export interface TabConfig {
  id: string;
  name: string;
  fieldIds: string[];
  widths?: Record<string, 25 | 50 | 75 | 100>;
  rows?: TabLayoutRow[];
}

export interface FieldMeta {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  description: string;
  order: number;
  required: boolean;
  unique: boolean;


  options: SelectOption[] | null;
  precision: number | null;

  // 单行文本最大字数（null 不限制）
  maxLength: number | null;
  // 日期/日期时间：新建记录默认填当前时间
  defaultNow: boolean;

  // Rollup/Lookup/Count 的子集筛选条件
  recordFilter: unknown | null;

  linkFieldId: string | null;
  relatedTableId: string | null;
  relationKind: "mm" | "hm" | "bt" | null;
  isReverse: boolean;
  reverseFieldId: string | null;
  linkDisplayFieldId: string | null;

  lookupFieldId: string | null;
  rollupFunction: "sum" | "avg" | "min" | "max" | "count" | null;

  formula: string | null;

  // tabs 字段分组容器（仅 type=tabs）
  tabsConfig: TabConfig[] | null;

  // subtable 显示字段列表（仅 type=subtable，标识子表格展示哪些对面表字段）
  displayedFieldIds: string[] | null;

  // subtable「选择数据」弹窗可见字段列表（仅 type=subtable，与 displayedFieldIds 独立）
  visibleFieldIds: string[] | null;

  // 字段默认内容配置（static/lookup/formula 三态）；null = 无默认内容
  defaultConfig: unknown | null;

  // 自动编号规则（仅 type=autoNumber）；null = 保持序号现算
  numberRule: unknown | null;
}

export interface LinkRef {
  tableId: string;
  recordId: string;
  title: string;
}

export interface AttachmentValue {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
}

export type FieldValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | LinkRef[]
  | AttachmentValue[]
  | unknown[]
  | Record<string, unknown>;

export interface RawRecord {
  id: string;
  tableId: string;
  /** 可能是 JSON 字符串（来自 Prisma String 列）也可能是已解析对象 */
  fields: unknown;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface HydratedRecord {
  id: string;
  tableId: string;
  /** 物理字段 + 计算字段 平铺，key = fieldId */
  fields: Record<string, FieldValue>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

const SYSTEM_TYPES = new Set<FieldType>(["createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"]);
// subtable 在存储层与 links 完全一致（同一张 link_row 表、双向字段配对，值 hydration 现算、不落 records.fields），
// 必须计入 computed 集合，否则任何依赖 isComputedFieldType 过滤的写入/导入路径都会把关联 id 当物理值写进 fields JSON。
const COMPUTED_TYPES = new Set<FieldType>(["lookup", "rollup", "count", "formula", "links", "subtable"]);

export function isSystemFieldType(t: string): boolean {
  return SYSTEM_TYPES.has(t as FieldType);
}

export function isComputedFieldType(t: string): boolean {
  return COMPUTED_TYPES.has(t as FieldType);
}

/** 该字段类型是否真的把值存在 records.fields 里 */
export function isPhysicalFieldType(t: string): boolean {
  return !isComputedFieldType(t) && !isSystemFieldType(t) && t !== "autoNumber";
}

// ============ 显示格式化（v1 Shared/Formatters.swift TS 同构）============

export function formatCellValue(value: FieldValue, field: Pick<FieldMeta, "type" | "precision">): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "checkbox":
      return value ? "✓" : "";
    case "currency": {
      const n = Number(value);
      return Number.isFinite(n) ? `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "";
    }
    case "percent": {
      const n = Number(value);
      return Number.isFinite(n) ? `${n}%` : "";
    }
    case "number":
    case "rating":
    case "duration":
    case "rollup":
    case "count":
    case "autoNumber": {
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      const p = field.precision ?? 0;
      return p > 0 ? n.toFixed(p) : String(n);
    }
    case "date": {
      const s = String(value);
      return s.length >= 10 ? s.slice(0, 10) : s;
    }
    case "datetime":
    case "createdTime":
    case "lastModifiedTime": {
      const s = String(value);
      return s.replace("T", " ").slice(0, 16);
    }
    case "multiSelect":
      return Array.isArray(value) ? (value as string[]).join(", ") : String(value);
    case "links": {
      if (!Array.isArray(value)) return "";
      return (value as LinkRef[]).map((l) => l.title).join(", ");
    }
    case "attachment": {
      if (!Array.isArray(value)) return "";
      return (value as AttachmentValue[]).map((a) => a.name).join(", ");
    }
    default:
      return Array.isArray(value) ? (value as unknown[]).map((x) => String(x)).join(", ") : String(value);
  }
}
