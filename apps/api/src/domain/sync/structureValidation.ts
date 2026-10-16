// YN7#788-C 结构变更对【服务端存量数据】的安全门（§19.3 场景 3 改字段类型、场景 5 改主字段）。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §19.3：
//   服务端接受任何结构 op 前都跑【现有】校验；改字段类型前先用录入校验/兼容转换检查存量数据是否
//   可转换，不可转换直接 rejected 并列出阻碍记录数/示例；改主字段须全表该字段非空。绝不让脏值静默
//   入库、绝不静默丢数据。
//
// 关键事实（2026-10 勘察）：
//   - 字段值存在 records.fields（JSON 串，按 fieldId 键），不是物理列，没有 ALTER COLUMN；
//     在线 PATCH /fields 刻意【不支持】改 type（UpdateFieldInput/buildFieldUpdateData 不含 type），
//     故 YN7 结构回放是第一条改 type 的路径，也没有任何存量迁移逻辑。
//   - 记录写入路径（applyFieldWrites）不按类型校验单元格值，仓库里没有「值能否转某类型」的纯函数。
//     本文件即为这一判定的单一事实源（保守、可单测、零 IO 的 canConvertStoredValue + 事务内扫描）。
//
// 安全策略（对真实数据零破坏、可回滚，见长期硬约束）：
//   - 类型 op 通过校验后【只改 field 行的 type 元数据】，不重写、不清空任何 records.fields 存量值；
//     读取/后续写入按新类型解释，旧配置列保留（利于回退，且 links 等危险方向已在类型白名单拒绝）。
//   - 有任一非空存量值无法安全转换 → 整个结构 op rejected，field 行不动、结构版本不推进。

import type { DbTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import type { FieldType, SelectOption } from "../types.js";
import { parseStoredFields } from "../recordWrite.js";

/** 拒绝原因码（落 sync_incoming.reasonCode，前端同步中心据此提示）。 */
export const RC_TYPE_CONVERSION_BLOCKED = "SYNC_TYPE_CONVERSION_BLOCKED";
export const RC_TYPE_CHANGE_UNSUPPORTED = "SYNC_TYPE_CHANGE_UNSUPPORTED";
export const RC_PRIMARY_FIELD_HAS_EMPTY = "SYNC_PRIMARY_FIELD_HAS_EMPTY";
/**
 * 结构 op 的目标在服务端已被（对方）软删（§19.3-2：我离线 rename 的字段被对方删了）。
 * 与 push.ts RC.ENTITY_DELETED 同值；registry 不能运行时 import push（会循环），故在此单点定义，
 * push.ts 回放据此归为【结构冲突】（可复合 restore_field+alter_field 解决），而非永久 rejected。
 */
export const RC_STRUCTURE_ENTITY_DELETED = "SYNC_ENTITY_DELETED";

/**
 * 允许通过 alter_field 改到的【物理标量】目标类型白名单。
 * 明确排除：关联/子表格（须成对创建）、lookup/rollup/count/formula/tabs（计算/容器）、attachment
 * （无法从标量造附件）、系统四件套（服务端自动维护）、member（值是用户 id，任意串无法映射到成员）、
 * autoNumber（编号由计数器生成）。只放行有明确无歧义值转换规则的标量类型。
 */
const CONVERTIBLE_SCALAR_TARGETS: ReadonlySet<FieldType> = new Set<FieldType>([
  "singleLineText", "longText", "richText",
  "number", "currency", "percent", "duration", "rating",
  "date", "datetime", "checkbox",
  "singleSelect", "multiSelect", "json", "email", "url", "phone",
]);

/** 同样只允许从物理标量字段改出（关联/计算/容器/附件/人员/自动编号/系统字段请新建字段，不在此转换）。 */
const NON_SCALAR_SOURCES: ReadonlySet<FieldType> = new Set<FieldType>([
  "links", "subtable", "lookup", "rollup", "count", "formula", "tabs",
  "attachment", "member", "autoNumber",
  "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy",
]);

/** 数值组（共享同一套「能否转成数字」判定）。 */
const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "number", "currency", "percent", "duration", "rating", "autoNumber",
]);
const TEXT_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "singleLineText", "longText", "richText", "email", "url", "phone",
]);
const CHECKBOX_TRUE = new Set(["true", "1", "是", "yes"]);
const CHECKBOX_FALSE = new Set(["false", "0", "否", "no"]);

