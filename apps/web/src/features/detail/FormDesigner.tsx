// apps/web/src/features/detail/FormDesigner.tsx
// 表单设计器：左侧字段类型库 + 中间一整块表单画布（显式行模型）+ 右侧字段设置
//
// 设计要点：
//  - 画布是「一整块表单」：字段在同一张卡片内按「行」组织，行内按宽度百分比流体排列。
//  - 选项卡分组（tabs）是纯视觉容器：无字段名语义、不可被关联/公式/聚合引用；
//    选项卡内部与顶层完全一致——也是显式行模型，字段可横向多列排列、可用 ▲/▼/⇄ 调整。
//  - 字段库拖入 / 字段跨行移动：拖到字段卡上 = 插入该行（按左/右半定前后）；
//    拖到行间虚线带 = 新建独立一行；拖进选项卡 = 落进该选项卡的行模型。
//  - 字段操作：▲ 并入上一行（上一行放得下时）、▼ 向下拆成独立一行；
//    同一行相邻字段之间，悬停时在卡片左缘出现「交换」按钮，点击与左侧字段互换。
//  - 字段宽度统一在右侧设置面板调整，画布字段上不再放宽度浮条。

import { clsx } from "clsx";
import type { DetailLayout, DetailLayoutRow, DetailRowColumns, FieldDTO, FieldIdT, FieldType, FieldWidthPct, PermissionSet, TableDTO, TabConfig, TabFieldWidth } from "@gx/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, FieldIcon, toast } from "../../components/ui";
import { confirmAction } from "../../components/feedback";
// 阶段 4：软删除类统一带撤销 toast（R-I-08 / R-D-22）
import { toastDeleted } from "../../components/interaction";
import { Icon } from "../../components/icons";
import { TYPE_GROUPS } from "../designer/FieldEditorSheet";
import { FieldInput } from "../views/field-controls";
import { useFields, useGXMutations } from "../../api/hooks";
import { FieldSettingsPanel } from "./FieldSettingsPanel";
import { runSaveLayout, errorMessageOf, SAVE_OK_TEXT } from "./save-layout";
// LayoutItem/LayoutRow、defaultW、segmentToRows 已搬到 ./default-detail-layout，
// 与 DetailLayoutRenderer 共用同一份「无保存布局时的默认布局」推导，避免两套算法要保存一次才对齐。
import { defaultW, segmentToRows, collectFieldsInTabs, deriveDefaultDetailLayout, type LayoutItem, type LayoutRow } from "./default-detail-layout";
// 表单布局版本管理：纯函数层 + 抽屉（回退三步语义见 handleRollback 注释）
import {
  AUTO_BACKUP_LABEL,
  dropUnknownFieldIds,
  historyBlockReason,
  type LayoutSnapshot,
  type LayoutVersionSummary,
  type TabsSnapshotWire,
} from "./form-versioning/versioning";
import { buildTabsSnapshot, isEmptyTabsEntry, restoreTabsConfig, TABS_CLEAR_SUPPORTED } from "./form-versioning/tabs-snapshot";
import { useCreateLayoutVersion, useSaveDetailLayout } from "./form-versioning/useLayoutVersions";
import { VersionHistoryDrawer } from "./form-versioning/VersionHistoryDrawer";

export type PreviewDevice = "desktop" | "mobile";

interface FormDesignerProps {
  open: boolean;
  inline?: boolean;
  fields: FieldDTO[];
  layout: DetailLayout | null;
  tableId: string;
  baseId: string;
  tables: TableDTO[];
  permissions: PermissionSet;
  /**
   * 布局版本历史的归属视图 id。版本是「视图级」的（布局存在 view.config.detailLayout），
   * 没有它就无法读写 /api/views/:viewId/layout-versions，此时历史入口禁用。
   */
  viewId?: string | null;
  onClose: () => void;
  /**
   * 保存布局。**必须返回 Promise 且失败时 reject**（调用方统一用 mutateAsync）。
   * 旧契约是同步 void —— 无论请求成功失败都会 toast「已保存布局」并关闭面板，
   * 断网/409/500 时造成静默数据丢失（P1）。现在只有 await 成功才提示成功并关闭。
   */
  onSave: (next: DetailLayout) => Promise<void>;
}

const fid = (s: string): FieldIdT => s as FieldIdT;

const DT_SOURCE = "application/x-gx-form-designer-source";

/** 设计器内部使用的选项卡结构：rows 为显式行模型（与顶层同构） */
interface TabInternal {
  id: string;
  name: string;
  rows: LayoutRow[];
}

// 拖放目标类型与落点判定（allowed / rejected）统一在 ./drop-target，
// 高亮渲染与松手处理消费同一份结论，避免「高亮在这、落到那」。
import type { DropTarget } from "./drop-target";
import { TABS_NEST_MESSAGE, evaluateDrop, isTabDrop, targetKey } from "./drop-target";

/** 落点槽位的三种视觉状态：未命中 / 可放（高亮）/ 禁放（红色禁止） */
export type DropSlotState = "none" | "allowed" | "rejected";

/** 一行最多容纳的字段数（与 25% 最小列宽对应：4 列） */
const MAX_FIELDS_PER_ROW = 4;

/**
 * 合并到同一行后若总宽超 100%：按字段数均匀压缩到 25 档网格，把一行填满。
 * n=2 → 50/50；n=3 → 50/25/25；n=4 → 25×4。保证「▲ 并入上一行」总能容纳（上一行 <4 字段时）。
 */
function packRowItems(items: LayoutItem[]): LayoutItem[] {
  const sum = items.reduce((s, it) => s + it.widthPct, 0);
  if (sum <= 100) return items;
  const n = items.length;
  let extra = 100 - 25 * n; // 基础 25 之后还剩多少可分配（25 的倍数）
  return items.map((it) => {
    let w: FieldWidthPct = 25;
    if (extra >= 25) { w = 50; extra -= 25; }
    return { ...it, widthPct: w };
  });
}

// ============ 行模型纯函数（顶层与选项卡内共用） ============

/** 保守回流：只把超过 100% 的行拆到下一行，绝不合并用户显式拆出的行 */
function reflowRows(rows: LayoutRow[]): LayoutRow[] {
  const out: LayoutRow[] = [];
  for (const r of rows) {
    let cur: LayoutItem[] = [];
    let sum = 0;
    for (const it of r.items) {
      if (cur.length > 0 && sum + it.widthPct > 100) {
        out.push({ items: cur });
        cur = [];
        sum = 0;
      }
      cur.push(it);
      sum += it.widthPct;
    }
    if (cur.length > 0) out.push({ items: cur });
  }
  return out.filter((r) => r.items.length > 0);
}

const rowWidth = (r: LayoutRow): number => r.items.reduce((s, it) => s + it.widthPct, 0);

function cloneRows(rows: LayoutRow[]): LayoutRow[] {
  return rows.map((r) => ({ items: r.items.map((it) => ({ ...it })) }));
}

function rowsRemoveField(rows: LayoutRow[], fieldId: FieldIdT): LayoutRow[] {
  return rows
    .map((r) => ({ items: r.items.filter((it) => it.fieldId !== fieldId) }))
    .filter((r) => r.items.length > 0);
}

function locateFieldInRows(rows: LayoutRow[], fieldId: FieldIdT): { ri: number; ii: number } | null {
  for (let ri = 0; ri < rows.length; ri++) {
    const ii = rows[ri].items.findIndex((it) => it.fieldId === fieldId);
    if (ii >= 0) return { ri, ii };
  }
  return null;
}

/** ▲ 能否并入上一行：存在上一行且上一行字段数 < 4（并入后按 25 档自动压缩填满，故不再要求宽度放得下） */
function canJoinUp(rows: LayoutRow[], ri: number, _item: LayoutItem): boolean {
  if (ri <= 0) return false;
  const above = rows[ri - 1];
  if (!above) return false;
  return above.items.length < MAX_FIELDS_PER_ROW;
}

/** ▲ 并入上一行：字段移到上一行末尾，并对合并行自动压缩填满（支持 3/4 字段同行） */
function joinUpField(rows: LayoutRow[], fieldId: FieldIdT): LayoutRow[] {
  const next = cloneRows(rows);
  for (let ri = 1; ri < next.length; ri++) {
    const ii = next[ri].items.findIndex((it) => it.fieldId === fieldId);
    if (ii < 0) continue;
    if (next[ri - 1].items.length >= MAX_FIELDS_PER_ROW) return rows;
    const [item] = next[ri].items.splice(ii, 1);
    next[ri - 1].items = packRowItems([...next[ri - 1].items, item]);
    return next.filter((r) => r.items.length > 0);
  }
  return rows;
}

/** ▼ 向下新建一行：字段从当前行移出，在下方拆成独立一行 */
function splitDownField(rows: LayoutRow[], fieldId: FieldIdT): LayoutRow[] {
  const next = cloneRows(rows);
  for (let ri = 0; ri < next.length; ri++) {
    const ii = next[ri].items.findIndex((it) => it.fieldId === fieldId);
    if (ii < 0) continue;
    if (next[ri].items.length <= 1) return rows; // 已独占一行
    const [item] = next[ri].items.splice(ii, 1);
    next.splice(ri + 1, 0, { items: [item] });
    return next.filter((r) => r.items.length > 0);
  }
  return rows;
}

/** 交换同一行内两个相邻字段（fieldId 与它的左邻居） */
function swapLeftField(rows: LayoutRow[], fieldId: FieldIdT): LayoutRow[] {
  const next = cloneRows(rows);
  for (const r of next) {
    const i = r.items.findIndex((it) => it.fieldId === fieldId);
    if (i > 0) {
      [r.items[i - 1], r.items[i]] = [r.items[i], r.items[i - 1]];
      return next;
    }
  }
  return rows;
}

/** 修改某字段宽度后保守回流 */
function setFieldWidthInRows(rows: LayoutRow[], fieldId: FieldIdT, widthPct: FieldWidthPct): LayoutRow[] {
  return reflowRows(rows.map((r) => ({ items: r.items.map((it) => (it.fieldId === fieldId ? { ...it, widthPct } : it)) })));
}

// ============ 选项卡行模型 <-> TabConfig 转换 ============

/** 从已落库 TabConfig 还原内部行模型（旧数据无 rows 时用 fieldIds+widths 自动切行） */
function getTabRows(tab: TabConfig): LayoutRow[] {
  if (tab.rows && tab.rows.length > 0) {
    return tab.rows.map((r) => ({ items: r.items.map((it) => ({ fieldId: fid(it.fieldId), widthPct: it.widthPct as FieldWidthPct })) }));
  }
  return segmentToRows(
    (tab.fieldIds ?? []).map((id) => ({
      fieldId: fid(id),
      widthPct: ((tab.widths?.[id] as FieldWidthPct) ?? 50) as FieldWidthPct,
    })),
  );
}

