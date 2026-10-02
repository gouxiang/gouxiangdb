// apps/api/src/domain/recordChanges/diff.ts
// 记录字段级 diff 的**纯函数**层（零 IO、零 Prisma 依赖，可表驱动单测）。
//
// 为什么用 before/after 全集比对而不是「用传入的 patch」：patch 只是本次 payload 出现的键，
// 而真正落库的值未必等于 patch —— links/subtable 走 link_row 而非 fields JSON、
// required/maxLength 校验可能整单拒绝、defaults 补偿写是另一条路径。只有拿写前/写后两份
// 完整 fields 比对，才算得出「数据库里真的变了什么」，不会记出一行与事实不符的日志。
//
// applyFieldWrites 里 before/after 本来就在内存（写前 findUnique、写后 merge），
// 故本函数零额外 IO。

import { isComputedFieldType, isSystemFieldType } from "../types.js";
import type { FieldChange, RecordChangeOp } from "./types.js";

/** diff 需要的最小字段信息（id 用于取值、name 落快照、type 用于跳过计算列）。 */
export interface DiffFieldLike {
  id: string;
  name: string;
  type?: string;
}

export interface DiffRecordFieldsInput {
  op: RecordChangeOp;
  /** 写入【前】的完整 fields（全量，不是 patch）。 */
  beforeFields: Record<string, unknown>;
  /** 写入【后】的完整 fields（全量）。 */
  afterFields: Record<string, unknown>;
  /** 字段定义全集（loadTableFields 结果即可，本函数只取 id/name/type）。 */
  fields: readonly DiffFieldLike[];
}

/** 空值统一口径：null / undefined / 空串 / 空数组都算「没有值」。 */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/**
 * 两个存储值是否等价（宽松：两侧都空即等价）。
 * 数组逐项比（顺序敏感 —— 多选的顺序是有语义的）；对象退化成 JSON 串比；
 * 其余严格相等。
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    if (aa.length !== bb.length) return false;
    return aa.every((x, i) => valuesEqual(x, bb[i]));
  }
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** 出参归一：空值一律 null（前端据此渲染「空」，不吐 undefined）。 */
function normalize(v: unknown): unknown {
  return isEmptyValue(v) ? null : v;
}

/**
 * 算出一次记录写的字段级前后值。
 *
 * - create：before 恒空，产出「所有本次落到非空值的字段」（初始快照）。
 * - update：只对真正变了的字段产出一条（宽松等价视为未变，避免噪声条目）。
 * - delete / restore：调用方不入本函数（两者的 changes 恒为 []）。
 *
 * 遍历顺序按 `fields` 定义顺序（不是 Object.keys），故同一份输入产出顺序恒定。
 */
export function diffRecordFields(input: DiffRecordFieldsInput): FieldChange[] {
  const { op, beforeFields, afterFields, fields } = input;
  const out: FieldChange[] = [];
  for (const f of fields) {
    // 计算列/系统列不记：它们的值由服务端算出，不是「人改的」，
    // 记进日志只会让「谁改了什么」失真。
    if (f.type && (isComputedFieldType(f.type) || isSystemFieldType(f.type))) continue;
    const before = beforeFields[f.id];
    const after = afterFields[f.id];
    if (op === "create") {
      if (isEmptyValue(after)) continue;
      out.push({ fieldId: f.id, fieldName: f.name, before: null, after: normalize(after) });
      continue;
    }
    if (valuesEqual(before, after)) continue;
    out.push({ fieldId: f.id, fieldName: f.name, before: normalize(before), after: normalize(after) });
  }
  return out;
}
