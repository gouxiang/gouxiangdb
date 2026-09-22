// apps/web/src/features/detail/form-versioning/versioning.ts
// 表单布局版本快照的纯函数层。
//
// 与 React / 网络 / DOM 完全无关，可被 vitest 直接 import（不依赖 renderHook、不依赖 MSW）。
// 职责边界：
//   - 解析并校验后端返回的 snapshot 信封（后端存的是 JSON 字符串，也可能直接给对象）
//   - 版本号排序、下一个版本号推导
//   - 时间格式化（绝对 / 相对，相对时间注入 now 保证可测）
//   - 判断「回退」在当前状态下该不该禁用，以及禁用原因
//
// tabs 段的归一与还原（形状最多、规则最重）单独在 ./tabs-snapshot.ts。

import type { DetailLayout, DetailLayoutRow, FieldWidthPct, FormLayoutVersionMetaDTO } from "@gx/shared-types";
import { normalizeTabsEntry, tabFieldIdsOf, type TabsSnapshot } from "./tabs-snapshot";

/** tabs 段的类型与两个入口从这里转出，调用方不必知道它拆到了哪个文件。 */
export type { TabsSnapshot, TabsSnapshotWire } from "./tabs-snapshot";

/** 回退前自动备份的版本备注（产品语义：让用户能在历史里找回这次被覆盖的草稿）。 */
export const AUTO_BACKUP_LABEL = "回退前自动备份";

// ============ 契约类型 ============

/**
 * 列表元数据：直接复用 shared-types 的 `FormLayoutVersionMetaDTO`
 * （packages/shared-types/src/layoutVersion.ts，前后端唯一真源）。
 * web 侧另描一份的话，后端加字段或改语义时两份必漂。
 */
export type LayoutVersionSummary = FormLayoutVersionMetaDTO;

export interface LayoutVersionDetail extends LayoutVersionSummary {
  /** 后端约定是 JSON 字符串；历史上也可能直接给对象，故这里放宽，由 parseSnapshot 归一 */
  snapshot: string;
}

export interface LayoutSnapshot {
  version: number;
  layout: DetailLayout | null;
  /** tabsFieldId -> 该容器的快照内容；整体缺失时为 null */
  tabs: Record<string, TabsSnapshot> | null;
}

// ============ 小工具 ============

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isDetailLayoutLike(v: unknown): v is DetailLayout {
  if (!isPlainObject(v)) return false;
  return Array.isArray(v.rows);
}

// ============ 快照解析 ============

/**
 * 解析后端快照信封。任何畸形输入都返回 null —— 解析失败必须显式暴露给 UI，
 * 不允许「拿到半个快照还继续回退」。
 */
export function parseSnapshot(raw: unknown): LayoutSnapshot | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!isPlainObject(o)) return null;
  const version = typeof o.version === "number" && Number.isFinite(o.version) ? o.version : 0;

  let tabs: Record<string, TabsSnapshot> | null = null;
  if (isPlainObject(o.tabs)) {
    const next: Record<string, TabsSnapshot> = {};
    for (const [fieldId, v] of Object.entries(o.tabs)) {
      const n = normalizeTabsEntry(v);
      // 某个容器形状认不出来就跳过它，不让整个快照报废（该容器别的字段仍可回退）
      if (n) next[fieldId] = n;
    }
    tabs = next;
  }
  return { version, layout: isDetailLayoutLike(o.layout) ? o.layout : null, tabs };
}

/** 去掉布局里已经不存在的字段 id（表上被删掉的字段不能凭快照复活）。 */
export function dropUnknownFieldIds(layout: DetailLayout | null, knownFieldIds: Iterable<string>): DetailLayout | null {
  if (!layout) return null;
  const known = knownFieldIds instanceof Set ? knownFieldIds : new Set(knownFieldIds);
  const rows: DetailLayoutRow[] = (layout.rows ?? [])
    .map((r): DetailLayoutRow => {
      const fieldIds = (r.fieldIds ?? []).filter((id) => known.has(id));
      const widths: Record<string, FieldWidthPct> = {};
      for (const id of fieldIds) if (r.widths && id in r.widths) widths[id] = r.widths[id]!;
      return { ...r, fieldIds, widths };
    })
    .filter((r) => r.fieldIds.length > 0);
  return { ...layout, rows };
}