/** 把内部行模型写回 TabConfig：rows + 双写 fieldIds/widths（兼容旧渲染端） */
function tabWithRows(tab: { id: string; name: string }, rows: LayoutRow[]): TabConfig {
  const items = rows.flatMap((r) => r.items);
  return {
    id: tab.id,
    name: tab.name,
    rows: rows.map((r) => ({ items: r.items.map((it) => ({ fieldId: it.fieldId as string, widthPct: it.widthPct })) })),
    fieldIds: items.map((it) => it.fieldId as string),
    widths: Object.fromEntries(items.map((it) => [it.fieldId as string, it.widthPct])) as Record<string, TabFieldWidth>,
  };
}

const toInternal = (t: TabConfig): TabInternal => ({ id: t.id, name: t.name, rows: getTabRows(t) });

/** 提交前把内部 TabInternal[] 同步成落库 TabConfig[]（rows 与 fieldIds/widths 始终一致） */
function syncTabs(m: Record<string, TabInternal[]>): Record<string, TabConfig[]> {
  return Object.fromEntries(Object.entries(m).map(([k, tabs]) => [k, tabs.map((t) => tabWithRows({ id: t.id, name: t.name }, t.rows))]));
}

/** DetailLayoutRow[] -> 行模型（默认布局推导结果还原为设计器内部表示） */
function rowsFromLayout(layout: DetailLayout): LayoutRow[] {
  return layout.rows.map((r) => ({
    items: r.fieldIds.map((id) => ({
      fieldId: fid(id),
      widthPct: (r.widths?.[id] as FieldWidthPct) ?? 50,
    })),
  }));
}

/**
 * 从已保存布局还原显式行模型：逐行还原，**保留行边界**。
 * 用户用 ▼ 拆出的独立行、用拖放新建的行，保存后必须原样还原，不能被按宽度重新合并。
 * 缺失 widths 的旧字段用流体默认宽度；未出现在布局中的新字段追加到末尾（按宽度自动切行）。
 * **选项卡（tabs）字段**：本身作为全宽容器项；其 tabsConfig 内承载的字段归属 tab，不进顶层行。
 */
function initialRows(layout: DetailLayout | null, fields: FieldDTO[]): LayoutRow[] {
  // 没保存过布局（或布局为空）：与详情页渲染器共用 deriveDefaultDetailLayout，
  // 保证「第一次打开设计器看到的」就是「详情页渲染的」，不需要先保存一次才对齐。
  if (!layout || layout.rows.length === 0) return rowsFromLayout(deriveDefaultDetailLayout(fields));
  const typeById = new Map<string, FieldType>(fields.map((f) => [f.id, f.type]));
  const inTabs = collectFieldsInTabs(fields);
  const seen = new Set<string>();
  const rows: LayoutRow[] = [];
  for (const r of layout?.rows ?? []) {
    const items: LayoutItem[] = [];
    for (const id of r.fieldIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (inTabs.has(id)) continue;
      const t = typeById.get(id);
      const fallback: FieldWidthPct = t ? defaultW(t) : 50;
      const w = r.widths && id in r.widths ? (r.widths[id] as FieldWidthPct) : fallback;
      items.push({ fieldId: fid(id), widthPct: w });
    }
    if (items.length > 0) rows.push({ items });
  }
  const extras = fields
    .filter((f) => !seen.has(f.id) && !inTabs.has(f.id))
    .map((f) => ({ fieldId: f.id as FieldIdT, widthPct: defaultW(f.type) }));
  if (extras.length > 0) rows.push(...segmentToRows(extras));
  return rows;
}

/** 收集所有 tabs 字段的初始配置，并立即规整为内部行模型（TabInternal） */
export function initialTabsConfig(fields: FieldDTO[]): Record<string, TabInternal[]> {
  const out: Record<string, TabInternal[]> = {};
  for (const f of fields) {
    if (f.type === "tabs") {
      const raw = f.tabsConfig && f.tabsConfig.length > 0 ? f.tabsConfig : [{ id: `tab_${f.id}_0`, name: "基本信息", fieldIds: [] as string[] }];
      out[f.id] = raw.map((t) => {
        // 旧数据（无 rows）：用 fieldIds + widths（宽度按字段类型兜底）自动切行
        const rows = t.rows && t.rows.length > 0
          ? t.rows.map((r) => ({ items: r.items.map((it) => ({ fieldId: fid(it.fieldId), widthPct: it.widthPct as FieldWidthPct })) }))
          : segmentToRows(
              (t.fieldIds ?? []).map((id) => {
                const cf = fields.find((x) => x.id === id);
                return { fieldId: fid(id), widthPct: ((t.widths?.[id] as FieldWidthPct) ?? (cf ? defaultW(cf.type) : 50)) as FieldWidthPct };
              }),
            );
        return { id: t.id, name: t.name, rows };
      });
    }
  }
  return out;
}

/**
 * 是否需要补灌一次初始状态：pending = 首屏没数据（见 needsHydrateRef）。
 * 数据仍没到 → 继续等；已补过或首屏就有数据（用户可能已经动过手）→ 一律不补。
 */
export function shouldHydrateOnce(pending: boolean, fields: FieldDTO[], layout: DetailLayout | null): boolean {
  return pending && !(fields.length === 0 && layout == null);
}

/** 字段是否归属任一选项卡容器 */
function isFieldInAnyTab(fieldId: FieldIdT, map: Record<string, TabInternal[]>): boolean {
  return Object.values(map).some((tabs) => tabs.some((t) => t.rows.some((r) => r.items.some((it) => it.fieldId === fieldId))));
}

function toSaved(rows: LayoutRow[]): DetailLayout {
  const layoutRows: DetailLayoutRow[] = rows
    .filter((r) => r.items.length > 0)
    .map((r) => ({
      colCount: 2 as DetailRowColumns,
      fieldIds: r.items.map((i) => i.fieldId),
      widths: Object.fromEntries(r.items.map((i) => [i.fieldId, i.widthPct])) as Record<string, FieldWidthPct>,
    }));
  return { defaultRowColumns: 2 as DetailRowColumns, rows: layoutRows };
}

