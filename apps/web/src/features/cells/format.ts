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

// 右对齐 + 等宽数字的字段类型（参考图：数值/工时/金额类列右对齐，表头同侧）
export const RIGHT_ALIGN_TYPES = new Set([
  "number",
  "currency",
  "percent",
  "duration", // 工时（参考图「预估工时」16h/8h/40h 右对齐）
  "count",
  "rollup",
  "autoNumber",
]);

/** 空单元格统一占位（弱色），参考图口径：不显示空白、不显示 raw 值。 */
export const EMPTY_CELL_TEXT = "—";

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

/**
 * 优先级列识别（参考图：优先级是**纯文字带色**，状态才是胶囊）。
 * 判定走两条路，避免只认字段名漏掉用户改名过的列：
 *   ① 字段名命中「优先级 / priority / prio」；
 *   ② 选项集整体落在优先级词表内（别名列也能命中）。
 */
const PRIORITY_FIELD_NAME = /优先级|priority|prio/i;
/** 高（红 / danger） */
const PRIORITY_HIGH = new Set(["高", "最高", "紧急", "很急", "p0"]);
/** 中（橙 / warning） */
const PRIORITY_MID = new Set(["中", "普通", "正常", "常规", "p1", "p2"]);
/** 低（灰 / hint） */
const PRIORITY_LOW = new Set(["低", "最低", "较低", "次要", "p3"]);
const PRIORITY_VOCAB = new Set([...PRIORITY_HIGH, ...PRIORITY_MID, ...PRIORITY_LOW]);

export function isPriorityField(field: FieldDTO): boolean {
  if (PRIORITY_FIELD_NAME.test(field.name ?? "")) return true;
  const opts = field.options ?? [];
  if (opts.length === 0) return false;
  return opts.every((o) => PRIORITY_VOCAB.has(String(o.name ?? "").trim().toLowerCase()));
}

