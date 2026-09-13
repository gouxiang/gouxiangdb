// apps/api/src/domain/fieldIndex/policy.ts
// M1/S4 sidecar（record_field_index）的【纯函数】策略层：决定哪些物理字段入索引、
// 以及如何把 records.fields JSON 里的单个存储值抽成若干条 EAV entry。
//
// 完全无 DB / Prisma 依赖，可被单测、sync.ts、backfill/check 脚本共享同一口径。
// 与 shared-types/filter.ts 的值归一保持一致：
//   - 日期：date 存 'YYYY-MM-DD'、datetime 存 ISO-8601，用 Date.parse 得毫秒，
//     严格日期形态才解析，避免把普通数字/文本误当日期（同 filter DATE_LIKE）；
//   - 数字：Number(...) 有限才入 valueNum；
//   - 勾选：存 JSON boolean → 0/1；
//   - 单选/多选：存【选项 id】（optionId），multiSelect 摊平为多行（ord=i）。

import type { FieldMeta } from "../types.js";

/** 单条 sidecar 行（不含 recordId/tableId，由 sync 层补）。 */
export interface FieldIndexEntry {
  fieldId: string;
  valueText: string | null;
  valueNum: number | null;
  isNull: 0 | 1;
  /** multiSelect 摊平序号（0..n）；标量字段恒 0。 */
  ord: number;
}

/** 已扁平、带记录归属的完整 sidecar 行（sync 写库 / drift 对拍 / 脚本回填共用）。 */
export interface ExpectedSidecarRow extends FieldIndexEntry {
  recordId: string;
  tableId: string;
}

/** buildExpectedRows 的最小输入（Prisma 行 / better-sqlite3 行均可映射成此结构）。 */
export interface ExpectedRowsInput {
  fieldsMeta: Array<{ id: string; type: string }>;
  primaryFieldId: string;
  records: Array<{ id: string; tableId: string; fields: string }>;
}

// 文本等值/排序组。
// autoNumber 只入文本：resolveAutoNumber 产出的可能是带前缀拼接串（如 ORD-202609-0001），
// 非纯数字，故不进 valueNum（其数值比较局限属 S6 课题）。
const TEXT_TYPES = new Set<string>([
  "singleLineText",
  "email",
  "url",
  "phone",
  "autoNumber",
]);

// 数值组：统一入 valueNum（currency/percent/duration/rating 本质都是数值列；
// rating 在 shared type-groups/filters/formula 及前端均按数值处理，走 gt/lt 数值算子）。
const NUMERIC_TYPES = new Set<string>([
  "number",
  "currency",
  "percent",
  "duration",
  "rating",
]);

const DATE_TYPES = new Set<string>(["date", "datetime"]);

/**
 * sidecar 数值列判定（抽进 valueNum）。
 * 单独导出谓词（而非集合），供类型一致性守卫测试与 shared type-groups 的
 * number 分组全量对拍：任何一侧增删数值类型（如再发生 rating 漂移）测试即红。
 */
export function isNumericIndexType(t: string): boolean {
  return NUMERIC_TYPES.has(t);
}

// 严格日期形态（同 shared-types/filter.ts DATE_LIKE）。
const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// type 用宽松 string（= FieldType 超集）：FieldMeta 与 DB 读出的 {type:string} 行都可直接传入。
type IndexableFieldMeta = Pick<FieldMeta, "id" | "tableId"> & {
  type: string;
  /** 调用方需把表的 primaryFieldId 并入（主字段即便物理类型是 longText 也按文本索引）。 */
  isPrimary?: boolean;
};

/**
 * 该字段是否进 sidecar。
 * 入：文本组、主字段（任何非计算的物理类型）、数值/日期组、checkbox、单选/多选。
 * 排除：longText/richText/json 正文（除主字段）、attachment、links/subtable、
 *      lookup/rollup/count/formula、tabs、createdTime/lastModifiedTime/createdBy/
 *      lastModifiedBy（系统/计算字段不物化进 fields JSON）。
 */
export function isIndexedField(f: IndexableFieldMeta): boolean {
  const t = f.type;
  if (TEXT_TYPES.has(t)) return true;
  if (NUMERIC_TYPES.has(t)) return true;
  if (DATE_TYPES.has(t)) return true;
  if (t === "checkbox") return true;
  if (t === "singleSelect" || t === "multiSelect") return true;
  // 主字段即便落在 longText（标题列）也按文本等值/排序入索引。
  if (f.isPrimary && isPhysicalScalar(t)) return true;
  return false;
}

