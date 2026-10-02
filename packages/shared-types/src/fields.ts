// packages/shared-types/src/fields.ts
// 字段类型系统（从 v1 Core/Models.swift 1:1 移植为 TS）
// v1 参照：GXFieldType 枚举 + 28 种字段
//
// v2 扩展：tabs（选项卡分组）+ subtable（子表格）

export const FIELD_TYPES = [
  "singleLineText",
  "longText",
  "richText",
  "number",
  "currency",
  "percent",
  "duration",
  "date",
  "datetime",
  "checkbox",
  "singleSelect",
  "multiSelect",
  "email",
  "url",
  "phone",
  "member",
  "rating",
  "autoNumber",
  "json",
  "attachment",
  "links",
  "lookup",
  "rollup",
  "count",
  "formula",
  // v2 新增
  "tabs",      // 选项卡字段：详情页分组容器，无 cell value
  "subtable",  // 子表格字段：复用 links 三元组 + displayedFieldIds
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

// 是否为系统字段（不入物理表）
export const SYSTEM_FIELDS: ReadonlySet<FieldType> = new Set([
  "createdTime",
  "lastModifiedTime",
  "createdBy",
  "lastModifiedBy",
]);

// 是否为计算字段（不入物理表，由 hydration 现算）
export const COMPUTED_FIELDS: ReadonlySet<FieldType> = new Set([
  "lookup",
  "rollup",
  "count",
  "formula",
  "links", // links 在 v1 是现算不落盘，v2 需评估
]);

// 是否为「纯容器 / 无 cell value」字段（grid view / 详情 cell 都不渲染 cell）
// - tabs 选项卡：本身只是一个分组容器，自身无值
// - subtable 自身有 values（关联的 LinkRef 数组），但 grid view 跳过它（以子表形式展示）
export const CONTAINER_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "tabs",
]);

// 在 grid view 里需要跳过的字段类型（无独立 cell 表现）
// - tabs: 纯容器，无 cell value
// - subtable: 在 detail 页以子表形式呈现，不在 grid 列里再列一次
export const GRID_SKIP_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "tabs",
  "subtable",
]);

/** Tab 内字段宽度占比（与 views.ts 的 FieldWidthPct 结构一致，fields.ts 不能反向依赖 views.ts，故就地定义） */
export type TabFieldWidth = 25 | 50 | 75 | 100;

/** Tab 内显式行的单个字段项（与表单设计器顶层行模型同构） */
export interface TabLayoutItem {
  fieldId: string;
  /** 宽度占比 25|50|75|100 */
  widthPct: TabFieldWidth;
}

/** Tab 内显式行：一行内字段按宽度百分比横向多列排列（与顶层 DetailLayoutRow 一致） */
export interface TabLayoutRow {
  items: TabLayoutItem[];
}

/** Tab 选项卡定义（仅 type=tabs 字段使用） */
export interface TabConfig {
  /** 选项卡 id（前端生成 cuid-like，不引入新品牌类型） */
  id: string;
  /** 选项卡显示名 */
  name: string;
  /**
   * 该选项卡内承载的字段 id 列表（扁平顺序，兼容旧数据）。
   * 新数据以 rows 为准；rows 缺失时回退 fieldIds + widths 流体布局。
   * 保存时双写（rows 与 fieldIds/widths 保持同步），保证旧渲染端也能读。
   */
  fieldIds: string[];
  /** 字段宽度占比（fieldId -> 25|50|75|100）；缺失时按字段类型给默认（宽字段 100、其余 50） */
  widths?: Record<string, TabFieldWidth>;
  /**
   * 显式行模型（设计器所见即所得）：tab 内字段按行组织、行内横向多列排列。
   * - 存在时渲染端按行渲染，保留用户用 ▼ 拆出的行边界
   * - 缺失时回退 fieldIds + widths 自动换行（旧数据）
   */
  rows?: TabLayoutRow[];
}

export function isSystemField(t: FieldType): boolean {
  return SYSTEM_FIELDS.has(t);
}