/** 存量值是否为「空」：空值永远可转换（清空不阻碍类型变更），与录入 required 的空判定同口径。 */
export function isEmptyStoredValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function looksLikeDate(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v); // 时间戳数字
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(s)) return true;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

/** 截断示例值，避免 reasonDetail 塞入超长单元格内容。 */
function sampleValue(v: unknown): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > 20 ? `${s.slice(0, 20)}…` : s;
}

export interface ConvertCheck {
  ok: boolean;
  /** 不可转换时的中文原因（面向用户，单值层面，不含记录 id）。 */
  reason?: string;
}

/**
 * 判定【单个非空存量值】能否安全转换到目标类型。保守策略：只放行明确无歧义的转换，其余一律不可。
 * @param targetOptions 目标为 singleSelect/multiSelect 时的新选项集合（alter_field changed.options）。
 */
export function canConvertStoredValue(
  v: unknown,
  target: FieldType,
  targetOptions?: SelectOption[] | null,
): ConvertCheck {
  if (TEXT_TYPES.has(target)) {
    // 任意标量（串/数/布尔）都有明确无歧义的字符串形态；对象/数组不能压进文本单元格。
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { ok: true };
    return { ok: false, reason: "复杂内容（对象/数组）无法转为文本" };
  }
  if (NUMERIC_TYPES.has(target)) {
    if (typeof v === "number") return Number.isFinite(v) ? { ok: true } : { ok: false, reason: "数值不是有限数字" };
    if (typeof v === "boolean") return { ok: true, reason: undefined }; // true/false → 1/0
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) return { ok: true };
    return { ok: false, reason: `值「${sampleValue(v)}」不是合法数字` };
  }
  if (target === "checkbox") {
    if (typeof v === "boolean") return { ok: true };
    if (typeof v === "number" && (v === 0 || v === 1)) return { ok: true };
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (CHECKBOX_TRUE.has(s) || CHECKBOX_FALSE.has(s)) return { ok: true };
    }
    return { ok: false, reason: `值「${sampleValue(v)}」不是合法勾选值（是/否、true/false、1/0）` };
  }
  if (target === "date" || target === "datetime") {
    return looksLikeDate(v) ? { ok: true } : { ok: false, reason: `值「${sampleValue(v)}」不是合法日期` };
  }
  if (target === "singleSelect") {
    const ids = new Set((targetOptions ?? []).map((o) => o.id));
    if (typeof v === "string" && ids.has(v)) return { ok: true };
    return { ok: false, reason: `值「${sampleValue(v)}」不在新类型的选项内` };
  }
  if (target === "multiSelect") {
    if (!Array.isArray(v)) return { ok: false, reason: "原值不是多选项数组" };
    const ids = new Set((targetOptions ?? []).map((o) => o.id));
    const bad = v.find((x) => typeof x !== "string" || !ids.has(x));
    return bad === undefined
      ? { ok: true }
      : { ok: false, reason: "存在不在新类型选项内的多选项" };
  }
  if (target === "json") {
    // 任意普通 JSON 标量/对象/数组都可承载；仅函数等无法序列化的极端值不行（正常存量不会出现）。
    if (typeof v === "function" || typeof v === "symbol") return { ok: false, reason: "值无法序列化为 JSON" };
    return { ok: true };
  }
  if (target === "member") {
    // 人员值是用户 id 字符串（单选人员）；其它形态无法映射到具体成员。
    return typeof v === "string" && v.trim() !== ""
      ? { ok: true }
      : { ok: false, reason: "值不是有效的人员" };
  }
  // NON_CONVERTIBLE_TARGETS 在调用前已拦，这里兜底拒绝。
  return { ok: false, reason: `不支持改为 ${target} 类型` };
}