/** 优先级文字色（gx-* 令牌，不新造色）：高=红 / 中=橙 / 低=灰，未命中走主文本色。 */
export function priorityTextClass(name: string): string {
  const key = String(name ?? "").trim().toLowerCase();
  if (PRIORITY_HIGH.has(key)) return "text-gx-danger";
  if (PRIORITY_MID.has(key)) return "text-gx-warning";
  if (PRIORITY_LOW.has(key)) return "text-gx-text-hint";
  return "text-gx-text-primary";
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
  // Date 直通：fmtDateTime 内部会拿解析结果回喂 fmtDate，缺少这一支会让日期段
  // 静默变成空串（历史缺陷：datetime 字段只显示「 13:38」，日期段被吞掉）。
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
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

/**
 * 日期时间显示口径：YYYY-MM-DD HH:mm:ss（含秒）。
 *
 * 为什么必须带秒：系统字段（createdTime/lastModifiedTime）与公式 NOW() 存的是
 * UTC ISO 串（如 2026-10-02T13:38:39.086Z），秒是真实数据的一部分。此前截到分钟，
 * 同一秒内创建的记录在界面上无法区分，用户会以为数据被改过。
 */
function fmtDateTime(value: unknown): string {
  const d = toDate(value);
  if (!d) return "";
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "2026-10-02T13:38" 的长度——带 T 的最短时间形态，短于此不可能是时间。 */
const ISO_DATETIME_MIN_LEN = 16;
/** 时间形态必须是 YYYY-MM-DDTHH:mm 开头（后续可跟 :ss / .mmm / Z / ±HH:mm）。 */
const ISO_DATETIME_HEAD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * 值是否长得像 ISO 时间串（相对「纯日期」而言）。
 *
 * 用途：formula / lookup 这类字段没有自己的日期口径（后端给什么就存什么），
 * 取当前时间的公式（NOW()）会返回 `new Date().toISOString()`，直接 String() 出来
 * 是 `2026-10-02T13:38:39.086Z`，人读不了。识别后走 fmtDateTime 格式化。
 *
 * 判定刻意保守（宁可不格式化，也不能把普通文本误判成时间）：
 *   ① 只认字符串（数字时间戳/布尔/数组一律 false）；
 *   ② 长度 ≥16 且含 "T"——纯日期 "2026-10-02" 长度 10，必须排除；
 *   ③ 头部匹配 YYYY-MM-DDTHH:mm；
 *   ④ new Date() 解析有效（挡掉 "2026-13-45T99:99" 这类形似而非法的值）。
 */
export function isIsoDatetimeLike(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length < ISO_DATETIME_MIN_LEN) return false;
  if (!s.includes("T")) return false;
  if (!ISO_DATETIME_HEAD.test(s)) return false;
  return toDate(s) !== null;
}

/** 千分位 + 指定小数位格式化的数字 */
function fmtNumber(num: number, decimals: number): string {
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * 千分位但**不补位、不截断**：数字的自然形式。
 * -3.5 → "-3.5"，42 → "42"，1234567.25 → "1,234,567.25"。
 * maximumFractionDigits 取上限 20（JS 允许的最大值），即不对 JS Number 自带的
 * 有效数字做任何人为截位。
 */
function fmtNumberNatural(num: number): string {
  return num.toLocaleString("en-US", { maximumFractionDigits: 20 });
}

/**
 * 数值显示口径（number/rating/duration/percent 共用）：
 *   - precision 为数字（含 0）→ 按该精度补位/截位，行为与改造前一致；
 *   - precision 为 null/undefined（用户没配精度）→ 按数字自然形式展示。
 *
 * 为什么不能把 null 兜底成 0：字段没配精度时存 -3.5 会显示成 -4，而后端实存的
 * 就是 -3.5，用户会以为自己存的数被改了（显示层取整，非存储问题）。
 */
function fmtPrecision(num: number, precision: number | null | undefined): string {
  if (precision == null || !Number.isFinite(precision)) return fmtNumberNatural(num);
  return fmtNumber(num, precision);
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
      // 阶段 3：不再返回对勾字符（U+2713）当状态图标——
      // ① 它是数据/导出口径（CSV 导出走本函数），而后端导入强制转换只认
      //    "true"/"1"/"是"/"TRUE"（apps/api/src/domain/csv.ts:190），对勾会被解析成 false，
      //    导出再导入必然丢勾；改为 "true" 后导出 → 导入闭环正确。
      // ② 界面上的复选框从不走这里：CellRenderer 的 checkbox 分支渲染的是
      //    <Icon name="check" />（见 CellRenderer.tsx:81-91），状态另有图标，不靠字符符号。
      // ③ 后端公式 CONCAT 里的对勾字符属服务端文本口径（domain/types.ts:179），本次不改后端。
      return value ? "true" : "";

    case "currency": {
      const num = Number(value);
      if (isNaN(num)) return String(value);
      return `¥${fmtNumber(num, 2)}`;
    }

    case "percent": {
      const num = Number(value);
      if (isNaN(num)) return String(value);
      return `${fmtPrecision(num, field.precision)}%`;
    }

    case "number":
    case "rating":
    case "duration": {
      const num = Number(value);
      if (isNaN(num)) return "";
      return fmtPrecision(num, field.precision);
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

    // 公式 / 查阅：这两个类型没有自己的日期口径——后端算什么就存什么。
    // 取当前时间的公式（NOW()，apps/api/src/domain/formula.ts）返回 toISOString()，
    // 落到 default 会把 `2026-10-02T13:38:39.086Z` 整串直出；查阅字段从关联记录
    // 带回日期时同理。这里只按形态识别后走时间格式化，其余值一字不动地原样返回。
    case "formula":
    case "lookup":
      return isIsoDatetimeLike(value) ? fmtDateTime(value) : String(value);

    default:
      return String(value);
  }
}

export { fmtDate, fmtDateTime, toDate };