// ============ 列表排序 / 版本号 ============

/** 按 version 倒序（同号时按 createdAt 倒序）；不改原数组。 */
export function sortVersionsDesc(items: readonly LayoutVersionSummary[]): LayoutVersionSummary[] {
  return [...items].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** 下一个版本号 = 现有最大号 + 1；无版本时为 1。非法 version 视为 0。 */
export function nextVersion(items: readonly LayoutVersionSummary[]): number {
  let max = 0;
  for (const it of items) {
    const v = typeof it.version === "number" && Number.isFinite(it.version) ? it.version : 0;
    if (v > max) max = v;
  }
  return max + 1;
}

// ============ 时间格式化 ============

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 绝对时间 `YYYY-MM-DD HH:mm`（本地时区）；非法输入返回 ""。 */
export function formatVersionTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 相对时间。@param nowMs 必须显式传入（而不是内部读 Date.now），否则单测无法确定性断言。
 * 超过 7 天回落到绝对时间。
 */
export function formatVersionTimeAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = nowMs - t;
  if (diff < 0) return formatVersionTime(iso); // 时钟回拨 / 未来时间：直接给绝对时间，不编造
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day <= 7) return `${day} 天前`;
  return formatVersionTime(iso);
}

/** 列表项标题：`v3` 或 `v3 · 备注` */
export function versionTitle(item: Pick<LayoutVersionSummary, "version" | "label">): string {
  const label = item.label?.trim();
  return label ? `v${item.version} · ${label}` : `v${item.version}`;
}

// ============ 统计 / 禁用判定 ============

export interface SnapshotStats {
  rowCount: number;
  fieldCount: number;
  tabContainerCount: number;
  tabFieldCount: number;
}

export function snapshotStats(snapshot: LayoutSnapshot | null): SnapshotStats {
  if (!snapshot) return { rowCount: 0, fieldCount: 0, tabContainerCount: 0, tabFieldCount: 0 };
  const rows = snapshot.layout?.rows ?? [];
  const ids = new Set<string>();
  for (const r of rows) for (const id of r.fieldIds ?? []) ids.add(id);
  let tabFieldCount = 0;
  for (const entry of Object.values(snapshot.tabs ?? {})) tabFieldCount += tabFieldIdsOf(entry).length;
  return { rowCount: rows.length, fieldCount: ids.size, tabContainerCount: Object.keys(snapshot.tabs ?? {}).length, tabFieldCount };
}

/** 快照是否「空的」——既不排字段也没选项卡内容；用于提示用户这个版本没什么可回退的。 */
export function snapshotIsEmpty(snapshot: LayoutSnapshot | null): boolean {
  const s = snapshotStats(snapshot);
  return s.fieldCount === 0 && s.tabFieldCount === 0;
}

export interface RollbackGate {
  viewId: string | null | undefined;
  selectedId: string | null | undefined;
  snapshot: LayoutSnapshot | null | undefined;
  /** 正在备份 / 正在写入等忙碌态 */
  busy: boolean;
  /** 只读（无编辑权限） */
  readOnly: boolean;
}

/** 回退该不该禁用；返回 null = 可用，返回字符串 = 禁用且这就是原因（直接给 tooltip / disabled 文案）。 */
export function rollbackBlockReason(gate: RollbackGate): string | null {
  if (!gate.viewId) return "当前视图缺少 id，无法读写版本历史";
  if (gate.readOnly) return "当前权限不能修改布局";
  if (!gate.selectedId) return "请先在左侧选择一个历史版本";
  if (!gate.snapshot) return "该版本的快照无法解析，不能回退";
  if (gate.busy) return "正在处理中，请稍候";
  return null;
}

/** 工具栏「历史」按钮的禁用原因；null = 可用。 */
export function historyBlockReason(viewId: string | null | undefined): string | null {
  return viewId ? null : "当前视图缺少 id，无法打开版本历史";
}
