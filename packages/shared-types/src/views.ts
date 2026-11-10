// packages/shared-types/src/views.ts
// 视图配置 / 排序 / 分组 / 聚合（v1 Core/Models.swift GXViewConfig TS 同构）

import type { FilterNode } from "./filters.js";
import type { FieldType } from "./fields.js";
import type { FieldIdT } from "./ids.js";
import { fieldTypeGroup, isNumericAggCapable } from "./type-groups.js";

export type ViewType =
  | "grid"
  | "gallery"
  | "form"
  | "detail"
  | "kanban"
  | "calendar"
  | "tree"
  | "gantt"
  | "chart";

export const VIEW_TYPES: ViewType[] = [
  "grid",
  "gallery",
  "form",
  "detail",
  "kanban",
  "calendar",
  "tree",
  "gantt",
  "chart",
];

export const VIEW_TYPE_LABEL: Record<ViewType, string> = {
  grid: "网格",
  gallery: "画廊",
  form: "表单",
  detail: "详情",
  kanban: "看板",
  calendar: "日历",
  tree: "层级",
  gantt: "甘特",
  chart: "图表",
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

/**
 * 甘特图时间轴刻度档位（每列宽度代表的时间跨度）。
 * day=日 / week=周 / month=月 / quarter=季 / year=年。
 */
export type GanttZoom = "day" | "week" | "month" | "quarter" | "year";

export const GANTT_ZOOM_LABEL: Record<GanttZoom, string> = {
  day: "日",
  week: "周",
  month: "月",
  quarter: "季",
  year: "年",
};

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

  // 层级视图：同表自引用 link 字段（其 LinkRef 决定 parentId）
  treeParentFieldId: string | null;

  // 甘特图
  ganttStartFieldId: string | null; // date / datetime
  ganttEndFieldId: string | null; // date / datetime
  ganttProgressFieldId: string | null; // number / percent（0~100）
  ganttDependencyFieldId: string | null; // 同表 link：前置任务
  ganttZoom: GanttZoom;

  // 图表（BI 刀2 注册通电；平铺四键，与 kanbanFieldId 同构，零嵌套信封）
  chartType: ChartType; // 刀2 固定默认 "bar"，horizontalBar/line/pie 与类型切换留刀3
  chartDimensionFieldId: string | null; // 维度（分桶）字段；null = 未配置
  chartMetricFieldId: string | null; // 指标字段；null 时仅 count 族聚合有意义
  chartAggFunc: AggFunc; // 复用既有九函数，无指标字段默认 "count"

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
    treeParentFieldId: null,
    ganttStartFieldId: null,
    ganttEndFieldId: null,
    ganttProgressFieldId: null,
    ganttDependencyFieldId: null,
    ganttZoom: "day",
    chartType: "bar",
    chartDimensionFieldId: null,
    chartMetricFieldId: null,
    chartAggFunc: "count",
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

// 该字段类型能否作为层级视图的父级关联（同表自引用 link；是否本表由字段数据保证）
export function canBeTreeParentField(t: FieldType): boolean {
  return t === "links";
}

// 该字段类型能否作为甘特起止日期
export function canBeGanttDateField(t: FieldType): boolean {
  return t === "date" || t === "datetime";
}

// 该字段类型能否作为甘特进度（数字 / 百分比，0~100）
export function canBeGanttProgressField(t: FieldType): boolean {
  return t === "number" || t === "percent";
}

// 该字段类型能否作为甘特前置依赖（同表 link）
export function canBeGanttDependencyField(t: FieldType): boolean {
  return t === "links";
}

// ============ 图表视图（BI 刀2 已注册为第 9 视图） ============
// 注册状态（刀2 完成）：
//   - "chart" 已并入上方 ViewType 联合 / VIEW_TYPES / VIEW_TYPE_LABEL；
//   - ViewConfig 以平铺四键（chartType/chartDimensionFieldId/chartMetricFieldId/chartAggFunc）
//     持久化，与 kanbanFieldId 同构，defaultViewConfig 给默认值；
//   - ViewRouter / 图标 / 后端 zod 与 MCP 枚举 / parseViewConfig 白名单均已通电。
// 下面的 ChartType / CHART_TYPE_LABEL / ChartSpec / canBe* 是刀1 落地的纯类型与资格判定，保持不动。
// ChartSpec 为独立规格描述，当前持久化走 ViewConfig 平铺键而非嵌套 ChartSpec。

/** 图表图型：柱图 / 条形图（横向柱）/ 折线图 / 饼图。 */
export type ChartType = "bar" | "horizontalBar" | "line" | "pie";

export const CHART_TYPE_LABEL: Record<ChartType, string> = {
  bar: "柱图",
  horizontalBar: "条形图",
  line: "折线图",
  pie: "饼图",
};

/**
 * 图表规格（纯数据，无任何渲染/颜色信息）。
 * - dimensionFieldId：维度（分桶）字段；null = 未配置，buildChartData 返回空数组。
 * - metricFieldId：指标字段；null 时仅 count 类聚合有意义（按整记录计数），
 *   sum/avg/min/max 等数值聚合在无指标字段时返回 null。
 * - aggFunc：复用既有 AggFunc 九函数，语义与 apps/api 列聚合 1:1 对齐。
 */
export interface ChartSpec {
  chartType: ChartType;
  dimensionFieldId: string | null;
  metricFieldId: string | null;
  aggFunc: AggFunc;
}

/**
 * 该字段类型能否作为图表维度（分桶）字段。
 * 规则走 fieldTypeGroup 单源分组：link / attachment / container 三组无标量分桶语义，
 * 其余（text/number/date/bool/select）均可作维度。
 */
export function canBeChartDimensionField(t: FieldType): boolean {
  const g = fieldTypeGroup(t);
  return g !== "link" && g !== "attachment" && g !== "container";
}

/**
 * 该字段类型能否作为图表指标字段。
 * 数值族判定唯一复用 isNumericAggCapable（number/currency/percent/duration/rating），
 * 禁止在本文件另造数值类型清单。count 类聚合不挑指标字段，由调用层在 metricFieldId=null 时处理。
 */
export function canBeChartMetricField(t: FieldType): boolean {
  return isNumericAggCapable(t);
}