/** 非计算/非系统的物理标量（主字段兜底判断用；links/subtable 等不算标量）。 */
function isPhysicalScalar(t: string): boolean {
  if (t === "links" || t === "subtable") return false;
  if (["lookup", "rollup", "count", "formula", "tabs"].includes(t)) return false;
  if (["createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"].includes(t)) {
    return false;
  }
  return true;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function nullEntry(fieldId: string, ord = 0): FieldIndexEntry {
  return { fieldId, valueText: null, valueNum: null, isNull: 1, ord };
}

/** 从单选/多选元素里取 optionId：元素可能是裸 id 串，或 {id}/{recordId} 对象。 */
function optionIdOf(el: unknown): string | null {
  if (el === null || el === undefined) return null;
  if (typeof el === "string") return el === "" ? null : el;
  if (typeof el === "object") {
    const o = el as Record<string, unknown>;
    const id = o.id ?? o.recordId ?? o.optionId;
    return typeof id === "string" && id !== "" ? id : null;
  }
  return String(el);
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const t = String(v);
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  if (DATE_LIKE.test(t)) {
    const ts = Date.parse(t);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/**
 * 把一个字段的存储值抽成 entries（标量 1 条；multiSelect 每选项 1 条）。
 * 约定：调用方已用 isIndexedField 过滤；未被索引的类型在此返回 []（防御性）。
 */
export function extractEntries(f: IndexableFieldMeta, stored: unknown): FieldIndexEntry[] {
  const t = f.type;
  const fieldId = f.id;

  // ---- 多选：数组摊平多行（valueText=optionId, ord=i）----
  if (t === "multiSelect") {
    if (!Array.isArray(stored) || stored.length === 0) return [nullEntry(fieldId)];
    const rows: FieldIndexEntry[] = [];
    stored.forEach((el, i) => {
      const id = optionIdOf(el);
      if (id) rows.push({ fieldId, valueText: id, valueNum: null, isNull: 0, ord: i });
    });
    return rows.length > 0 ? rows : [nullEntry(fieldId)];
  }

  // ---- 单选：单行（valueText=optionId）----
  if (t === "singleSelect") {
    if (isEmpty(stored)) return [nullEntry(fieldId)];
    const id = optionIdOf(stored);
    return [id ? { fieldId, valueText: id, valueNum: null, isNull: 0, ord: 0 } : nullEntry(fieldId)];
  }

  // ---- 勾选：JSON boolean → 0/1 ----
  if (t === "checkbox") {
    if (stored === null || stored === undefined || stored === "") return [nullEntry(fieldId)];
    return [{ fieldId, valueText: null, valueNum: stored ? 1 : 0, isNull: 0, ord: 0 }];
  }

  // ---- 数值组 ----
  if (NUMERIC_TYPES.has(t)) {
    if (isEmpty(stored)) return [nullEntry(fieldId)];
    const num = toNumber(stored);
    // 值非空（isNull=0）但无法转数时 valueNum=null：数值范围谓词不命中，
    // 原始串留 valueText 供 eq 严格文本回退（库存 "123" vs 123 的现状语义）。
    return [{ fieldId, valueText: String(stored), valueNum: num, isNull: 0, ord: 0 }];
  }

  // ---- 日期组：valueNum=毫秒（Date.parse，同 filter），valueText 存原始串 ----
  if (DATE_TYPES.has(t)) {
    if (isEmpty(stored)) return [nullEntry(fieldId)];
    const raw = String(stored);
    const num = DATE_LIKE.test(raw) ? Date.parse(raw) : toNumber(stored);
    return [{ fieldId, valueText: raw, valueNum: Number.isFinite(num) ? num : null, isNull: 0, ord: 0 }];
  }

  // ---- 文本组（含主字段兜底）----
  if (TEXT_TYPES.has(t) || (f.isPrimary && isPhysicalScalar(t))) {
    if (isEmpty(stored)) return [nullEntry(fieldId)];
    return [{ fieldId, valueText: String(stored), valueNum: null, isNull: 0, ord: 0 }];
  }

  return [];
}

/** 安全解析记录 fields JSON（损坏/空 → {}），sync 与脚本共用。 */
export function parseRecordFields(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 由表字段元数据 + 记录行，纯计算出【期望的】全部 sidecar 行。
 * 这是 sync 写库、backfill 回填、check drift 对拍的单一事实源，
 * 保证三处对「一条记录应有哪些 sidecar 行」口径完全一致。
 */
export function buildExpectedRows(input: ExpectedRowsInput): ExpectedSidecarRow[] {
  const out: ExpectedSidecarRow[] = [];
  for (const rec of input.records) {
    const stored = parseRecordFields(rec.fields);
    for (const f of input.fieldsMeta) {
      const m = { id: f.id, type: f.type, tableId: rec.tableId, isPrimary: f.id === input.primaryFieldId };
      if (!isIndexedField(m)) continue;
      for (const e of extractEntries(m, stored[f.id] ?? null)) {
        out.push({ recordId: rec.id, tableId: rec.tableId, ...e });
      }
    }
  }
  return out;
}
