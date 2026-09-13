// apps/api/src/domain/csv.ts
// CSV 导入导出（v1 Shared/CSVKit.swift TS 同构）
//
// 导出规则（对齐 v1）：
//   - 首行为字段标题
//   - links 字段导出为 title 用 "; " 连接
//   - multiSelect 用 "; " 连接
//   - 公式/rollup/count/lookup 导出「计算后的显示值」
//   - 字段包含 , " \n 时用双引号包裹，内部 " 转义为 ""
//
// 导入规则：
//   - 首行作表头（hasHeader=true）
//   - 自动推断列类型：纯数字→number；true/false→checkbox；ISO 日期→date；其余→singleLineText
//   - 未映射的列自动新建字段

import type { FieldMeta, FieldValue, HydratedRecord } from "./types.js";
import { formatCellValue } from "./types.js";

// ============ 解析 ============

/** RFC4180 CSV 解析（支持引号包裹、转义、CRLF） */
export function parseCSV(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  // 去掉 BOM
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    cell += c;
    i += 1;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

// ============ 生成 ============

function escapeCell(v: string): string {
  // CSV 公式注入防护：=、+、-、@（含前导制表符）开头的单元格会被 Excel/LibreOffice
  // 当公式执行，前导单引号将其强制为文本。必须在引号包裹前处理。
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCSV(headers: string[], rows: string[][]): string {
  const lines = [headers.map(escapeCell).join(","), ...rows.map((r) => r.map(escapeCell).join(","))];
  // BOM 让 Excel 正确识别 UTF-8 中文
  return "\uFEFF" + lines.join("\r\n");
}

/** 把 hydration 后的记录导出为 CSV 字符串 */
export function recordsToCSV(records: HydratedRecord[], fields: FieldMeta[]): string {
  const headers = fields.map((f) => f.name);
  const rows = records.map((r) => recordToRow(r, fields));
  return buildCSV(headers, rows);
}

/** 单条 hydrated 记录 → 一列列原始单元格字符串（未转义；拼入 buildCSV/escapeCell 完成 RC-04 防护）。 */
export function recordToRow(r: HydratedRecord, fields: FieldMeta[]): string[] {
  return fields.map((f) => {
    const v = r.fields[f.id];
    if (Array.isArray(v)) {
      // links → title；multiSelect → 值
      const parts = (v as unknown[]).map((x) =>
        typeof x === "object" && x !== null && "title" in (x as object)
          ? (x as { title: string }).title
          : String(x),
      );
      return parts.join("; ");
    }
    return formatCellValue((v ?? null) as FieldValue, f);
  });
}

/** 已转成原始字符串的一批行 → 仅拼数据行文本（不含表头，供分批导出逐批 flush；RC-04 在 escapeCell 保持）。 */
export function rowsToCSVBody(rows: string[][]): string {
  return rows.map((r) => r.map(escapeCell).join(",")).join("\r\n");
}

/** 表头行文本（含 BOM，仅首批调用一次）。 */
export function csvHeaderLine(fields: FieldMeta[]): string {
  return "\uFEFF" + fields.map((f) => f.name).map(escapeCell).join(",");
}

/** 记录导出为 TSV（便于粘贴到 Excel / 对比测试 diff） */
export function recordsToTSV(records: HydratedRecord[], fields: FieldMeta[]): string {
  const headers = fields.map((f) => f.name).join("\t");
  const rows = records.map((r) =>
    fields
      .map((f) => {
        const v = r.fields[f.id];
        const s = Array.isArray(v)
          ? (v as unknown[])
              .map((x) => (typeof x === "object" && x !== null && "title" in (x as object) ? (x as { title: string }).title : String(x)))
              .join("; ")
          : formatCellValue((v ?? null) as FieldValue, f);
        return s.replace(/[\t\n\r]/g, " ");
      })
      .join("\t"),
  );
  return [headers, ...rows].join("\n");
}

// ============ 类型推断 ============

export function inferFieldType(values: string[]): FieldMeta["type"] {
  const nonEmpty = values.filter((v) => v.trim() !== "");
  if (nonEmpty.length === 0) return "singleLineText";

  const isInt = nonEmpty.every((v) => /^-?\d+$/.test(v.trim()));
  if (isInt) return "number";

  const isNum = nonEmpty.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()));
  if (isNum) return "number";

  const lower = nonEmpty.map((v) => v.trim().toLowerCase());
  if (lower.every((v) => v === "true" || v === "false" || v === "是" || v === "否")) return "checkbox";

  const isDate = nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v.trim()));
  if (isDate) return "date";

  if (nonEmpty.every((v) => v.includes("@") && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()))) return "email";

  return "singleLineText";
}

/** 把 CSV 单元格文本转成对应字段类型的强类型值 */
export function coerceCellValue(raw: string, type: FieldMeta["type"]): FieldValue {
  const v = raw.trim();
  if (v === "") return null;
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autoNumber": {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return v === "true" || v === "1" || v === "是" || v === "TRUE";
    case "multiSelect":
      return v
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    case "json":
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        return null;
      }
    default:
      return v;
  }
}
