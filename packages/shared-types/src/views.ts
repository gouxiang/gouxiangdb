// packages/shared-types/src/views.ts
// 视图配置 / 排序 / 分组 / 聚合（v1 Core/Models.swift GXViewConfig TS 同构）

import type { FilterNode } from "./filters.js";
import type { FieldType } from "./fields.js";
import type { FieldIdT } from "./ids.js";

export type ViewType = "grid" | "gallery" | "form" | "detail" | "kanban" | "calendar";

export const VIEW_TYPES: ViewType[] = [
  "grid",
  "gallery",
  "form",
  "detail",
  "kanban",
  "calendar",
];

export const VIEW_TYPE_LABEL: Record<ViewType, string> = {
  grid: "网格",
  gallery: "画廊",
  form: "表单",
  detail: "详情",
  kanban: "看板",
  calendar: "日历",
};

export type LockMode = "collaborative" | "locked" | "personal";

export const LOCK_MODE_LABEL: Record<LockMode, string> = {
  collaborative: "协作",
  locked: "已锁定",
  personal: "个人",
};

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  fieldId: string;
  direction: SortDirection;
}

export type RowHeight = "short" | "medium" | "tall";

// 行高档位与参考图「数据表主界面」实测值对齐：紧凑 36 / 常规 44 / 宽松 64。
// 三档机制原样保留（行高下拉仍可切），只校准前两档的实际渲染高度。
export const ROW_HEIGHT_PX: Record<RowHeight, number> = {
  short: 36,
  medium: 44,
  tall: 64,
};
/** 表头行高（参考图实测 36）：与行高配置无关，固定一档。 */
export const HEADER_HEIGHT_PX = 36;

export type AggFunc = "sum" | "avg" | "min" | "max" | "count" | "countEmpty" | "countFilled" | "percentEmpty" | "percentFilled";

export const AGG_FUNC_LABEL: Record<AggFunc, string> = {
  sum: "求和",
  avg: "平均值",
  min: "最小值",
  max: "最大值",
  count: "计数",
  countEmpty: "空值数",
  countFilled: "非空数",
  percentEmpty: "空值率",
  percentFilled: "填充率",
};

export type RowColorMode = "none" | "bySelect" | "byCondition";

export interface RowColorCondition {
  id: string;
  fieldId: string;
  op: string;
  value: string;
  color: string;
}

export interface RowColorConfig {
  mode: RowColorMode;
  fieldId?: string; // bySelect 时使用
  conditions: RowColorCondition[];
}

export interface FormFieldConfig {
  fieldId: string;
  label: string;
  help: string;
  required: boolean;
  hidden: boolean;
}

export type DetailColumns = 1 | 2 | 3;

export interface ViewConfig {
  // 通用
  hiddenFieldIds: string[];
  fieldOrder: string[]; // 为空表示按 field.order
  rowHeight: RowHeight;
  filters: FilterNode | null;
  sorts: SortSpec[];
  search: string;

  // 分组
  groupByFieldId: string | null;
  collapsedGroupKeys: string[];

  // 聚合（fieldId -> 聚合函数，null 表示不聚合）
  aggregations: Record<string, AggFunc | null>;

  // 行颜色
  rowColor: RowColorConfig;

  // 画廊
  coverFieldId: string | null;
  cardFieldIds: string[];

  // 看板
  kanbanFieldId: string | null; // 必须是 singleSelect

  // 日历
  dateFieldId: string | null; // date / datetime / createdTime / lastModifiedTime

  // 表单
  formFields: FormFieldConfig[];
  formTitle: string;
  formDescription: string;

  // 详情
  detailFieldIds: string[];
  /**
   * 详情页字段自由布局（v2.1 新增，取代 detailColumns）。
   * - null：按字段顺序单列纵排（v1 默认）
   * - rows：每行一个 row，colCount=1 表示单列，2~4 表示多列；行内字段平均分列
   * - 长字段（longText/richText/attachment/links）建议独占一行
   * 编辑入口：详情页顶部「编辑布局」开关
   */
  detailLayout: DetailLayout | null;
}

/** 详情页行内列数：1=单列；最多 4 列（旧版均分行，保留兼容） */
export type DetailRowColumns = 1 | 2 | 3 | 4;

/** 单个字段在设计器里的宽度占比 */
export type FieldWidthPct = 25 | 50 | 75 | 100;

export interface DetailLayoutRow {
  colCount: DetailRowColumns;
  fieldIds: string[];
  /**
   * 字段宽度占比（fieldId -> 25|50|75|100）。
   * - 存在时优先按此渲染流体 flex-wrap 布局
   * - 不存在时回退到 colCount 均分网格
   */
  widths?: Record<string, FieldWidthPct>;
}

export interface DetailLayout {
  defaultRowColumns: DetailRowColumns;
  rows: DetailLayoutRow[];
}

/** 计算一行的字段排列：按 widthPct 累加，超 100% 自动换行 */
export function layoutRowLines(row: DetailLayoutRow): FieldIdT[][] {
  const widths = row.widths ?? {};
  const out: FieldIdT[][] = [];
  let cur: FieldIdT[] = [];
  let sum = 0;
  for (const id of row.fieldIds) {
    const fid = id as FieldIdT;
    const w = widths[id] ?? Math.min(100, Math.max(25, 100 / Math.max(1, row.colCount)));
    if (sum + w > 100 && cur.length > 0) {
      out.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(fid);
    sum += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function fieldWidth(row: DetailLayoutRow, fieldId: string): FieldWidthPct {
  const fallback = Math.min(100, Math.max(25, Math.round(100 / Math.max(1, row.colCount) / 25) * 25)) as FieldWidthPct;
  return (row.widths?.[fieldId] ?? fallback);
}

export function defaultViewConfig(overrides: Partial<ViewConfig> = {}): ViewConfig {
  return {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
    ...overrides,
  };
}

/** 把 detailLayout 行内顺序还原成「按用户编排顺序」的字段 ID 列表；未编排的按 allFieldIds 追加 */
export function flattenDetailLayout(
  layout: DetailLayout | null | undefined,
  allFieldIds: string[],
): string[] {
  if (!layout || layout.rows.length === 0) return allFieldIds;
  const out: string[] = [];
  for (const r of layout.rows) out.push(...r.fieldIds);
  for (const id of allFieldIds) if (!out.includes(id)) out.push(id);
  return out;
}

export interface ViewMeta {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  lockMode: LockMode;
  order: number;
  config: ViewConfig;
  createdAt: string;
}

// 分组桶
export interface GroupBucket {
  key: string; // 分组值序列化
  label: string;
  color: string | null;
  recordIds: string[];
  aggregations: Record<string, number | null>;
}

// 该字段类型能否作为看板分组字段
export function canBeKanbanField(t: FieldType): boolean {
  return t === "singleSelect";
}

// 该字段类型能否作为日历日期字段
export function canBeDateField(t: FieldType): boolean {
  return t === "date" || t === "datetime" || t === "createdTime" || t === "lastModifiedTime";
}

// 该字段类型能否作为画廊封面
export function canBeCoverField(t: FieldType): boolean {
  return t === "attachment";
}
