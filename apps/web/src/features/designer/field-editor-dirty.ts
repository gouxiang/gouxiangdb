// apps/web/src/features/designer/field-editor-dirty.ts
// 字段编辑器「脏检查」纯逻辑：判断当前表单相对基线（现有字段 / 新建空表单）是否有未保存修改。
//
// 背景（F-01，2026-09-20 走查复验）：字段编辑器的「字段」下拉可在同一弹窗内切换
// 「新建字段 ↔ 编辑任意现有字段」，切换会静默丢弃正在输入的新建表单；且编辑模式下
// 未做任何修改点「保存」也会 PATCH 并提示「已保存字段」后关闭——两者叠加后，用户的
// 「新建查阅」操作实际落在「编辑关联字段」分支：一条 PATCH 打到 link 字段、弹窗关闭、
// 无 POST、无报错，与「新建成功」从外部完全无法区分。本模块为两处守卫提供纯判定：
//   ① 切换目标字段且有未保存修改 → 需确认（放弃/继续编辑）；
//   ② 编辑模式下没有任何修改 → 「保存」不再假装成功（提示后保留弹窗、不发请求）。
// 只做比较，不碰 React/网络，便于在 node 环境直接单测。

import type {
  DefaultConfig,
  FieldDTO,
  FieldIdT,
  FieldType,
  FilterNode,
  NumberRule,
  SelectOption,
  TabConfig,
} from "@gx/shared-types";

/** 编辑器表单的可编辑投影（与 buildPayload 读取的状态一一对应）。id 一律归一为 null/字符串。 */
export interface FieldDraft {
  name: string;
  type: FieldType;
  options: SelectOption[];
  precision: number;
  defaultNow: boolean;
  relTableId: string | null;
  relKind: "mm" | "hm" | "bt";
  displayFieldId: string | null;
  linkFieldId: string | null;
  subFieldId: string | null;
  rollupFn: "sum" | "avg" | "min" | "max" | "count";
  formula: string;
  recordFilter: FilterNode | null;
  defaultConfig: DefaultConfig | null;
  numberRule: NumberRule | null;
  tabs: TabConfig[];
  displayedFieldIds: FieldIdT[];
  visibleFieldIds: FieldIdT[];
}

/** 空串/undefined 归一为 null，与 buildPayload 的 idOrNull 同一口径。 */
function normId(v: string | null | undefined): string | null {
  return v && String(v).trim() ? String(v) : null;
}

/** 键序无关的 JSON 序列化：服务端 DTO 与本地 state 对象键序可能不同。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** 新建模式的空基线：与编辑器各 state 的初始值完全一致。 */
export function emptyDraft(): FieldDraft {
  return {
    name: "",
    type: "singleLineText",
    options: [],
    precision: 0,
    defaultNow: false,
    relTableId: null,
    relKind: "mm",
    displayFieldId: null,
    linkFieldId: null,
    subFieldId: null,
    rollupFn: "sum",
    formula: "",
    recordFilter: null,
    defaultConfig: null,
    numberRule: null,
    tabs: [],
    displayedFieldIds: [],
    visibleFieldIds: [],
  };
}

/** 从服务端字段 DTO 构造基线投影。field 为 null 时即新建空基线。 */
export function draftFromField(field: FieldDTO | null | undefined): FieldDraft {
  if (!field) return emptyDraft();
  return {
    name: (field.name ?? "").trim(),
    type: field.type,
    options: field.options ?? [],
    precision: field.precision ?? 0,
    // defaultNow 后端会返回但 FieldDTO 未声明（与 FieldEditorSheet 的读取方式一致，走投影）
    defaultNow: (field as { defaultNow?: boolean | null }).defaultNow ?? false,
    relTableId: normId(field.relatedTableId),
    relKind: (field.relationKind as "mm" | "hm" | "bt") ?? "mm",
    displayFieldId: normId(field.linkDisplayFieldId),
    linkFieldId: normId(field.linkFieldId),
    subFieldId: normId(field.lookupFieldId),
    rollupFn: field.rollupFunction ?? "sum",
    formula: field.formula ?? "",
    recordFilter: field.recordFilter ?? null,
    defaultConfig: field.defaultConfig ?? null,
    numberRule: field.numberRule ?? null,
    tabs: field.tabsConfig ?? [],
    displayedFieldIds: field.displayedFieldIds ?? [],
    visibleFieldIds: field.visibleFieldIds ?? [],
  };
}

/** 逐项比较：id 类走归一，对象/数组走稳定序列化。 */
export function isDirty(current: FieldDraft, baseline: FieldDraft): boolean {
  if (current.name.trim() !== baseline.name.trim()) return true;
  if (current.type !== baseline.type) return true;
  if (current.precision !== baseline.precision) return true;
  if (current.defaultNow !== baseline.defaultNow) return true;
  if (normId(current.relTableId) !== baseline.relTableId) return true;
  if (current.relKind !== baseline.relKind) return true;
  if (normId(current.displayFieldId) !== baseline.displayFieldId) return true;
  if (normId(current.linkFieldId) !== baseline.linkFieldId) return true;
  if (normId(current.subFieldId) !== baseline.subFieldId) return true;
  if (current.rollupFn !== baseline.rollupFn) return true;
  if (current.formula !== baseline.formula) return true;
  const simple: (keyof FieldDraft)[] = [
    "options",
    "recordFilter",
    "defaultConfig",
    "numberRule",
    "tabs",
    "displayedFieldIds",
    "visibleFieldIds",
  ];
  for (const key of simple) {
    if (stableStringify(current[key]) !== stableStringify(baseline[key])) return true;
  }
  return false;
}