export function FormDesigner({
  open,
  inline,
  fields,
  layout,
  tableId,
  baseId,
  tables,
  permissions,
  viewId,
  onClose,
  onSave,
}: FormDesignerProps) {
  const [rows, setRows] = useState<LayoutRow[]>(() => initialRows(layout, fields));
  // 选项卡容器配置（内部行模型）：tabs 字段 id -> TabInternal[]
  const [tabsConfigMap, setTabsConfigMap] = useState<Record<string, TabInternal[]>>(() => initialTabsConfig(fields));
  const [activeTabMap, setActiveTabMap] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [k, cfg] of Object.entries(initialTabsConfig(fields))) init[k] = cfg[0]?.id ?? "";
    return init;
  });
  // ?design=1 那条入口下，首屏 fields 还没到（异步），惰性初始化会拿到空数组，
  // 之后 state 不会自动重灌 → 已保存的选项卡不渲染，再保存就会把真实 tabsConfig 覆盖掉。
  // 这里只在「首屏确实没数据、后来数据到了」时补灌一次；用户已经动过手的情况绝不覆盖。
  const needsHydrateRef = useRef(fields.length === 0 || layout == null);
  useEffect(() => {
    if (!shouldHydrateOnce(needsHydrateRef.current, fields, layout)) return;
    needsHydrateRef.current = false;
    setRows(initialRows(layout, fields));
    const nextTabs = initialTabsConfig(fields);
    setTabsConfigMap(nextTabs);
    setActiveTabMap(Object.fromEntries(Object.entries(nextTabs).map(([k, cfg]) => [k, cfg[0]?.id ?? ""])));
  }, [fields, layout]);
  const [selectedFieldId, setSelectedFieldId] = useState<FieldIdT | null>(null);
  const [dragFieldId, setDragFieldId] = useState<FieldIdT | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** 当前落点是否为禁放区（null=可放）；禁放时渲染禁止样式且松手不移动 */
  const [dropReject, setDropReject] = useState<string | null>(null);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");
  const [creating, setCreating] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  // ref 镜像最新行/选项卡状态：placeField 在 await 创建字段之后才执行，
  // 闭包里的 rows/tabsConfigMap 可能已过期（用户期间拖过别的字段），用 ref 保证读到最新值。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const tabsRef = useRef(tabsConfigMap);
  tabsRef.current = tabsConfigMap;
  const dropTargetRef = useRef<DropTarget | null>(null);
  dropTargetRef.current = dropTarget;
  const dropRejectRef = useRef<string | null>(null);
  dropRejectRef.current = dropReject;
  /** 正在被拖动的字段类型（字段库新字段=目标类型；画布内拖动=该字段类型）。
      落点判定必须在**计算落点**那一层就知道它，才能提前产出 allowed/rejected。 */
  const dragTypeRef = useRef<FieldType | null>(null);
  // dragover 高频触发：用 rAF 合帧 + 落点浅比较，相同落点不重复 setState（消除闪烁）
  const dragRafRef = useRef<number | null>(null);
  const lastTargetKeyRef = useRef<string>("");

  const m = useGXMutations();

  const fieldById = new Map<FieldIdT, FieldDTO>();
  for (const f of fields) fieldById.set(f.id, f);

  const selectedField = selectedFieldId ? fieldById.get(selectedFieldId) ?? null : null;
  // 顶层行内字段；或归属选项卡的字段（宽度取自 tab 行模型）
  const selectedItem: LayoutItem | null = (() => {
    if (!selectedFieldId) return null;
    const top = rows.flatMap((r) => r.items).find((i) => i.fieldId === selectedFieldId);
    if (top) return top;
    for (const tabs of Object.values(tabsConfigMap)) {
      for (const t of tabs) {
        for (const r of t.rows) {
          const it = r.items.find((x) => x.fieldId === selectedFieldId);
          if (it) return it;
        }
      }
    }
    return null;
  })();

  // ---------- 字段定位 / 行模型操作（顶层与选项卡统一路由） ----------

  type FieldLoc = { kind: "top" } | { kind: "tab"; containerId: string; tabId: string };

  const locateFieldAnywhere = (fieldId: FieldIdT): FieldLoc | null => {
    if (rows.some((r) => r.items.some((it) => it.fieldId === fieldId))) return { kind: "top" };
    for (const [containerId, tabs] of Object.entries(tabsConfigMap)) {
      for (const t of tabs) {
        if (locateFieldInRows(t.rows, fieldId)) return { kind: "tab", containerId, tabId: t.id };
      }
    }
    return null;
  };

  /** 对某个选项卡的行模型做纯函数变换 */
  const mutateTabRows = (containerId: string, tabId: string, fn: (rs: LayoutRow[]) => LayoutRow[]) => {
    setTabsConfigMap((prev) => ({
      ...prev,
      [containerId]: (prev[containerId] ?? []).map((t) => (t.id === tabId ? { ...t, rows: fn(cloneRows(t.rows)) } : t)),
    }));
  };

  /** ▲ 并入上一行（自动路由顶层 / 选项卡） */
  const joinUp = (fieldId: FieldIdT) => {
    const loc = locateFieldAnywhere(fieldId);
    if (loc?.kind === "top") setRows((prev) => joinUpField(prev, fieldId));
    else if (loc?.kind === "tab") mutateTabRows(loc.containerId, loc.tabId, (rs) => joinUpField(rs, fieldId));
  };

  /** ▼ 向下新建一行 */
  const splitDown = (fieldId: FieldIdT) => {
    const loc = locateFieldAnywhere(fieldId);
    if (loc?.kind === "top") setRows((prev) => splitDownField(prev, fieldId));
    else if (loc?.kind === "tab") mutateTabRows(loc.containerId, loc.tabId, (rs) => splitDownField(rs, fieldId));
  };

  /** ⇄ 与左邻交换 */
  const swapWithLeft = (fieldId: FieldIdT) => {
    const loc = locateFieldAnywhere(fieldId);
    if (loc?.kind === "top") setRows((prev) => swapLeftField(prev, fieldId));
    else if (loc?.kind === "tab") mutateTabRows(loc.containerId, loc.tabId, (rs) => swapLeftField(rs, fieldId));
  };

  /** 右栏「字段占比」统一入口 */
  const setSelectedWidth = (fieldId: FieldIdT, widthPct: FieldWidthPct) => {
    const loc = locateFieldAnywhere(fieldId);
    if (loc?.kind === "tab") mutateTabRows(loc.containerId, loc.tabId, (rs) => setFieldWidthInRows(rs, fieldId, widthPct));
    else setRows((prev) => setFieldWidthInRows(prev, fieldId, widthPct));
  };

  const removeField = (fieldId: FieldIdT) => {
    setRows((prev) => rowsRemoveField(prev, fieldId));
    setTabsConfigMap((prev) => {
      const next: Record<string, TabInternal[]> = {};
      for (const [k, tabs] of Object.entries(prev)) {
        next[k] = tabs.map((t) => ({ ...t, rows: rowsRemoveField(t.rows, fieldId) }));
      }
      return next;
    });
    if (selectedFieldId === fieldId) setSelectedFieldId(null);
  };

  /** 复制字段：新建同类型字段，插到源字段同位置后 */
  const duplicateField = async (fieldId: FieldIdT) => {
    const src = fieldById.get(fieldId);
    if (!src) return;
    if (!permissions.canManageSchema) {
      toast("无表结构管理权限", "error");
      return;
    }
    setCreating(true);
    try {
      const data: Record<string, unknown> = { name: `${src.name} 副本`, type: src.type };
      // 完整复制字段配置，避免复制出无配置半成品
      if (src.type === "singleSelect" || src.type === "multiSelect") data.options = src.options;
      if (["number", "currency", "percent", "duration"].includes(src.type)) data.precision = src.precision ?? 0;
      if (src.type === "formula") data.formula = src.formula ?? "";
      if (src.type === "links" || src.type === "subtable") {
        data.relatedTableId = src.relatedTableId ?? "";
        data.relationKind = src.relationKind ?? "mm";
        data.linkDisplayFieldId = src.linkDisplayFieldId ?? "";
        if (src.type === "subtable") { data.displayedFieldIds = (src as { displayedFieldIds?: string[] }).displayedFieldIds ?? []; }
      }
      if (src.type === "lookup" || src.type === "rollup" || src.type === "count") {
        data.linkFieldId = src.linkFieldId ?? "";
        if (src.type === "lookup" || src.type === "rollup") data.lookupFieldId = src.lookupFieldId ?? "";
        if (src.type === "rollup" || src.type === "count") data.rollupFunction = src.type === "count" ? "count" : (src.rollupFunction ?? "sum");
      }
      const srf = src as { recordFilter?: unknown };
      if (srf.recordFilter) data.recordFilter = srf.recordFilter;
      if (src.type === "tabs") data.tabsConfig = [{ id: `tab_new_${Date.now()}`, name: "基本信息", fieldIds: [] }];
      const result = await m.createField.mutateAsync({ tableId, data });
      const created = (result as { field?: FieldDTO }).field;
      if (!created?.id) throw new Error("复制失败");

      const tabsInject = src.type === "tabs"
        ? { containerId: created.id as FieldIdT, tabs: [{ id: `tab_${created.id}_0`, name: "基本信息", fieldIds: [] as string[] }] as TabConfig[], activeTabId: `tab_${created.id}_0` }
        : undefined;

      // 定位源字段（基于 ref 最新状态）：顶层行 → 同行其后；选项卡内 → 同 tab 同行其后
      let target: DropTarget | null = null;
      const topLoc = locateFieldInRows(rowsRef.current, fieldId);
      if (topLoc) target = { kind: "row", rowIndex: topLoc.ri, beforeIndex: topLoc.ii + 1 };
      if (!target) {
        for (const [containerId, tabs] of Object.entries(tabsRef.current)) {
          for (const t of tabs) {
            const loc = locateFieldInRows(t.rows, fieldId);
            if (loc) target = { kind: "tab", containerFieldId: fid(containerId), tabId: t.id, rowIndex: loc.ri, beforeIndex: loc.ii + 1 };
          }
        }
      }
      // 复制 tabs 容器本身只能落顶层行（target 在此只会是 row/tab/null）
      const finalTarget: DropTarget = src.type === "tabs" && target?.kind === "tab"
        ? { kind: "line", rowIndex: rowsRef.current.length }
        : (target ?? { kind: "line", rowIndex: rowsRef.current.length });
      placeField(created.id, finalTarget, true, defaultW(created.type), tabsInject);
      setSelectedFieldId(created.id);
    } catch (err) {
      toast((err as Error).message || "复制字段失败", "error");
    } finally {
      setCreating(false);
    }
  };

  // ---------- 选项卡（tabs）容器操作 ----------

  const tabsCfg = (tabsFieldId: FieldIdT): TabInternal[] => tabsConfigMap[tabsFieldId] ?? [];

  const addTab = (containerId: FieldIdT) => {
    const cur = tabsConfigMap[containerId] ?? [];
    const tab: TabInternal = { id: `tab_${containerId}_${Date.now()}`, name: `选项卡 ${cur.length + 1}`, rows: [] };
    setTabsConfigMap({ ...tabsConfigMap, [containerId]: [...cur, tab] });
    setActiveTabMap({ ...activeTabMap, [containerId]: tab.id });
  };

  const removeTab = (containerId: FieldIdT, tabId: string) => {
    const tabs = tabsConfigMap[containerId] ?? [];
    if (tabs.length <= 1) { toast("至少保留一个选项卡", "error"); return; }
    const removed = tabs.find((t) => t.id === tabId);
    const orphanItems = removed ? removed.rows.flatMap((r) => r.items).map((it) => ({ ...it })) : [];
    const next = tabs.filter((t) => t.id !== tabId);
    setTabsConfigMap({ ...tabsConfigMap, [containerId]: next });
    if (activeTabMap[containerId] === tabId) {
      setActiveTabMap({ ...activeTabMap, [containerId]: next[0]?.id ?? "" });
    }
    // 被删 tab 内的字段退回顶层末尾（保留宽度，自动切行）
    if (orphanItems.length > 0) setRows((rp) => [...rp, ...segmentToRows(orphanItems)]);
  };

  const renameTab = (containerId: FieldIdT, tabId: string, name: string) => {
    setTabsConfigMap((prev) => ({
      ...prev,
      [containerId]: (prev[containerId] ?? []).map((t) => (t.id === tabId ? { ...t, name } : t)),
    }));
  };

  /**
   * 删除整个选项卡容器字段（①）。
   *  - 从顶层行移除该容器字段；
   *  - 容器内承载的字段不丢失，退回顶层末尾（保留宽度，自动切行）；
   *  - 物理删除该 tabs 字段本身（后端会清理字段定义）；tabsConfig 无需单独清理（字段没了）。
   */
  const deleteTabsContainer = async (containerId: FieldIdT) => {
    const f = fieldById.get(containerId);
    const containerName = f?.name ?? "选项卡分组";
    // R-D-23 L2 普通确认（容器内的字段会退回表单末尾，不会丢）+ R-D-24 具体动词
    const ok = await confirmAction({
      title: `删除「${containerName}」`,
      confirmText: "删除分组",
      description: "分组内的字段会退回表单末尾，不会被删除。",
      level: 2,
    });
    if (!ok) return;
    if (!permissions.canManageSchema) { toast("无表结构管理权限", "error"); return; }

    // 1) 先收集容器内字段，退回顶层（基于 ref 最新状态）
    const orphans: LayoutItem[] = [];
    for (const tabs of Object.values(tabsRef.current[containerId] ?? [])) {
      for (const r of tabs.rows) for (const it of r.items) orphans.push({ ...it });
    }
    setRows((prev) => {
      const removed = rowsRemoveField(prev, containerId);
      return orphans.length > 0 ? [...removed, ...segmentToRows(orphans)] : removed;
    });
    // 2) 清掉本地 tabsConfig 中该容器
    setTabsConfigMap((prev) => {
      const next = { ...prev };
      delete next[containerId as string];
      return next;
    });
    if (selectedFieldId === containerId) setSelectedFieldId(null);

    // 3) 物理删除字段（失败仅提示：布局已移除，不影响保存）
    try {
      const fieldId = containerId as string;
      await m.deleteField.mutateAsync({ fieldId, tableId });
      // 阶段 4 · R-I-08：字段是软删除（进回收站），toast 必须带撤销
      toastDeleted({
        message: `已删除「${containerName}」`,
        restoredMessage: `已恢复「${containerName}」`,
        onUndo: () => m.restoreTrash.mutateAsync({ id: fieldId, kind: "field", baseId }),
      });
    } catch (err) {
      toast((err as Error).message || "删除选项卡字段失败", "error");
    }
  };

  const setActiveTab = (containerId: FieldIdT, tabId: string) => {
    setActiveTabMap((prev) => ({ ...prev, [containerId]: tabId }));
  };

  /**
   * 把字段放到指定位置（row/line/tab/tabLine）。移动时先从顶层行与所有选项卡摘除。
   * injectTabs：新建 tabs 字段时，顺带注入该容器的初始配置（单次提交）。
   */
  const placeField = (fieldId: FieldIdT, target: DropTarget, isNew: boolean, width?: FieldWidthPct, injectTabs?: { containerId: FieldIdT; tabs: TabConfig[]; activeTabId: string }) => {
    const nextRows: LayoutRow[] = cloneRows(rowsRef.current);
    const nextTabs: Record<string, TabInternal[]> = {};
    for (const [k, tabs] of Object.entries(tabsRef.current)) {
      nextTabs[k] = tabs.map((t) => ({ id: t.id, name: t.name, rows: cloneRows(t.rows) }));
    }
    if (injectTabs) {
      nextTabs[injectTabs.containerId] = injectTabs.tabs.map(toInternal);
      setActiveTabMap((prev) => ({ ...prev, [injectTabs.containerId]: injectTabs.activeTabId }));
    }

    const f = fieldById.get(fieldId);
    let w: FieldWidthPct = width ?? (f ? defaultW(f.type) : 50);
    if (!isNew) {
      for (const r of nextRows) {
        const i = r.items.findIndex((it) => it.fieldId === fieldId);
        if (i >= 0) { w = r.items[i].widthPct; r.items.splice(i, 1); }
      }
      for (const tabs of Object.values(nextTabs)) {
        for (const t of tabs) {
          for (const r of t.rows) {
            const i = r.items.findIndex((it) => it.fieldId === fieldId);
            if (i >= 0) { w = r.items[i].widthPct; r.items.splice(i, 1); }
          }
        }
      }
    }

    const item: LayoutItem = { fieldId, widthPct: w };

    // 合并进某行后：若该行无 100% 宽字段且 ≤4 个，则均匀压缩填满（让第 3/4 个字段能同行）；
    // 含宽字段（长文本/附件/关联等 100%）时不压缩，交给 reflowRows 拆行。
    const packIfFit = (rowItems: LayoutItem[]): LayoutItem[] => {
      if (rowItems.some((it) => it.widthPct >= 100)) return rowItems;
      if (rowItems.length > MAX_FIELDS_PER_ROW) return rowItems;
      return packRowItems(rowItems);
    };

    if (target.kind === "tab" || target.kind === "tabLine") {
      const tab = nextTabs[target.containerFieldId]?.find((t) => t.id === target.tabId);
      if (tab) {
        if (target.kind === "tabLine") {
          tab.rows.splice(Math.max(0, Math.min(target.rowIndex, tab.rows.length)), 0, { items: [item] });
        } else {
          const ri = Math.max(0, Math.min(target.rowIndex, Math.max(0, tab.rows.length - 1)));
          if (!tab.rows[ri]) tab.rows.push({ items: [] });
          const idx = Math.max(0, Math.min(target.beforeIndex, tab.rows[ri].items.length));
          tab.rows[ri].items.splice(idx, 0, item);
          tab.rows[ri].items = packIfFit(tab.rows[ri].items);
          tab.rows = reflowRows(tab.rows); // 保守回流（只拆不合）
        }
      }
      setTabsConfigMap(nextTabs);
      setRows(nextRows.filter((r) => r.items.length > 0));
      return;
    }

    if (target.kind === "line") {
      nextRows.splice(Math.max(0, Math.min(target.rowIndex, nextRows.length)), 0, { items: [item] });
    } else {
      const ri = Math.max(0, Math.min(target.rowIndex, nextRows.length - 1));
      if (!nextRows[ri]) nextRows.push({ items: [] });
      const idx = Math.max(0, Math.min(target.beforeIndex, nextRows[ri].items.length));
      nextRows[ri].items.splice(idx, 0, item);
      nextRows[ri].items = packIfFit(nextRows[ri].items);
    }
    setTabsConfigMap(nextTabs);
    setRows(reflowRows(nextRows).filter((r) => r.items.length > 0));
  };

  // ---------- 拖放 ----------

  const createFieldFromPalette = async (type: FieldType, target: DropTarget) => {
    if (!permissions.canManageSchema) {
      toast("无表结构管理权限", "error");
      return;
    }
    const label = TYPE_GROUPS.flatMap((g) => g.items).find((it) => it.type === type)?.label ?? "新字段";
    // 禁放区在**创建字段之前**就拒绝：否则会先落库一个字段再把它塞到别处，
    // 用户看到的是「字段莫名出现在表单末尾」。
    const verdict = evaluateDrop(type, target);
    if (!verdict.allowed) {
      toast(verdict.reason ?? TABS_NEST_MESSAGE, "error");
      return;
    }
    setCreating(true);
    try {
      const data: Record<string, unknown> = { name: `${label}${Date.now().toString().slice(-4)}`, type };
      let defaultTab: TabConfig | null = null;
      if (type === "tabs") {
        defaultTab = { id: `tab_new_${Date.now()}`, name: "基本信息", fieldIds: [] };
        data.tabsConfig = [defaultTab];
      }
      const result = await m.createField.mutateAsync({ tableId, data });
      const created = (result as { field?: FieldDTO }).field;
      if (!created?.id) throw new Error("创建字段失败");
      if (type === "tabs" && defaultTab) {
        const tab0 = { ...defaultTab, id: `tab_${created.id}_0` };
        // 落点已在入口判定为可放（选项卡不能套选项卡已提前拒绝），这里直接用原落点
        placeField(created.id, target, true, 100, { containerId: created.id, tabs: [tab0], activeTabId: tab0.id });
      } else {
        placeField(created.id, target, true, defaultW(type));
      }
      setSelectedFieldId(created.id);
    } catch (err) {
      toast((err as Error).message || "创建字段失败", "error");
    } finally {
      setCreating(false);
    }
  };

  const computeDropTarget = (clientX: number, clientY: number): DropTarget => {
    const el = document.elementFromPoint(clientX, clientY);

    // 1) 选项卡内字段卡 → 插入该 tab 的某行（按左/右半定前后）
    const tabCard = el?.closest<HTMLElement>("[data-tab-field]");
    if (tabCard) {
      const containerFieldId = fid(tabCard.dataset.tabContainer!);
      const tabId = tabCard.dataset.tabId!;
      const rowIndex = Number(tabCard.dataset.tabRow);
      const cardFieldId = fid(tabCard.dataset.tabField!);
      const tab = (tabsConfigMap[containerFieldId] ?? []).find((t) => t.id === tabId);
      const trs = tab?.rows ?? [];
      const ii = trs[rowIndex]?.items.findIndex((it) => it.fieldId === cardFieldId) ?? -1;
      const r = tabCard.getBoundingClientRect();
      const after = clientX > r.left + r.width / 2;
      return { kind: "tab", containerFieldId, tabId, rowIndex, beforeIndex: after ? ii + 1 : Math.max(0, ii) };
    }
    // 2) 选项卡内行间虚线带 → 在该 tab 内新建一行
    const tabGap = el?.closest<HTMLElement>("[data-tab-gap]");
    if (tabGap) {
      return { kind: "tabLine", containerFieldId: fid(tabGap.dataset.tabContainer!), tabId: tabGap.dataset.tabId!, rowIndex: Number(tabGap.dataset.tabGap) };
    }
    // 3) 选项卡标题（拖到别的选项卡头）→ 追加到该选项卡末尾新行
    const tabHeader = el?.closest<HTMLElement>("[data-tab-header]");
    if (tabHeader) {
      const containerFieldId = fid(tabHeader.dataset.tabContainer!);
      const tabId = tabHeader.dataset.tabId!;
      const rowCount = (tabsConfigMap[containerFieldId] ?? []).find((t) => t.id === tabId)?.rows.length ?? 0;
      return { kind: "tabLine", containerFieldId, tabId, rowIndex: rowCount };
    }
    // 4) 选项卡内容空白区 → 末尾新建一行
    const tabBody = el?.closest<HTMLElement>("[data-tab-body]");
    if (tabBody) {
      const containerFieldId = fid(tabBody.dataset.tabContainer!);
      const tabId = tabBody.dataset.tabId!;
      const rowCount = (tabsConfigMap[containerFieldId] ?? []).find((t) => t.id === tabId)?.rows.length ?? 0;
      return { kind: "tabLine", containerFieldId, tabId, rowIndex: rowCount };
    }
    // 5) 顶层行间虚线带
    const gap = el?.closest<HTMLElement>("[data-row-gap]");
    if (gap) return { kind: "line", rowIndex: Number(gap.dataset.rowGap) };
    // 6) 顶层字段卡（插入该行）
    const cardEl = el?.closest<HTMLElement>("[data-field-card]");
    if (cardEl) {
      const cardFieldId = cardEl.dataset.fieldId as FieldIdT;
      for (let ri = 0; ri < rows.length; ri++) {
        for (let ii = 0; ii < rows[ri].items.length; ii++) {
          if (rows[ri].items[ii].fieldId === cardFieldId) {
            const r = cardEl.getBoundingClientRect();
            const after = clientX > r.left + r.width / 2;
            return { kind: "row", rowIndex: ri, beforeIndex: after ? ii + 1 : ii };
          }
        }
      }
    }
    // 空白：新建一行到末尾
    return { kind: "line", rowIndex: rowsRef.current.length };
  };

  /** rAF 合帧 + 浅比较更新落点：同一帧多次 dragover 只算一次，落点不变不重渲染。
   *  同时在这里产出 allowed/rejected，让高亮与松手处理消费同一份结论。 */
  const scheduleDropTarget = (compute: () => DropTarget) => {
    if (dragRafRef.current != null) return; // 本帧已排队
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const t = compute();
      const k = targetKey(t);
      if (k !== lastTargetKeyRef.current) {
        lastTargetKeyRef.current = k;
        dropTargetRef.current = t;
        setDropTarget(t);
      }
      // 落点不变也要刷新判定：拖动类型变化时（换了个字段拖到同一处）结论可能不同
      const verdict = evaluateDrop(dragTypeRef.current, t);
      dropRejectRef.current = verdict.reason;
      setDropReject(verdict.reason);
    });
  };

  /** 禁放区光标：dropEffect=none 让浏览器显示「禁止」而非「复制/移动」 */
  const applyDropEffect = (e: React.DragEvent, source: "row" | "palette" | null) => {
    e.dataTransfer.dropEffect = dropRejectRef.current
      ? "none"
      : source === "palette"
        ? "copy"
        : "move";
  };

  const readDrag = (e: React.DragEvent): { fieldId: FieldIdT | null; source: "row" | "palette" | null; type: FieldType | null } => {
    const raw = e.dataTransfer.getData("text/plain");
    if (raw.startsWith("palette:")) return { fieldId: null, source: "palette", type: raw.slice(8) as FieldType };
    return { fieldId: raw ? fid(raw) : null, source: e.dataTransfer.getData(DT_SOURCE) as "row" | null, type: null };
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const { source } = readDrag(e);
    applyDropEffect(e, source);
    const { clientX, clientY } = e;
    scheduleDropTarget(() => computeDropTarget(clientX, clientY));
  };

  const handleGapDragOver = (rowIndex: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { source } = readDrag(e);
    applyDropEffect(e, source);
    scheduleDropTarget(() => ({ kind: "line", rowIndex }));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { fieldId, source, type } = readDrag(e);
    // 复用 dragover 阶段已确定的落点（与高亮一致），避免在 drop 时重算导致「显示插这、落到那」
    const target = dropTargetRef.current ?? computeDropTarget(e.clientX, e.clientY);
    if (source === "palette" && type) {
      void createFieldFromPalette(type, target);
    } else if (source === "row" && fieldId) {
      // 禁放区：不移动 + 明确告知原因（原来是静默改落到顶层末尾，落点与高亮不一致）
      const verdict = evaluateDrop(dragTypeRef.current ?? fieldById.get(fieldId)?.type, target);
      if (!verdict.allowed) {
        toast(verdict.reason ?? TABS_NEST_MESSAGE, "error");
        endDrag();
        return;
      }
      placeField(fieldId, target, false);
    }
    endDrag();
  };

  const endDrag = () => {
    if (dragRafRef.current != null) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null; }
    lastTargetKeyRef.current = "";
    dropTargetRef.current = null;
    dropRejectRef.current = null;
    dragTypeRef.current = null;
    setDragFieldId(null);
    setDragActive(false);
    setDropTarget(null);
    setDropReject(null);
  };

  const beginDragFromRow = (id: FieldIdT, e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.setData(DT_SOURCE, "row");
    e.dataTransfer.effectAllowed = "move";
    // 记下拖动类型：落点判定在 dragover 阶段就要用它产出 allowed/rejected
    dragTypeRef.current = fieldById.get(id)?.type ?? null;
    setDragFieldId(id);
    setDragActive(true);
  };

  const beginDragFromPalette = (type: FieldType, e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", `palette:${type}`);
    e.dataTransfer.setData(DT_SOURCE, "palette");
    e.dataTransfer.effectAllowed = "copy";
    dragTypeRef.current = type;
    setDragActive(true);
  };

  const savingRef = useRef(false);
  // 保存失败的真实原因（后端 message 优先，兜底「保存失败，请重试」）。
  // 非空时面板内常驻错误条 + 已弹 toast，**面板保持打开**，用户改完可以直接重试。
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ============ 布局版本历史（回退三步语义） ============
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const createLayoutVersion = useCreateLayoutVersion(viewId);
  // 布局 + 选项卡「一次事务」保存（取代串行的 PATCH views + N 个 PATCH fields，避免半回滚）
  const saveDetailLayout = useSaveDetailLayout(viewId, tableId);
  const historyReason = historyBlockReason(viewId);

  /** 当前编辑器草稿 -> 快照信封（自动备份 / 手动留档两种写入共用） */
  const draftSnapshot = (): { layout: DetailLayout; tabs: Record<string, TabsSnapshotWire> } => ({
    layout: toSaved(rowsRef.current),
    // 结构化入信封：容器 id -> TabConfig[]，页名 / 宽度 / 行边界一起存，回退时才能原样还原
    // （扁平 cards 会把宽度与行边界丢掉，回来的是平铺版，等于假回退）。
    tabs: buildTabsSnapshot(syncTabs(tabsRef.current)),
  });

  /** 抽屉里「存为新版本」：把当前草稿存成一个带备注的版本 */
  const handleCreateVersion = async (label: string) => {
    try {
      await createLayoutVersion.mutateAsync({ snapshot: draftSnapshot(), label });
      toast("已把当前草稿存为新版本", "success");
    } catch (err) {
      toast(errorMessageOf(err, "保存版本失败"), "error");
      throw err; // 抽屉据此不清空输入框
    }
  };

  /**
   * 回退三步（产品语义，顺序不可改）：
   *   ① 先把编辑器里**当前未保存的草稿**存成一个版本（备注「回退前自动备份」）—— 保护起来；
   *   ② 再把选中历史版本的 rows 与 tabs 填回编辑器草稿区；
   *   ③ **不落库**：不碰 onSave / 不写 view.config，由用户看完点「保存布局」才真正写入。
   *
   * ① 失败就整体中止：宁可让用户手动重试，也不能在草稿没保住的情况下覆盖它。
   */
  const handleRollback = async ({ summary, snapshot }: { summary: LayoutVersionSummary; snapshot: LayoutSnapshot }) => {
    if (rollingBack) return;
    setRollingBack(true);
    try {
      // ① 自动备份当前草稿
      try {
        await createLayoutVersion.mutateAsync({ snapshot: draftSnapshot(), label: AUTO_BACKUP_LABEL });
      } catch (err) {
        const reason = errorMessageOf(err, "备份当前草稿失败");
        // 保护机制的语义必须说满：备份失败 = 这次回退**不可撤销**，所以是"已取消回退"，
        // 不是"回退完成但备份没成"。只抛后端原因用户会以为回退已经做完了。
        const msg = `未能创建回退前的备份，已取消本次回退，草稿未改动（${reason}）`;
        setSaveError(msg);
        toast(msg, "error");
        return; // 草稿没保住 —— 中止，不覆盖
      }

      // ② 填回草稿区
      //    - rows：快照里已被删掉的字段直接跳过（不能凭快照复活字段）
      const known = new Set(fields.map((f) => f.id));
      // 该版本本来就没排字段 -> 忠实清空画布；不能退化成「默认布局」（那就不是回退了）
      const target = dropUnknownFieldIds(snapshot.layout, known);
      setRows(target && target.rows.length > 0 ? initialRows(target, fields) : []);
      //    - tabs：快照里有、但当前表上这个 tabs 字段已经被删了 -> 跳过，不中断整个回退
      let unclearable = 0;
      if (snapshot.tabs) {
        // 骨架取**编辑器本地**的选项卡配置（含未保存的改名/改宽），而不是 props.fields 的落库快照，
        // 这样重建出来的页 id / 页名与用户此刻看到的一致。
        const currentSynced = syncTabs(tabsRef.current);
        const next: Record<string, TabInternal[]> = { ...tabsRef.current };
        for (const [containerId, entry] of Object.entries(snapshot.tabs)) {
          const f = fields.find((x) => x.id === containerId);
          if (!f || f.type !== "tabs") continue; // 已删 / 类型变了 -> 跳过
          // 目标版本里这个容器是 0 页（真实信封里长这样：`{ cards: [], lazyTouched: [] }`，
          // **没有 tabs 键** —— 后端只在非空时才落这个键，所以判据不能写成 tabs.length===0，
          // 那样永远 false）。可达性见 TABS_CLEAR_SUPPORTED 的注释：UI 今天造不出 0 页容器，
          // 这里是给"API 造出来的 / 将来的清空入口 / 外来快照"兜的防线，不是功能开关。
          // 后端写不进空数组（见 TABS_CLEAR_SUPPORTED），照常"清空"会得到「UI 上干净、点了保存、
          // 刷新后旧分页原样回来」的假象 —— 比不清空更糟；故保留原样并明确告知，
          // A1 裁决支持清空后闸门翻 true，这里自动放开成真清空。
          if (isEmptyTabsEntry(entry) && !TABS_CLEAR_SUPPORTED) {
            unclearable += 1;
            continue;
          }
          next[containerId] = restoreTabsConfig(entry, currentSynced[containerId] ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            rows: t.rows && t.rows.length > 0
              ? t.rows.map((r) => ({ items: r.items.map((it) => ({ fieldId: fid(it.fieldId), widthPct: it.widthPct as FieldWidthPct })) }))
              : segmentToRows((t.fieldIds ?? []).map((id) => {
                  const cf = fields.find((x) => x.id === id);
                  return { fieldId: fid(id), widthPct: ((t.widths?.[id] as FieldWidthPct) ?? (cf ? defaultW(cf.type) : 50)) as FieldWidthPct };
                })),
          }));
        }
        setTabsConfigMap(next);
      }

      // ③ 不落库：这里**故意不调用** doSave / onSave
      const notes: string[] = [];
      if (unclearable > 0) notes.push(`${unclearable} 个容器在目标版本里是 0 页，但当前版本无法清空（服务端限制），已保留原样`);
      toast(
        notes.length > 0
          ? `已把 v${summary.version} 填回编辑器；${notes.join("；")}。确认后点「保存布局」生效`
          : `已把 v${summary.version} 填回编辑器，确认后点「保存布局」生效`,
        "success",
      );
      setHistoryOpen(false);
    } finally {
      setRollingBack(false);
    }
  };

  const handleSave = async () => {
    if (savingRef.current) return; // 防重复提交（快速连点）
    savingRef.current = true;
    setSaving(true);
    try {
      await doSave();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const doSave = async () => {
    // 先把所有选项卡容器的 tabsConfig 落库。
    // 注意：必须遍历**本地 tabsConfigMap 的 key**，而不是 props.fields —— 设计器内新建的 tabs
    // 容器可能还没异步加载进 fields 快照，用快照会漏掉新容器，导致它的 tab 内字段不保存（P0）。
    const synced = syncTabs(tabsConfigMap);
    const layout = toSaved(rows);

    // 服务端在落库前会剔除「布局里引用了、但表里已删除」的字段。静默剔除 = 静默数据丢失，
    // 必须由 UI 说出来（见 useLayoutVersions 的 useSaveDetailLayout 注释）。
    // 注：后端对「引用已删字段」是 fail-closed 直接 400，所以正常情况下这里恒为空数组；
    // 留着是纵深防御 —— 真触发了（并发删字段 / 后端将来放宽校验）就是真丢字段，正该提示。
    let removed: string[] = [];
    // 发了但服务端没写进去的容器键 —— 又一处静默 no-op，同样要说出来
    let skipped: string[] = [];

    // 只有 await 成功才提示成功并关闭；失败保持面板打开（P1 静默数据丢失修复）
    const ok = await runSaveLayout(layout, {
      persist: async (next) => {
        if (viewId) {
          // 一次事务写布局 + 所有选项卡配置：中途失败不会留下「布局回去了、选项卡没回去」
          // 的半回滚状态（那比完全不保存更糟）。服务端写完统一触发自动留档。
          const res = await saveDetailLayout.mutateAsync({ detailLayout: next, tabs: synced });
          removed = res.removedFieldIds ?? [];
          // 契约上 skipped 恒为数组；留 `?? []` 只防"新前端 + 旧接口"跨版本部署时炸在成功回调里
          skipped = res.skipped ?? [];
          return;
        }
        // 没有 viewId 的宿主（理论上当前两个宿主都传了）：退回老的多请求串联，
        // 至少还能保存，不因为拿不到视图 id 就整个存不了。
        await Promise.all(
          Object.keys(synced).map((containerId) =>
            // 只提交 tabsConfig 这一个字段：PATCH 是部分更新，把 name / type / options 一起
            // 盖回去属于误伤（会覆盖别人在此期间改过的字段名）。
            m.updateField.mutateAsync({ fieldId: containerId, tableId, data: { tabsConfig: synced[containerId]! } }),
          ),
        );
        await onSave(next);
      },
      onSuccess: () => {
        setSaveError(null);
        // 版本列表的失效由 useSaveDetailLayout 的 onSuccess 统一做（那里还一并失效 views/fields）
        const caveats: string[] = [];
        if (removed.length > 0) caveats.push(`其中 ${removed.length} 个字段在表里已不存在，已从布局中移除`);
        if (skipped.length > 0) caveats.push(`有 ${skipped.length} 个选项卡容器没能写入，请检查后重试`);
        toast(caveats.length > 0 ? `${SAVE_OK_TEXT}；${caveats.join("；")}` : SAVE_OK_TEXT, "success");
        onClose();
      },
      onError: (message) => {
        setSaveError(message);
        toast(message, "error");
      },
    });
    if (!ok) return; // 面板保持打开，等待用户重试
  };

  /** 顶层行间带：命中即高亮，并带出该落点是「可放」还是「禁放」 */
  const gapState = (rowIndex: number): DropSlotState => {
    if (!dragActive || dropTarget?.kind !== "line" || dropTarget.rowIndex !== rowIndex) return "none";
    return dropReject ? "rejected" : "allowed";
  };
  /** 选项卡内容区：命中即高亮 + 禁放态（如拖来的是 tabs 容器） */
  const dropInTab = (c: FieldIdT, tabId: string): DropSlotState => {
    const hit =
      !!dropTarget &&
      isTabDrop(dropTarget) &&
      dropTarget.containerFieldId === c &&
      dropTarget.tabId === tabId;
    if (!hit) return "none";
    return dropReject ? "rejected" : "allowed";
  };
  const tabGapActive = (c: FieldIdT, tabId: string, ri: number) =>
    !!dropTarget && dropTarget.kind === "tabLine" && dropTarget.containerFieldId === c && dropTarget.tabId === tabId && dropTarget.rowIndex === ri;
  /** 选项卡内行间带的落点状态（禁放时渲染红叉而不是「放到此处新建一行」） */
  const tabGapState = (c: FieldIdT, tabId: string, ri: number): DropSlotState => {
    if (!tabGapActive(c, tabId, ri)) return "none";
    return dropReject ? "rejected" : "allowed";
  };

  // Esc 关闭（全屏容器自身管理，不依赖 Modal）
  useEffect(() => {
    if (!open || inline) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, inline, onClose]);

  const body = (
    <div className="flex h-full flex-col bg-gx-surface">
      <FormDesignerToolbar
        device={previewDevice}
        onDeviceChange={setPreviewDevice}
        onClose={onClose}
        onSave={handleSave}
        saving={saving}
        saveError={saveError}
        onOpenHistory={() => setHistoryOpen(true)}
        historyReason={historyReason}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* 移动端：字段库与设置面板收起为底部/抽屉，画布单列堆叠 */}
        {previewDevice === "desktop" && <FieldPalette onBeginDrag={beginDragFromPalette} onEndDrag={endDrag} />}

        {/* 中间：一整块表单画布（仅此区域与左右栏各自独立滚动，弹窗本身不滚动） */}
        <div className="flex-1 overflow-y-auto bg-gx-bg/50 p-4">
          <div className={clsx("mx-auto transition-all", previewDevice === "mobile" ? "max-w-[420px]" : "w-full max-w-3xl")}>
            <div
              ref={canvasRef}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={clsx(
                "relative rounded-gx-lg border bg-gx-surface shadow-sm transition-colors",
                dragActive && !dropReject && "border-gx-accent ring-1 ring-gx-accent/30",
                // 当前落点是禁放区：整块画布转红，用户松手前就知道放不进去
                dragActive && dropReject && "border-gx-danger ring-1 ring-gx-danger/30",
                !dragActive && "border-gx-border",
              )}
            >
              <div className="flex items-center justify-between gap-2 border-b border-gx-separator px-4 py-2.5">
                <span className="shrink-0 text-gx-13 font-semibold text-gx-text-primary">表单</span>
                <span className="truncate text-gx-11 text-gx-text-hint max-md:hidden">
                  {rows.reduce((s, r) => s + r.items.length, 0)} 个字段 · 拖入添加，▲ 并入上一行 / ▼ 向下新建一行，悬停字段可交换·复制·删除
                </span>
                <span className="truncate text-gx-11 text-gx-text-hint md:hidden">
                  {rows.reduce((s, r) => s + r.items.length, 0)} 个字段
                </span>
              </div>

              {rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
                  <Icon name="form" size={28} className="text-gx-text-hint" />
                  <div className="text-gx-13 text-gx-text-secondary">从左侧字段库拖拽字段类型到此处</div>
                  <div className="text-gx-11 text-gx-text-hint">字段会按宽度自动排列成行</div>
                </div>
              ) : (
                <div className="p-3">
                  {rows.map((row, ri) => (
                    <div key={ri}>
                      <RowGap rowIndex={ri} state={gapState(ri)} rejectReason={dropReject} onDragOver={handleGapDragOver(ri)} />
                      {/* 移动端：所有字段强制单列堆叠（忽略桌面行内多列宽度） */}
                      <div className={clsx("flex", previewDevice === "mobile" ? "flex-col" : "flex-wrap")}>
                        {row.items.map((item, ii) => {
                          const f = fieldById.get(item.fieldId);
                          if (!f) return null;
                          // 选项卡分组：全宽横向容器（所见即所得），独占一行
                          if (f.type === "tabs") {
                            const cfg = tabsCfg(f.id);
                            const activeId = activeTabMap[f.id] ?? cfg[0]?.id ?? "";
                            const activeTab = cfg.find((t) => t.id === activeId) ?? cfg[0];
                            const activeRows = activeTab?.rows ?? [];
                            return (
                              <div key={item.fieldId} className="w-full min-w-0 px-2 py-2">
                                <TabsDesignerCard
                                  field={f}
                                  tabs={cfg}
                                  activeTabId={activeTab?.id ?? ""}
                                  activeRows={activeRows}
                                  selectedFieldId={selectedFieldId}
                                  isSelected={selectedFieldId === f.id}
                                  device={previewDevice}
                                  bodyState={activeTab ? dropInTab(f.id, activeTab.id) : "none"}
                                  gapState={(gri) => (activeTab ? tabGapState(f.id, activeTab.id, gri) : "none")}
                                  dropRejectReason={dropReject}
                                  fieldById={fieldById}
                                  dragFieldId={dragFieldId}
                                  onSelectContainer={() => setSelectedFieldId(f.id)}
                                  onSelectField={(id) => setSelectedFieldId(id)}
                                  onActiveTab={(tid) => setActiveTab(f.id, tid)}
                                  onAddTab={() => addTab(f.id)}
                                  onRemoveTab={(tid) => removeTab(f.id, tid)}
                                  onRenameTab={(tid, name) => renameTab(f.id, tid, name)}
                                  onRemoveContainer={() => void deleteTabsContainer(f.id)}
                                  onRemoveField={(id) => removeField(id)}
                                  onDuplicateField={(id) => void duplicateField(id)}
                                  onJoinUp={joinUp}
                                  onSplitDown={splitDown}
                                  onSwapLeft={swapWithLeft}
                                  onBeginDrag={beginDragFromRow}
                                  onEndDrag={endDrag}
                                />
                              </div>
                            );
                          }
                          const canJoin = canJoinUp(rows, ri, item);
                          const canSplit = row.items.length > 1;
                          return (
                            <CanvasFieldCard
                              key={item.fieldId}
                              field={f}
                              item={item}
                              forceStack={previewDevice === "mobile"}
                              isSelected={selectedFieldId === item.fieldId}
                              isDragging={dragFieldId === item.fieldId}
                              canSwapLeft={ii > 0}
                              canJoinUp={canJoin}
                              canSplitDown={canSplit}
                              onSelect={() => setSelectedFieldId(item.fieldId)}
                              onRemove={() => removeField(item.fieldId)}
                              onDuplicate={() => void duplicateField(item.fieldId)}
                              onSwapLeft={() => swapWithLeft(item.fieldId)}
                              onJoinUp={() => joinUp(item.fieldId)}
                              onSplitDown={() => splitDown(item.fieldId)}
                              onBeginDrag={(e) => beginDragFromRow(item.fieldId, e)}
                              onEndDrag={endDrag}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <RowGap rowIndex={rows.length} state={gapState(rows.length)} rejectReason={dropReject} onDragOver={handleGapDragOver(rows.length)} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：字段设置（桌面三栏；移动端收到底部抽屉） */}
        {previewDevice === "desktop" && (
          <aside className="flex w-[300px] shrink-0 flex-col border-l border-gx-separator bg-gx-surface">
            <FieldSettingsPanel
              field={selectedField}
              allFields={fields}
              tables={tables}
              tableId={tableId}
              baseId={baseId}
              permissions={permissions}
              widthPct={selectedItem?.widthPct}
              onWidthChange={(w) => selectedFieldId && setSelectedWidth(selectedFieldId, w)}
            />
          </aside>
        )}
      </div>

      {/* 移动端：字段库 + 设置面板以底部抽屉方式呈现（画布占满，触控友好） */}
      {previewDevice === "mobile" && (
        <MobilePaletteSheet onBeginDrag={beginDragFromPalette} onEndDrag={endDrag}>
          <div className="border-t border-gx-separator bg-gx-surface px-3 py-2">
            <div className="mb-1 text-gx-12 font-semibold text-gx-text-primary">字段设置</div>
            <FieldSettingsPanel
              field={selectedField}
              allFields={fields}
              tables={tables}
              tableId={tableId}
              baseId={baseId}
              permissions={permissions}
              widthPct={selectedItem?.widthPct}
              onWidthChange={(w) => selectedFieldId && setSelectedWidth(selectedFieldId, w)}
            />
          </div>
        </MobilePaletteSheet>
      )}

      {creating && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-black/5">
          <div className="rounded-gx-lg bg-gx-surface px-4 py-2 text-gx-13 text-gx-text-primary shadow-lg">创建字段中…</div>
        </div>
      )}
    </div>
  );

  const historyDrawer = historyOpen ? (
    <VersionHistoryDrawer
      viewId={viewId ?? null}
      tableId={tableId}
      fields={fields}
      permissions={permissions}
      currentTabs={syncTabs(tabsRef.current)}
      // 建版本（POST）与落库 tabs（PATCH /api/fields）都要求 canManageSchema，
      // 故写入口按它开，而不是按 canEditData —— 否则点了才 403。浏览 / 预览不受此限。
      readOnly={!permissions.canManageSchema}
      busy={rollingBack || createLayoutVersion.isPending}
      onCreateVersion={handleCreateVersion}
      onRollback={handleRollback}
      onClose={() => setHistoryOpen(false)}
    />
  ) : null;

  if (inline) return (
    <div className="relative h-full">
      {body}
      {historyDrawer}
    </div>
  );
  // 全屏抽屉式设计器（⑤）：近全屏、弹窗本身不滚动，三栏各自独立滚动。
  // Portal 到 body：抽屉（RecordDrawer）带 transform 会破坏内部 fixed 定位与层叠上下文。
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative flex w-full max-w-[1500px] flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-2xl">
        {body}
      </div>
      {historyDrawer}
    </div>,
    document.body,
  );
}

/**
 * 移动端底部抽屉（⑥）：小屏下字段库与字段设置不再挤占画布，
 * 收为底部可展开面板；画布以单列手机宽度预览，触控友好。
 */
function MobilePaletteSheet({
  onBeginDrag,
  onEndDrag,
  children,
}: {
  onBeginDrag: (type: FieldType, e: React.DragEvent) => void;
  onEndDrag: () => void;
  children: React.ReactNode;
}) {
  const [openSheet, setOpenSheet] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpenSheet((v) => !v)}
        className="flex items-center justify-center gap-2 border-t border-gx-separator bg-gx-surface py-2.5 text-gx-13 font-medium text-gx-accent"
      >
        <Icon name="plus" size={14} />
        {openSheet ? "收起字段库 / 设置" : "打开字段库 / 字段设置"}
      </button>
      {openSheet && (
        <div className="flex max-h-[45vh] flex-col overflow-hidden border-t border-gx-separator bg-gx-surface">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-gx-separator">
              <FieldPalette onBeginDrag={onBeginDrag} onEndDrag={onEndDrag} mobile />
            </div>
            <div className="max-h-56 overflow-y-auto">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- 小组件 ----------

/**
 * 行间拖放带：拖到这里新建独立一行。
 * 命中区固定高度（激活不改变盒尺寸 → 不推挤内容、不引起落点抖动）；
 * 激活时用绝对定位的插入线高亮，drop 统一冒泡到画布根处理。
 */
export function RowGap({
  rowIndex,
  state = "none",
  rejectReason = null,
  onDragOver,
  tabDrop,
}: {
  rowIndex: number;
  /** 落点状态：none=未命中；allowed=可放（高亮插入线）；rejected=禁放（红色禁止条） */
  state?: DropSlotState;
  /** 禁放原因文案（rejected 时展示，让用户知道为什么放不进去） */
  rejectReason?: string | null;
  /** 顶层行间带用它强制 line 落点；选项卡内带不传（dragover 冒泡到根，按 data-tab-gap 算 tabLine） */
  onDragOver?: (e: React.DragEvent) => void;
  /** 落在选项卡内时提供：挂 data-tab-gap 等属性 */
  tabDrop?: { containerFieldId: string; tabId: string };
}) {
  const dropData = tabDrop
    ? {
        "data-tab-gap": rowIndex,
        "data-tab-container": tabDrop.containerFieldId,
        "data-tab-id": tabDrop.tabId,
      }
    : { "data-row-gap": rowIndex };
  return (
    <div
      {...dropData}
      onDragOver={onDragOver}
      data-gap-hit=""
      data-drop-state={state}
      className="relative flex h-4 items-center justify-center"
    >
      {state === "allowed" && (
        <div className="pointer-events-none absolute inset-x-1 top-1/2 z-10 flex h-9 -translate-y-1/2 items-center justify-center rounded-gx-sm border-2 border-dashed border-gx-accent bg-gx-accent-bg/40">
          <span className="flex items-center gap-1 text-gx-11 font-medium text-gx-accent">
            <Icon name="plus" size={12} /> 放到此处新建一行
          </span>
        </div>
      )}
      {state === "rejected" && (
        <div
          data-drop-rejected=""
          className="pointer-events-none absolute inset-x-1 top-1/2 z-10 flex h-9 -translate-y-1/2 items-center justify-center gap-1 rounded-gx-sm border-2 border-dashed border-gx-danger bg-gx-danger-bg text-gx-11 font-medium text-gx-danger"
        >
          <Icon name="alertCircle" size={12} />
          {rejectReason ?? "此处不可放置"}
        </div>
      )}
    </div>
  );
}

// ============ 顶部工具栏 ============

interface FormDesignerToolbarProps {
  device: PreviewDevice;
  onDeviceChange: (d: PreviewDevice) => void;
  onClose: () => void;
  onSave: () => void;
  /** 保存中：按钮转 loading 且禁用，避免连点重复提交 */
  saving?: boolean;
  /** 打开布局版本历史抽屉 */
  onOpenHistory?: () => void;
  /** 历史入口的禁用原因（null = 可用），渲染为 title */
  historyReason?: string | null;
  /**
   * 上一次保存的真实失败原因（后端 message 优先，兜底「保存失败，请重试」）。
   * 非空时常驻在工具栏下方：面板此时**没有关闭**，用户改完可直接重试。
   */
  saveError?: string | null;
}

export function FormDesignerToolbar({
  device,
  onDeviceChange,
  onClose,
  onSave,
  saving = false,
  saveError = null,
  onOpenHistory,
  historyReason = null,
}: FormDesignerToolbarProps) {
  return (
    <div className="shrink-0 border-b border-gx-separator bg-gx-surface">
      <div className="flex items-center gap-4 px-4 py-2">
        <div className="ml-auto flex items-center gap-2">
          {/* 布局版本历史：ghost 小按钮，禁用时 title 带原因（R-D-09） */}
          <Button size="sm" variant="ghost" icon="history" disabled={!!historyReason} disabledReason={historyReason ?? undefined} onClick={onOpenHistory}>
            历史
          </Button>
          <div className="flex items-center rounded-gx-lg border border-gx-border p-0.5">
            <button
              type="button"
              onClick={() => onDeviceChange("desktop")}
              className={clsx("flex items-center gap-1 rounded-gx-sm px-2 py-1 text-gx-12 transition-colors", device === "desktop" ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-secondary hover:bg-gx-bg")}
            >
              <Icon name="table" size={13} />
              <span>桌面端</span>
            </button>
            <button
              type="button"
              onClick={() => onDeviceChange("mobile")}
              className={clsx("flex items-center gap-1 rounded-gx-sm px-2 py-1 text-gx-12 transition-colors", device === "mobile" ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-secondary hover:bg-gx-bg")}
            >
              <Icon name="form" size={13} />
              <span>移动端</span>
            </button>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" onClick={onSave} loading={saving} disabled={saving}>
            {saving ? "保存中" : "保存布局"}
          </Button>
        </div>
      </div>
      {/* 保存失败：面板保持打开，这里常驻真实原因（role=alert 让读屏立即播报） */}
      {saveError && (
        <div
          data-save-error=""
          role="alert"
          className="flex items-start gap-2 border-t border-gx-danger-bg bg-gx-danger-bg px-4 py-2 text-gx-12 text-gx-danger"
        >
          <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{saveError}</span>
          <span className="shrink-0 text-gx-text-hint">布局未保存，可修改后重试</span>
        </div>
      )}
    </div>
  );
}

// ============ 左侧字段库 ============

interface FieldPaletteProps {
  onBeginDrag: (type: FieldType, e: React.DragEvent) => void;
  onEndDrag: () => void;
  /** 移动端底部抽屉内：全宽、横向网格更紧凑 */
  mobile?: boolean;
}

function FieldPalette({ onBeginDrag, onEndDrag, mobile }: FieldPaletteProps) {
  const [filter, setFilter] = useState("");
  const lower = filter.trim().toLowerCase();
  const groups = lower
    ? TYPE_GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => it.label.toLowerCase().includes(lower)) })).filter((g) => g.items.length > 0)
    : TYPE_GROUPS;

  return (
    <aside className={clsx("flex shrink-0 flex-col border-r border-gx-separator bg-gx-surface", mobile ? "w-full border-r-0" : "w-[220px]")}>
      <div className="border-b border-gx-separator px-3 py-2.5 text-gx-14 font-semibold text-gx-text-primary">字段库</div>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 rounded-gx-lg border border-gx-border bg-gx-bg px-2 py-1.5">
          <Icon name="search" size={13} className="text-gx-text-hint" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索字段类型"
            className="flex-1 appearance-none bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
        </div>
      </div>
      <div className={clsx("flex-1 overflow-y-auto px-2 pb-4", mobile && "max-h-56")}>
        {groups.map((g) => (
          <div key={g.group} className="mb-3">
            <div className="px-1 py-1 text-gx-11 font-medium text-gx-text-tertiary">{g.group}字段</div>
            <div className={clsx("grid gap-1", mobile ? "grid-cols-4" : "grid-cols-2")}>
              {g.items.map((it) => (
                <div
                  key={it.type}
                  draggable
                  onDragStart={(e) => onBeginDrag(it.type, e)}
                  onDragEnd={onEndDrag}
                  className="flex cursor-grab items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 text-gx-text-secondary hover:border-gx-accent/50 hover:bg-gx-accent-bg/40 active:cursor-grabbing"
                  title={`拖到表单中创建 ${it.label} 字段`}
                >
                  <FieldIcon type={it.type} size={13} />
                  <span className="truncate">{it.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ============ 画布字段卡片（顶层与选项卡内共用） ============

interface CanvasFieldCardProps {
  field: FieldDTO;
  item: LayoutItem;
  isSelected: boolean;
  isDragging: boolean;
  canSwapLeft: boolean;
  canJoinUp: boolean;
  canSplitDown: boolean;
  /** 移动端预览：强制单列堆叠，隐藏行内多列操作按钮 */
  forceStack?: boolean;
  /** 落在选项卡内时提供：用于挂 data-tab-* 落点属性；顶层为 null */
  tabDrop?: { containerFieldId: string; tabId: string; rowIndex: number } | null;
  onSelect: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onSwapLeft: () => void;
  onJoinUp: () => void;
  onSplitDown: () => void;
  onBeginDrag: (e: React.DragEvent) => void;
  onEndDrag: () => void;
}

/** 骑在字段边框上的圆形白底浮动小按钮 */
function EdgeButton({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onDragStart={(e) => e.preventDefault()}
      onMouseDown={(e) => e.stopPropagation()}
      className={clsx(
        "absolute z-20 flex h-6 w-6 items-center justify-center rounded-full border border-gx-border bg-gx-surface text-gx-text-secondary opacity-0 shadow-sm transition-all",
        "hover:border-gx-accent hover:text-gx-accent group-hover:opacity-100",
        className,
      )}
    >
      {children}
    </button>
  );
}

function CanvasFieldCard({
  field,
  item,
  isSelected,
  isDragging,
  canSwapLeft,
  canJoinUp,
  canSplitDown,
  forceStack,
  tabDrop,
  onSelect,
  onRemove,
  onDuplicate,
  onSwapLeft,
  onJoinUp,
  onSplitDown,
  onBeginDrag,
  onEndDrag,
}: CanvasFieldCardProps) {
  const dropData = tabDrop
    ? {
        "data-tab-field": field.id,
        "data-tab-container": tabDrop.containerFieldId,
        "data-tab-id": tabDrop.tabId,
        "data-tab-row": String(tabDrop.rowIndex),
      }
    : { "data-field-card": field.id };
  // 移动端单列：宽度强制 100%，并隐藏行内多列操作（▲▼⇄ 无意义）
  const stack = !!forceStack;
  return (
    <div
      style={stack ? { flex: "0 0 100%", maxWidth: "100%" } : { flex: `0 0 ${item.widthPct}%`, maxWidth: `${item.widthPct}%` }}
      className="group relative min-w-0 px-2 py-2"
      {...dropData}
    >
      <div
        draggable
        onDragStart={onBeginDrag}
        onDragEnd={onEndDrag}
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        className={clsx(
          "relative flex cursor-grab flex-col gap-1.5 rounded-gx-lg border p-3 transition-colors active:cursor-grabbing",
          isSelected
            ? "border-gx-accent/50 bg-gx-accent-bg/60"
            : "border-gx-border bg-gx-surface hover:border-gx-accent/40 hover:bg-gx-accent-bg/20",
          isDragging && "opacity-40",
        )}
      >
        {/* ▲ 并入上一行：骑在顶边中点。仅当上一行没满（<4 字段且宽度放得下）时显示 */}
        {!stack && canJoinUp && (
          <EdgeButton title="并入上一行" onClick={onJoinUp} className="-top-3 left-1/2 -translate-x-1/2">
            <Icon name="arrowUp" size={13} />
          </EdgeButton>
        )}

        {/* ▼ 向下新建一行：骑在底边中点。本行还有其它字段时才可拆出 */}
        {!stack && canSplitDown && (
          <EdgeButton title="向下新建一行" onClick={onSplitDown} className="-bottom-3 left-1/2 -translate-x-1/2">
            <Icon name="arrowDown" size={13} />
          </EdgeButton>
        )}

        {/* ⇄ 与左邻交换：骑在左边中点 */}
        {!stack && canSwapLeft && (
          <EdgeButton title="与左侧字段交换位置" onClick={onSwapLeft} className="-left-3 top-1/2 -translate-y-1/2">
            <Icon name="swap" size={12} />
          </EdgeButton>
        )}

        {/* 右上角：复制 / 删除（悬停或选中显现） */}
        <div
          className={clsx(
            "absolute -top-2.5 right-2 flex items-center gap-1 rounded-full border border-gx-border bg-gx-surface px-1 py-0.5 shadow-sm transition-opacity",
            isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            title="复制字段"
            onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
            onDragStart={(e) => e.preventDefault()}
            className="flex h-5 w-5 items-center justify-center rounded-full text-gx-text-secondary hover:bg-gx-accent-bg hover:text-gx-accent"
          >
            <Icon name="copy" size={12} />
          </button>
          <button
            type="button"
            title="从表单移除"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            onDragStart={(e) => e.preventDefault()}
            className="flex h-5 w-5 items-center justify-center rounded-full text-gx-text-secondary hover:bg-gx-danger-bg hover:text-gx-danger"
          >
            <Icon name="trash" size={12} />
          </button>
        </div>

        {/* 字段名 */}
        <div className="flex items-center gap-1.5 pr-1 text-gx-13 font-semibold text-gx-text-primary">
          <FieldIcon type={field.type} size={13} />
          <span className="truncate">{field.name}</span>
        </div>

        {/* 子表格：设计器所见即所得（③）——渲染迷你表格（表头 + 空态），与详情页一致 */}
        {field.type === "subtable" ? (
          <SubtableMiniPreview field={field} />
        ) : (
          <FieldInput field={field} value={null} onChange={() => {}} disabled />
        )}
      </div>
    </div>
  );
}

/**
 * 子表格在设计器画布里的所见即所得预览（③）：
 * 按该字段配置的 displayedFieldIds（未配置取对面表前若干字段）渲染目标表表头，
 * 数据区给空态提示，保证设计师在画布上看到的就是详情页里的子表格形态。
 */
function SubtableMiniPreview({ field }: { field: FieldDTO }) {
  const peerTableId = field.relatedTableId ?? null;
  const { data: peerFieldsData } = useFields(peerTableId);
  const columns = useMemo(() => {
    const all = peerFieldsData ?? [];
    if (field.displayedFieldIds && field.displayedFieldIds.length > 0) {
      const order = new Map(field.displayedFieldIds.map((id, i) => [id as string, i]));
      return all
        .filter((f) => (field.displayedFieldIds as string[]).includes(f.id))
        .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
    }
    return all.slice(0, 4);
  }, [peerFieldsData, field.displayedFieldIds]);

  return (
    <div className="overflow-hidden rounded-gx-sm border border-gx-border">
      <table className="w-full text-gx-11">
        <thead>
          <tr className="border-b border-gx-separator bg-gx-bg/60">
            {columns.length === 0 && <th className="px-2 py-1 text-left font-medium text-gx-text-hint">关联表字段</th>}
            {columns.map((c) => (
              <th key={c.id} className="px-2 py-1 text-left font-medium text-gx-text-secondary">
                <span className="inline-flex items-center gap-1">
                  <FieldIcon type={c.type} size={10} />
                  <span className="truncate">{c.name}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={Math.max(1, columns.length)} className="px-2 py-3 text-center text-gx-11 text-gx-text-hint">
              子表格 · 详情页中可添加 / 选择关联记录
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ============ 选项卡分组容器（所见即所得横向选项卡 + 内部行模型） ============

interface TabsDesignerCardProps {
  field: FieldDTO;
  tabs: { id: string; name: string; rows: LayoutRow[] }[];
  activeTabId: string;
  activeRows: LayoutRow[];
  selectedFieldId: FieldIdT | null;
  isSelected: boolean;
  device?: PreviewDevice;
  /** 选项卡内容区整体的落点状态：可放高亮 / 禁放红色禁止 */
  bodyState: DropSlotState;
  /** 禁放原因文案（同步展示在内容区与行间带上） */
  dropRejectReason?: string | null;
  gapState: (rowIndex: number) => DropSlotState;
  fieldById: Map<FieldIdT, FieldDTO>;
  dragFieldId: FieldIdT | null;
  onSelectContainer: () => void;
  onSelectField: (id: FieldIdT) => void;
  onActiveTab: (tabId: string) => void;
  onAddTab: () => void;
  onRemoveTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  /** 删除整个选项卡容器字段（①） */
  onRemoveContainer: () => void;
  onRemoveField: (id: FieldIdT) => void;
  onDuplicateField: (id: FieldIdT) => void;
  onJoinUp: (id: FieldIdT) => void;
  onSplitDown: (id: FieldIdT) => void;
  onSwapLeft: (id: FieldIdT) => void;
  onBeginDrag: (id: FieldIdT, e: React.DragEvent) => void;
  onEndDrag: () => void;
}

function TabsDesignerCard({
  field,
  tabs,
  activeTabId,
  activeRows,
  selectedFieldId,
  isSelected,
  device,
  bodyState,
  dropRejectReason = null,
  gapState,
  fieldById,
  dragFieldId,
  onSelectContainer,
  onSelectField,
  onActiveTab,
  onAddTab,
  onRemoveTab,
  onRenameTab,
  onRemoveContainer,
  onRemoveField,
  onDuplicateField,
  onJoinUp,
  onSplitDown,
  onSwapLeft,
  onBeginDrag,
  onEndDrag,
}: TabsDesignerCardProps) {
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const mobile = device === "mobile";

  return (
    <div
      data-tab-root={field.id}
      onClick={(e) => { e.stopPropagation(); onSelectContainer(); }}
      className={clsx(
        "relative rounded-gx-lg border bg-gx-surface transition-colors",
        isSelected ? "border-gx-accent/50 ring-1 ring-gx-accent/30" : "border-gx-border hover:border-gx-accent/40",
      )}
    >
      {/* 横向选项卡栏 */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-gx-separator px-2 pt-1.5">
        <span className="mr-1 flex shrink-0 items-center text-gx-text-hint">
          <FieldIcon type={field.type} size={13} />
        </span>
        {tabs.map((tab) => {
          const isActive = active?.id === tab.id;
          return (
            <div
              key={tab.id}
              data-tab-header=""
              data-tab-container={field.id}
              data-tab-id={tab.id}
              className={clsx(
                "group/tab flex shrink-0 items-center gap-1 rounded-t-gx-md border-b-2 px-3 pb-1.5 pt-1 transition-colors",
                isActive ? "border-gx-accent" : "border-transparent hover:bg-gx-bg",
              )}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onActiveTab(tab.id); }}
                className={clsx("text-gx-13 transition-colors", isActive ? "font-medium text-gx-accent" : "text-gx-text-secondary")}
              >
                <input
                  value={tab.name}
                  onClick={(e) => { e.stopPropagation(); onActiveTab(tab.id); }}
                  onChange={(e) => onRenameTab(tab.id, e.target.value)}
                  className="w-20 bg-transparent text-center outline-none placeholder:text-gx-text-hint"
                  placeholder="选项卡名"
                />
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  title="删除该选项卡（卡内字段退回表单）"
                  onClick={(e) => { e.stopPropagation(); onRemoveTab(tab.id); }}
                  onDragStart={(e) => e.preventDefault()}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-gx-text-hint opacity-0 transition-opacity hover:bg-gx-danger-bg hover:text-gx-danger group-hover/tab:opacity-100"
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAddTab(); }}
          onDragStart={(e) => e.preventDefault()}
          title="添加选项卡"
          className="mb-0.5 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gx-text-hint hover:bg-gx-accent-bg hover:text-gx-accent"
        >
          <Icon name="plus" size={14} />
        </button>
        {/* ① 删除整个选项卡容器字段 */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemoveContainer(); }}
          onDragStart={(e) => e.preventDefault()}
          title="删除整个选项卡分组（容器内字段退回表单）"
          className="mb-0.5 ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gx-text-hint hover:bg-gx-danger-bg hover:text-gx-danger"
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

      {/* 当前选项卡内容：与顶层一致的显式行模型（横向多列 + ▲/▼/⇄） */}
      <div
        data-tab-body=""
        data-tab-container={field.id}
        data-tab-id={active?.id ?? ""}
        data-drop-state={bodyState}
        className={clsx(
          "min-h-[96px] rounded-b-gx-lg p-2 transition-colors",
          bodyState === "allowed" && "bg-gx-accent-bg/40 ring-1 ring-inset ring-gx-accent/40",
          // 禁放：置红 + 禁止光标，让用户在松手前就知道放不进去
          bodyState === "rejected" && "cursor-not-allowed bg-gx-danger-bg ring-1 ring-inset ring-gx-danger",
        )}
      >
        {bodyState === "rejected" && (
          <div className="mb-1 flex items-center gap-1 text-gx-11 font-medium text-gx-danger">
            <Icon name="alertCircle" size={12} />
            {dropRejectReason ?? "此处不可放置"}
          </div>
        )}
        {!active || activeRows.length === 0 ? (
          <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-gx-lg border border-dashed border-gx-border text-center">
            <Icon name="form" size={18} className="text-gx-text-hint" />
            <div className="text-gx-12 text-gx-text-secondary">该选项卡下还没有字段</div>
            <div className="text-gx-11 text-gx-text-hint">从左侧字段库拖入，或把其它字段拖到此处</div>
          </div>
        ) : (
          <div>
            {activeRows.map((row, ri) => (
              <div key={ri}>
                <RowGap rowIndex={ri} state={gapState(ri)} rejectReason={dropRejectReason} tabDrop={{ containerFieldId: field.id, tabId: active.id }} />
                <div className={clsx("flex", mobile ? "flex-col" : "flex-wrap")}>
                  {row.items.map((item, ii) => {
                    const cf = fieldById.get(item.fieldId);
                    if (!cf) return null;
                    return (
                      <CanvasFieldCard
                        key={item.fieldId}
                        field={cf}
                        item={item}
                        forceStack={mobile}
                        isSelected={selectedFieldId === item.fieldId}
                        isDragging={dragFieldId === item.fieldId}
                        canSwapLeft={ii > 0}
                        canJoinUp={canJoinUp(activeRows, ri, item)}
                        canSplitDown={row.items.length > 1}
                        tabDrop={{ containerFieldId: field.id, tabId: active.id, rowIndex: ri }}
                        onSelect={() => onSelectField(item.fieldId)}
                        onRemove={() => onRemoveField(item.fieldId)}
                        onDuplicate={() => onDuplicateField(item.fieldId)}
                        onSwapLeft={() => onSwapLeft(item.fieldId)}
                        onJoinUp={() => onJoinUp(item.fieldId)}
                        onSplitDown={() => onSplitDown(item.fieldId)}
                        onBeginDrag={(e) => onBeginDrag(item.fieldId, e)}
                        onEndDrag={onEndDrag}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            <RowGap rowIndex={activeRows.length} state={gapState(activeRows.length)} rejectReason={dropRejectReason} tabDrop={{ containerFieldId: field.id, tabId: active.id }} />
          </div>
        )}
      </div>
    </div>
  );
}