export function isComputedField(t: FieldType): boolean {
  return COMPUTED_FIELDS.has(t);
}

/** 是否需要在 grid view / cell 视图跳过（无 cell value） */
export function isContainerField(t: FieldType): boolean {
  return CONTAINER_TYPES.has(t);
}

/** 在 grid view 列表头里应跳过 */
export function isGridSkipType(t: FieldType): boolean {
  return GRID_SKIP_TYPES.has(t);
}

/**
 * 可否被其它字段「引用」（关联显示字段 / 公式 {字段} / 查阅 / 聚合 / 记录筛选）。
 * - tabs 是纯视觉容器：无字段名语义、无 cell value，绝不可被关联、公式、聚合等引用
 * - subtable 是子表容器（LinkRef 数组），不能作为标量值被公式/查阅/筛选引用
 */
export function isReferenceableType(t: FieldType): boolean {
  return t !== "tabs" && t !== "subtable" && t !== "member";
}

/**
 * 可否作为筛选条件「匹配字段」值来源的本表字段（valueType="field"）。
 * 取「两字段值相等/比较」语义，仅允许物理可输入的标量字段：
 * 排除容器（tabs/subtable）、计算字段（links/lookup/rollup/count/formula）、
 * 系统字段、附件、JSON（无可比标量值）。
 */
export function isFilterMatchSourceType(t: FieldType): boolean {
  if (t === "tabs" || t === "subtable") return false;
  if (SYSTEM_FIELDS.has(t)) return false;
  if (COMPUTED_FIELDS.has(t)) return false;
  if (t === "attachment" || t === "json" || t === "member") return false;
  return true;
}

// 字段类型默认 UI 图标颜色（与 v1 GXFieldIcon.name 对齐）
export const FIELD_TYPE_COLOR: Record<FieldType, string> = {
  singleLineText: "#7F77DD", // 文本紫
  longText: "#7F77DD",
  richText: "#7F77DD",
  number: "#378ADD", // 数字蓝
  currency: "#378ADD",
  percent: "#378ADD",
  duration: "#378ADD",
  date: "#993556", // 日期粉紫
  datetime: "#993556",
  checkbox: "#1D9E75", // 布尔青
  url: "#378ADD",
  email: "#378ADD",
  phone: "#378ADD",
  member: "#534AB7", // 成员紫
  rating: "#BA7517", // 评级橙
  autoNumber: "#5F5E5A", // 自动灰
  json: "#5F5E5A",
  attachment: "#534AB7",
  singleSelect: "#1D9E75", // 选择青
  multiSelect: "#1D9E75",
  links: "#0F6E56", // 关联绿
  lookup: "#0F6E56",
  rollup: "#0F6E56",
  count: "#0F6E56",
  formula: "#D4537E", // 公式粉
  tabs: "#5F5E5A", // 容器灰
  subtable: "#0F6E56", // 同关联绿
  createdTime: "#5F5E5A",
  lastModifiedTime: "#5F5E5A",
  createdBy: "#5F5E5A",
  lastModifiedBy: "#5F5E5A",
};

/** 字段类型的人类可读中文名（与 v1 GXFieldType.displayName 对齐） */
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  singleLineText: "单行文本",
  longText: "多行文本",
  richText: "富文本",
  number: "数字",
  currency: "货币",
  percent: "百分比",
  duration: "时长",
  date: "日期",
  datetime: "日期时间",
  checkbox: "复选框",
  singleSelect: "单选",
  multiSelect: "多选",
  email: "邮箱",
  url: "链接",
  phone: "电话",
  member: "成员",
  rating: "评分",
  autoNumber: "自动编号",
  json: "JSON",
  attachment: "附件",
  links: "关联",
  lookup: "查阅",
  rollup: "聚合",
  count: "计数",
  formula: "公式",
  tabs: "选项卡",
  subtable: "子表格",
  createdTime: "创建时间",
  lastModifiedTime: "最后修改时间",
  createdBy: "创建人",
  lastModifiedBy: "最后修改人",
};
