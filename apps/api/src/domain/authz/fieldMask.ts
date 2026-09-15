// M4/S1 fieldMask 纯函数层：单源字段判定 + 多源并集最宽 capability + 记录投影 + 写键守卫。
//
// 纯域：无 Hono/guards/Prisma 依赖（不 import HttpError——守卫适配由 S3 路由层映射本域错误）。
// 语义（M4 计划 §4.3/§4.4，纯 allow 无 deny）：
//   - fieldMask 是命中 allow 之上的【收窄清单】，不是授权清单；缺省/null = 不裁剪（全字段）。
//   - 可见 = 任一 r 来源可见之并；可写 = 任一 c/u 来源在【该来源】下可见且非其只读。
//   - 并集只增不减：宽来源（不裁剪）与窄来源并存时全字段可见；管理员须收窄宽来源本身。

import type { FieldMask, ResourceAction } from "@gx/shared-types";
import type { ScopedPolicy } from "./types.js";

/** 域内拒绝错误（纯类；S3 适配层映射为 HTTP 403 + 机器码，引擎不 import Hono）。 */
export class AuthzFieldError extends Error {
  readonly status = 403;
  constructor(
    message: string,
    readonly code: "FORBIDDEN_FIELD",
    readonly fieldIds: string[],
  ) {
    super(message);
    this.name = "AuthzFieldError";
  }
}

function asStringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  return new Set(value.filter((v): v is string => typeof v === "string"));
}

/** 单源下字段是否可见：mask 为空/无 allowFields = 不裁剪；否则须在白名单内。 */
export function fieldVisibleInMask(mask: FieldMask | null, fieldId: string): boolean {
  if (!mask || mask.allowFields === undefined) return true;
  return (asStringSet(mask.allowFields) ?? new Set<string>()).has(fieldId);
}

/** 单源下字段是否可写：先须在该源可见，且不在该源只读清单内。 */
export function fieldWritableInMask(mask: FieldMask | null, fieldId: string): boolean {
  if (!fieldVisibleInMask(mask, fieldId)) return false;
  if (!mask || mask.readOnlyFields === undefined) return true;
  return !(asStringSet(mask.readOnlyFields) ?? new Set<string>()).has(fieldId);
}

const WRITE_ACTIONS: ReadonlySet<ResourceAction> = new Set(["c", "u"]);

/**
 * 多源并集后的字段能力。判定逐源（无歧义覆盖"无 allowFields 但有 readOnlyFields"档）：
 * - visible=false：无任何 r 来源（表级不可见，调用方应直接 403/剪枝，不做字段投影）；
 * - visibleAll：任一 r 来源不裁剪（全字段可见）；否则可见面为各源 allowFields 之并；
 * - writableAll：任一 c/u 来源对全字段放行（mask=null）；逐键可写仍以 canWriteField 为准。
 */
export interface FieldCapability {
  visible: boolean;
  visibleAll: boolean;
  /** 仅当所有 r 来源都给了 allowFields 时为枚举并集；存在宽来源时为 null（全可见）。 */
  visibleFields: Set<string> | null;
  writableAll: boolean;
  /** 实际参与判定的 r / c|u 来源（保留 mask 供逐源判定与 O8 解释）。 */
  readSources: readonly ScopedPolicy[];
  writeSources: readonly ScopedPolicy[];
}

export function fieldCapability(policies: readonly ScopedPolicy[]): FieldCapability {
  const readSources = policies.filter((p) => p.actions.includes("r"));
  const writeSources = policies.filter((p) => p.actions.some((a) => WRITE_ACTIONS.has(a)));
  if (readSources.length === 0) {
    return {
      visible: false, visibleAll: false, visibleFields: null,
      writableAll: false, readSources, writeSources,
    };
  }

  let visibleAll = false;
  const visibleFields = new Set<string>();
  for (const p of readSources) {
    if (!p.fieldMask || p.fieldMask.allowFields === undefined) {
      visibleAll = true; // 宽来源：不裁剪可见面
      continue;
    }
    for (const f of asStringSet(p.fieldMask.allowFields) ?? []) visibleFields.add(f);
  }

  const writableAll = writeSources.some((p) => p.fieldMask === null);

  return {
    visible: true,
    visibleAll,
    visibleFields: visibleAll ? null : visibleFields,
    writableAll,
    readSources,
    writeSources,
  };
}

