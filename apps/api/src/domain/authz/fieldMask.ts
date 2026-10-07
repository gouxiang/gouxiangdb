// M4/S1 fieldMask 纯函数层：单源字段判定 + 多源并集最宽 capability + 记录投影 + 写键守卫。
//
// 纯域：无 Hono/guards/Prisma 依赖（不 import HttpError——守卫适配由 S3 路由层映射本域错误）。
// 语义（M4 计划 §4.3/§4.4，纯 allow 无 deny）：
//   - fieldMask 是命中 allow 之上的【收窄清单】，不是授权清单；缺省/null = 不裁剪（全字段）。
//   - 可见 = 任一 r 来源可见之并；可写 = 任一 c/u 来源在【该来源】下可见且非其只读。
//   - 并集只增不减：宽来源（不裁剪）与窄来源并存时全字段可见；管理员须收窄宽来源本身。

import type { FieldMask, ResourceAction, ViewConfig, FilterNode, SortSpec, AggFunc } from "@gx/shared-types";
import type { ScopedPolicy } from "./types.js";

/**
 * creator/owner 兜底合成的不裁剪宽来源（动作覆盖 r/c/u、fieldMask=null）。
 * 与 engine.decide -> evaluateChainDecision 的 creator/owner 宽放同源同义：
 * 兜底成立等价追加一条宽来源。REST（maskSession）与 MCP（m4Adapter 纯写判定）共用此单源。
 */
export function syntheticWidePolicy(userId: string, tableNodeId: string): ScopedPolicy {
  return {
    id: "__owner_fallback__", nodeId: tableNodeId, subjectType: "user",
    subjectId: userId, actions: ["r", "c", "u"] as ResourceAction[],
    fieldMask: null, rowConditions: null, viaAncestor: false,
  };
}

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
 * 服务端计算/系统/autoNumber/tabs 字段不接受物理直写（applyFieldWrites 本就跳过）。
 * 写键守卫只校验其余「物理可写」字段；单源，REST（maskSession）与 MCP（record.tools）共用。
 */
export const NON_WRITABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "lookup", "rollup", "count", "formula", "tabs",
  "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy", "autoNumber",
]);

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
 * 计算字段/系统字段键不在此判定（applyFieldWrites 本就跳过它们）；调用方只传物理写键。
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

/**
 * 纯写能力（P1-B）：**不要求该主体有任何 r 来源**——只写身份（actions 含 c/u 但无 r）也必须有
 * 正确的字段写判定，不能像旧 MCP 守卫那样拿 read-capability 顶替，否则窄写掩码在 visibleFields=null
 * 时被整段跳过（fail-open，可写掩码外任意物理列）。
 *
 * 语义与「并集只增不减」一致，但只看命中指定写动作（c 或 u）的来源：
 *   - writableAll=true：任一写来源 fieldMask===null（不裁剪）-> 全字段可写（宽 c/u 授权保持可用）。
 *   - 否则 writableFields=各窄写来源在该源可见且非只读字段之并；payload 键必须落在此并集内。
 *   - 无任何该动作写来源：writeMatched=false、writableAll=false、writableFields=空集（fail-closed）。
 */
interface WriteOnlyFieldCapability {
  /** 主体在该节点上是否命中至少一条承载指定写动作的策略。 */
  writeMatched: boolean;
  /** 任一写来源不裁剪（mask=null）-> 全字段可写。 */
  writableAll: boolean;
  /** 所有写来源都裁剪时，可写物理字段 id 的并集（writableAll=true 时无意义）。 */
  writableFields: Set<string>;
}

/**
 * 由 cutoff 链命中策略计算某写动作（"c" | "u"）下的纯写能力。
 * @param policies collectScopedNodes 收集的全部命中策略（含未承载该动作者，内部过滤）。
 * @param action "c" 或 "u"。
 */
export function writeOnlyFieldCapability(
  policies: readonly ScopedPolicy[],
  action: "c" | "u",
): WriteOnlyFieldCapability {
  const writeSources = policies.filter((p) => p.actions.includes(action));
  if (writeSources.length === 0) {
    return { writeMatched: false, writableAll: false, writableFields: new Set() };
  }
  if (writeSources.some((p) => p.fieldMask === null)) {
    return { writeMatched: true, writableAll: true, writableFields: new Set() };
  }
  const writableFields = new Set<string>();
  for (const p of writeSources) {
    const allow = p.fieldMask?.allowFields;
    if (!allow) continue; // 只有 readOnlyFields 而无 allowFields 的来源：无可写白名单，跳过（不放大）
    for (const f of asStringSet(allow) ?? []) {
      if (fieldWritableInMask(p.fieldMask, f)) writableFields.add(f);
    }
  }
  return { writeMatched: true, writableAll: false, writableFields };
}

