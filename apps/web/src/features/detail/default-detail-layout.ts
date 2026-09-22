// apps/web/src/features/detail/default-detail-layout.ts
// 「还没保存过布局时的默认详情布局」的单一真源。
//
// 以前有两套算法：DetailLayoutRenderer（详情页）无布局时整行全宽纵排，
// FormDesigner.initialRows（设计器）无布局时按字段类型默认宽度自动切行。
// 于是「新建表后进详情页看到的」与「第一次打开设计器看到的」不一致，必须保存一次才对齐。
// 本模块把设计器那套口径搬出来，渲染器与设计器共用同一份。

import type { DetailLayout, DetailLayoutRow, DetailRowColumns, FieldDTO, FieldIdT, FieldType, FieldWidthPct } from "@gx/shared-types";

/** 行模型的最小单元（设计器内部、默认布局推导共用） */
export interface LayoutItem {
  fieldId: FieldIdT;
  widthPct: FieldWidthPct;
}
export interface LayoutRow {
  items: LayoutItem[];
}

// 宽字段：独占一行（内容长 / 容器）
const WIDE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["longText", "richText", "attachment", "links", "tabs", "subtable"]);
// 紧凑字段：默认 1/4 宽，一行自然排 4 个（数字/勾选/评分等短内容）
const COMPACT_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["number", "currency", "percent", "duration", "checkbox", "rating", "autoNumber"]);
const isWide = (t: FieldType): boolean => WIDE_TYPES.has(t);

/** 字段默认宽度：宽字段 100%，紧凑字段 25%（一行 4 个），其余 50%（一行 2 个） */
export const defaultW = (t: FieldType): FieldWidthPct => (isWide(t) ? 100 : COMPACT_TYPES.has(t) ? 25 : 50);

/** 扁平 items 按宽度累加切行（初始默认布局用） */
export function segmentToRows(items: LayoutItem[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  let cur: LayoutItem[] = [];
  let sum = 0;
  for (const it of items) {
    if (cur.length > 0 && sum + it.widthPct > 100) {
      rows.push({ items: cur });
      cur = [];
      sum = 0;
    }
    cur.push(it);
    sum += it.widthPct;
  }
  if (cur.length > 0) rows.push({ items: cur });
  return rows;
}

/** 归属任一选项卡容器的字段 id：只在对应 TabsPanel 内渲染，不进顶层行 */
export function collectFieldsInTabs(fields: FieldDTO[]): Set<string> {
  const inTabs = new Set<string>();
  for (const f of fields) {
    if (f.type === "tabs") for (const t of f.tabsConfig ?? []) for (const id of t.fieldIds ?? []) inTabs.add(id);
  }
  return inTabs;
}

const rowOf = (r: LayoutRow): DetailLayoutRow => ({
  colCount: 2 as DetailRowColumns,
  fieldIds: r.items.map((i) => i.fieldId),
  widths: Object.fromEntries(r.items.map((i) => [i.fieldId, i.widthPct])) as Record<string, FieldWidthPct>,
});

/**
 * 默认详情布局：按字段顺序、按字段类型的默认宽度累加切行。
 * - tabs / subtable 字段本身作为全宽项，由渲染器 / 设计器各自渲染成容器面板
 * - 归属 tabs 容器的字段排除，避免与容器重复渲染
 */
export function deriveDefaultDetailLayout(fields: FieldDTO[]): DetailLayout {
  const inTabs = collectFieldsInTabs(fields);
  const items: LayoutItem[] = [];
  for (const f of fields) {
    if (inTabs.has(f.id)) continue;
    items.push({ fieldId: f.id as FieldIdT, widthPct: defaultW(f.type) });
  }
  return { defaultRowColumns: 2 as DetailRowColumns, rows: segmentToRows(items).map(rowOf) };
}