export function canSeeField(cap: FieldCapability, fieldId: string): boolean {
  if (!cap.visible) return false;
  if (cap.visibleAll) return true;
  return cap.readSources.some((p) => fieldVisibleInMask(p.fieldMask, fieldId));
}

export function canWriteField(cap: FieldCapability, fieldId: string): boolean {
  if (!canSeeField(cap, fieldId)) return false;
  return cap.writeSources.some((p) => fieldWritableInMask(p.fieldMask, fieldId));
}

/**
 * 多源 mask 合并（并集最宽）：任一来源不裁剪可见面 -> 不裁剪；
 * 否则 allowFields 取并集；readOnlyFields 取交集（各来源均只读才最终只读）。
 */
export function mergeFieldMasks(masks: readonly (FieldMask | null)[]): FieldMask | null {
  if (masks.length === 0) return null;
  const allowUnion = new Set<string>();
  let anyAllow = false;
  let readOnlyIntersection: Set<string> | null = null;
  let hasReadOnlyDef = false;
  for (const m of masks) {
    if (!m || m.allowFields === undefined) return null; // 该来源不裁剪可见面
    anyAllow = true;
    for (const f of asStringSet(m.allowFields) ?? []) allowUnion.add(f);
    if (m.readOnlyFields !== undefined) {
      hasReadOnlyDef = true;
      const ro: Set<string> = asStringSet(m.readOnlyFields) ?? new Set<string>();
      const prev: Set<string> | null = readOnlyIntersection;
      readOnlyIntersection = prev === null
        ? new Set(ro)
        : new Set([...prev].filter((f: string) => ro.has(f)));
    }
  }
  const out: FieldMask = {};
  if (anyAllow) out.allowFields = [...allowUnion];
  if (hasReadOnlyDef) out.readOnlyFields = [...(readOnlyIntersection ?? [])];
  return out;
}

interface RecordLike {
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 列表/详情出口投影：删除记录 fields 中不可见键（含 hydrated LinkRef/lookup/公式结果键），
 * 同步过滤字段清单。返回新数组/新对象，不改输入（纯函数）。
 */
export function applyMaskToRecords<T extends RecordLike>(
  records: readonly T[],
  fieldDefs: readonly { id: string }[],
  cap: FieldCapability,
): { records: T[]; fields: { id: string }[] } {
  const visibleDefs = fieldDefs.filter((f) => canSeeField(cap, f.id));
  const visibleIds = new Set(visibleDefs.map((f) => f.id));
  const projected = records.map((r) => {
    if (!r.fields || typeof r.fields !== "object") return r;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.fields)) {
      if (visibleIds.has(k)) fields[k] = v;
    }
    return { ...r, fields };
  });
  return { records: projected, fields: visibleDefs };
}

/**
 * 写入口守卫：payload 出现不可见或只读字段键 -> 整单拒绝（事务不开），不静默丢弃。
 */
export function assertFieldsWritable(keys: readonly string[], cap: FieldCapability): void {
  const hidden = keys.filter((k) => !canSeeField(cap, k));
  if (hidden.length) {
    throw new AuthzFieldError("包含无权访问的字段", "FORBIDDEN_FIELD", hidden);
  }
  const readOnly = keys.filter((k) => !canWriteField(cap, k));
  if (readOnly.length) {
    throw new AuthzFieldError("包含只读字段", "FORBIDDEN_FIELD", readOnly);
  }
}
