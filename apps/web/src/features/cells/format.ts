// 单元格值格式化（纯函数，不依赖 React）
// 把任意 CellValue 按字段类型格式化为显示字符串，供 CellRenderer / 聚合 / 导出复用。

import type {
  CellValue,
  FieldDTO,
  SelectOption,
  LinkRefDTO,
  AttachmentDTO,
} from "@gx/shared-types";

// 计算字段（弱化文本色渲染，提示不可编辑）
export const COMPUTED_TYPES = new Set([
  "formula",
  "rollup",
  "count",
  "lookup",
  "autoNumber",
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
]);

// 右对齐 + 等宽数字的字段类型
export const RIGHT_ALIGN_TYPES = new Set([
  "number",
  "currency",
  "percent",
  "count",
  "rollup",
  "autoNumber",
]);

/** 判断单元格值是否为空（null / 空串 / 空数组 都算空） */
export function isEmptyValue(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 单元格文本对齐方向 */
export function cellTextAlign(field: FieldDTO): "left" | "right" {
  return RIGHT_ALIGN_TYPES.has(field.type) ? "right" : "left";
}

/** 字段是否只读（计算字段 / 系统字段不可由用户编辑） */
export function isReadOnlyField(field: FieldDTO): boolean {
  return COMPUTED_TYPES.has(field.type);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 把各种形态的日期值统一成 Date，解析失败返回 null */
function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    // 兼容 "2024-01-15" 与 ISO 字符串
    const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function fmtDate(value: unknown): string {
  const d = toDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDateTime(value: unknown): string {
  const d = toDate(value);
  if (!d) return "";
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 千分位 + 指定小数位格式化的数字 */
function fmtNumber(num: number, decimals: number): string {
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 从字段 options 中按 id 或 name 解析出选项对象 */
export function resolveSelectOption(
  field: FieldDTO,
  value: CellValue,
): SelectOption | null {
  const opts = field.options;
  if (!opts || opts.length === 0 || value == null) return null;
  if (typeof value === "string") {
    const byId = opts.find((o) => o.id === value);
    if (byId) return byId;
    const byName = opts.find((o) => o.name === value);
    if (byName) return byName;
  }
  return null;
}

function joinArray<T>(arr: T[], pick: (v: T) => string): string {
  return arr.map(pick).filter((s) => s !== "").join("、 ");
}

/**
 * 把单元格值格式化为显示字符串。
 * 规则严格对齐 NocoDB 中文版：货币千分位、百分比、日期格式等。
 */
export function formatCell(
  value: CellValue,
  field: FieldDTO,
  _opts?: { locale?: string },
): string {
  if (isEmptyValue(value)) return "";

  switch (field.type) {
    case "checkbox":
      return value ? "✓" : "";

    case "currency": {
      const num = Number(value);
      if (isNaN(num)) return String(value);
      return `¥${fmtNumber(num, 2)}`;
    }

    case "percent": {
      const num = Number(value);
      if (isNaN(num)) return String(value);
      return `${fmtNumber(num, field.precision ?? 0)}%`;
    }

    case "number":
    case "rating":
    case "duration": {
      const num = Number(value);
      if (isNaN(num)) return "";
      return fmtNumber(num, field.precision ?? 0);
    }

    case "date":
      return fmtDate(value);

    case "datetime":
    case "createdTime":
    case "lastModifiedTime":
      return fmtDateTime(value);

    case "singleSelect": {
      const opt = resolveSelectOption(field, value);
      return opt ? opt.name : String(value);
    }

    case "multiSelect": {
      if (!Array.isArray(value)) return String(value);
      return joinArray(value as CellValue[], (v) => {
        const opt = resolveSelectOption(field, v);
        return opt ? opt.name : String(v);
      });
    }

    case "links": {
      if (!Array.isArray(value)) return "";
      return joinArray(value as LinkRefDTO[], (l) => l.title ?? "");
    }

    case "attachment": {
      if (!Array.isArray(value)) return "";
      return joinArray(value as AttachmentDTO[], (a) => a.name ?? "");
    }

    case "json":
      return typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

    default:
      return String(value);
  }
}

export { fmtDate, fmtDateTime, toDate };