export interface ConversionBlockers {
  blockedCount: number;
  samples: { recordId: string; value: string; reason: string }[];
}

/** 扫描结果携带的示例上限。 */
const SAMPLE_LIMIT = 3;

/**
 * 事务内扫描该表全部【活记录】在 fieldId 上的非空存量值，统计无法转换到目标类型的阻碍项。
 * 只读，不修改任何数据；与 assertUniqueFullScan 同口径（findMany 活记录 + parseStoredFields）。
 */
export async function scanTypeConversionBlockersTx(
  tx: DbTx,
  tableId: string,
  fieldId: string,
  target: FieldType,
  targetOptions?: SelectOption[] | null,
): Promise<ConversionBlockers> {
  const rows = await tx.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true, fields: true },
  });
  const blockers: ConversionBlockers["samples"] = [];
  let blockedCount = 0;
  for (const r of rows) {
    const stored = parseStoredFields(r.fields);
    const v = stored[fieldId];
    if (isEmptyStoredValue(v)) continue;
    const check = canConvertStoredValue(v, target, targetOptions);
    if (!check.ok) {
      blockedCount += 1;
      if (blockers.length < SAMPLE_LIMIT) {
        blockers.push({ recordId: r.id, value: sampleValue(v), reason: check.reason ?? "不可转换" });
      }
    }
  }
  return { blockedCount, samples: blockers };
}

/**
 * 事务内校验：改主字段（primaryFieldId）时全表该字段非空（§19.3 场景 5，与在线同规则）。
 * 有空值即抛 422（结构 op rejected），带阻碍数与示例记录 id。
 */
export async function assertPrimaryFieldPopulatedTx(
  tx: DbTx,
  tableId: string,
  fieldId: string,
): Promise<void> {
  const rows = await tx.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true, fields: true },
  });
  const emptySamples: string[] = [];
  let emptyCount = 0;
  for (const r of rows) {
    const v = parseStoredFields(r.fields)[fieldId];
    if (isEmptyStoredValue(v)) {
      emptyCount += 1;
      if (emptySamples.length < SAMPLE_LIMIT) emptySamples.push(r.id);
    }
  }
  if (emptyCount > 0) {
    throw new HttpError(
      422,
      `有 ${emptyCount} 条记录的该字段为空，不能设为主字段（主字段必须每条记录都有值）；示例记录：${emptySamples.join("、")}`,
      RC_PRIMARY_FIELD_HAS_EMPTY,
    );
  }
}

/** 目标类型是否允许通过 alter_field 改成（必须是物理标量类型）。 */
export function isConvertibleTargetType(t: string): t is FieldType {
  return CONVERTIBLE_SCALAR_TARGETS.has(t as FieldType);
}

/** 来源字段类型是否允许参与类型转换（关联/计算/容器/附件/人员/自动编号/系统字段不转换，请新建字段）。 */
export function isConvertibleSourceType(t: string): t is FieldType {
  return !NON_SCALAR_SOURCES.has(t as FieldType);
}

/** 解析 alter_field changed.options（SelectOption[] 形态），非法形状返回 null。 */
export function parseSelectOptions(v: unknown): SelectOption[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is SelectOption =>
    !!x && typeof x === "object" && typeof (x as SelectOption).id === "string"
    && typeof (x as SelectOption).name === "string");
}

/** 把扫描到的阻碍归一带成一条 rejected HttpError（供 apply 内、写 field 行之前抛出）。 */
export function throwIfBlocked(b: ConversionBlockers, target: FieldType): void {
  if (b.blockedCount === 0) return;
  const sampleText = b.samples
    .map((s) => `记录 ${s.recordId}：${s.reason}`)
    .join("；");
  throw new HttpError(
    422,
    `改为「${target}」类型会导致 ${b.blockedCount} 条现有记录的值无法安全转换，已拒绝（不会改动任何数据）。例如：${sampleText}`,
    RC_TYPE_CONVERSION_BLOCKED,
  );
}