/**
 * 纯写键守卫（P1-B）：fail-closed。不要求 r 来源，只按纯写能力判定：
 *   - writableAll=true -> 全部放行（宽 c/u，mask=null）；
 *   - 否则任一物理写键不在可写并集内（含落入某来源 readOnlyFields 者）-> AuthzFieldError，整单不开事务。
 * 计算字段/系统字段键不在此判定；调用方只传物理可写键（与 assertFieldsWritable 同纪律）。
 */
export function assertWriteOnlyFields(
  keys: readonly string[],
  cap: WriteOnlyFieldCapability,
): void {
  if (cap.writableAll) return;
  const denied = keys.filter((k) => !cap.writableFields.has(k));
  if (denied.length) {
    throw new AuthzFieldError("包含无权写入的字段", "FORBIDDEN_FIELD", [...new Set(denied)]);
  }
}

/** 从字段定义列表挑出可见者（列表 fields/allFields、CSV 表头列、hydrate 入参同口径）。 */
export function filterVisibleFieldDefs<T extends { id: string }>(
  fieldDefs: readonly T[],
  cap: FieldCapability,
): T[] {
  return fieldDefs.filter((f) => canSeeField(cap, f.id));
}

/**
 * 视图配置脱敏（on 态）：从 ViewConfig 中抹掉一切以掩码外字段为目标的引用，产出一份
 * 与"该用户视角下这些列不存在/恒为空"一致的配置。物理 compile 与内存 applyViewQuery
 * 共用这同一份脱敏配置，保证两条 M1 读路径口径零分叉（不能用隐藏列偷偷过滤/排序/分组/聚合）。
 *
 *   - filters：删除引用隐藏字段的条件叶；AND 收窄为其余子树，OR 无法安全收窄->整体失效(null)；
 *   - sorts/groupByFieldId：隐藏字段引用删除；
 *   - aggregations：隐藏字段列删除；
 *   - search 不处理：recordService 搜索本就以 visibleFields(fields,config) 为可搜域，
 *     投影时 fields 已为可见子集，隐藏列自动不入搜索。
 */
export function sanitizeViewConfigForMask(config: ViewConfig, visible: ReadonlySet<string>): ViewConfig {
  const filter = stripFilterByMask(config.filters ?? null, visible);
  const sorts = (config.sorts ?? []).filter((s: SortSpec) => visible.has(s.fieldId));
  const aggregations: Record<string, AggFunc | null> = {};
  for (const [fid, fn] of Object.entries(config.aggregations ?? {})) {
    if (visible.has(fid)) aggregations[fid] = fn;
  }
  return {
    ...config,
    filters: filter,
    sorts,
    aggregations,
    groupByFieldId: config.groupByFieldId && visible.has(config.groupByFieldId) ? config.groupByFieldId : null,
  };
}

/** 递归删除引用隐藏字段的条件叶（AND 收窄；OR/NOT 无法安全收窄时该子树整体失效）。 */
function stripFilterByMask(node: FilterNode | null, visible: ReadonlySet<string>): FilterNode | null {
  if (!node) return null;
  if (node.kind === "condition") {
    return visible.has(node.fieldId) ? node : null;
  }
  // formula 节点不直接引用物理条件列：原样保留。其内部字段引用在求值时经
  // buildFormulaSource 的可见性钩子收口（被 mask 字段以 FNULL 占位，不泄漏）。
  if (node.kind === "formula") return node;
  if (node.kind === "not") {
    const child = node.child ? stripFilterByMask(node.child, visible) : null;
    // NOT(隐藏条件) 无法安全求值为 true/false（隐藏值未知），整体失效。
    return child ? { kind: "not", child } : null;
  }
  const originalKids = node.children ?? [];
  const kids = originalKids
    .map((ch) => stripFilterByMask(ch, visible))
    .filter((ch): ch is FilterNode => ch !== null);
  if (kids.length === 0) return null;
  // OR 任一分支引用隐藏字段即无法安全收窄（隐藏分支真值未知，剩下单分支不等于原 OR）-> 整体失效；
  // 必须在"单孩子拍平"之前判定，否则 OR(f1可见, f2隐藏) 会被错误拍平成 f1。
  if (node.kind === "or") {
    return kids.length === originalKids.length ? { kind: "or", children: kids } : null;
  }
  // AND 缺项只收窄；只剩一项时拍平为该叶。
  if (kids.length === 1) return kids[0]!;
  return { kind: node.kind, children: kids } as FilterNode;
}
