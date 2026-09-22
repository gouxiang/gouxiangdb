// apps/web/src/features/detail/form-versioning/tabs-snapshot.ts
// 快照里 tabs 段的归一与还原（纯函数，无 React / 无 IO）。
//
// 从 versioning.ts 拆出来的原因：tabs 这一段形状最多（三种历史形态 + 重建规则），
// 单独成文件才能各自守住 300 行上限。
//
// 线上形态（与后端 FormLayoutTabSnapshot 一一对齐）：
//   tabs: { "<tabs 容器字段 id>": { cards: string[], lazyTouched: string[], tabs?: TabConfig[] } }
//
// 注意 `tabs` 是**嵌在容器对象里的可选数组**，不是把容器值直接写成数组 ——
// 后端 normalizeTabs 走 `isPlainObject(input[key])` 取值，裸数组会被判成 `{}` 整体丢掉。
// `tabs` 存在时回退以它为准（页名 / 宽度 / 行边界精确还原）；缺失才退化成按 cards 重建。

import type { FieldWidthPct, FormLayoutTabSnapshot, TabConfig } from "@gx/shared-types";

/**
 * 线上形态直接用 shared-types 的 `FormLayoutTabSnapshot`（前后端唯一真源，见
 * packages/shared-types/src/layoutVersion.ts），**不在 web 侧再描一遍** ——
 * 否则后端 bump SNAPSHOT_ENVELOPE_VERSION 或改结构时两份真源必漂。
 */
export type TabsSnapshotWire = FormLayoutTabSnapshot;

/**
 * 快照里一个 tabs 容器可能出现的三种形态。
 *
 * - config：**产出与读取都走这个形态**，保真度最高（页名 / 宽度 / 行边界都在）。
 *   注意它就体现在两个位置：`TabsSnapshotWire.tabs` 字段的值是 `TabConfig[]`
 *   （一个元素 = 一个选项卡页），以及本地归一后的 `{ kind: "config", tabs }`。
 *   **容器值本身永远是对象**（`{ cards, lazyTouched, tabs? }`），不是裸数组。
 * - bucket / byTab：老的扁平形态，只**读**不写 —— 存量快照里已经是这个形状，
 *   且它天生丢失了宽度与行边界，回退时只能按当前骨架重建。
 *
 * 归一成带 kind 的联合类型，是为了让调用方按 kind 决定还原策略，避免「猜错形状还静默走通」。
 */
export type TabsSnapshot =
  | { kind: "config"; tabs: TabConfig[] }
  | { kind: "bucket"; cards: string[]; lazyTouched: string[] }
  | { kind: "byTab"; tabs: Record<string, { cards: string[]; lazyTouched: string[] }> };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 只留非空字符串，去重保序（快照里的顺序有语义） */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string" || x === "" || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** 单个 TabConfig 内的字段顺序：rows 优先（新数据），缺失时回退 fieldIds（与后端 tabFieldIds 同口径）。 */
function tabIdsOfOne(t: TabConfig): string[] {
  if (t.rows && t.rows.length > 0) {
    const out: string[] = [];
    for (const r of t.rows) for (const it of r.items ?? []) if (!out.includes(it.fieldId)) out.push(it.fieldId);
    return out;
  }
  return (t.fieldIds ?? []).filter((x): x is string => typeof x === "string");
}

/** TabConfig 是否够格进信封：至少要有页 id（没有 id 的页回退时无法归位）。 */
function isTabConfig(v: unknown): v is TabConfig {
  return isPlainObject(v) && typeof v.id === "string" && v.id.length > 0;
}

/** 去掉空壳字段：`widths: {}` / `rows: []` 一律省略，不塞空对象占位（信封契约要求）。 */
function compactTab(t: TabConfig): TabConfig {
  const out: TabConfig = { id: t.id, name: t.name, fieldIds: [...(t.fieldIds ?? [])] };
  const widths = t.widths && Object.keys(t.widths).length > 0 ? t.widths : null;
  if (widths) out.widths = widths;
  const rows = t.rows && t.rows.length > 0 ? t.rows : null;
  if (rows) out.rows = rows;
  return out;
}

/** 把一个 tabs 容器的原始值归一成 TabsSnapshot；无法识别时返回 null。 */
export function normalizeTabsEntry(raw: unknown): TabsSnapshot | null {
  if (Array.isArray(raw)) {
    // 裸数组（容忍形态）：后端不会产出，但万一有也按结构化读，不丢弃
    return { kind: "config", tabs: raw.filter(isTabConfig).map((t) => ({ ...t })) };
  }
  if (!isPlainObject(raw)) return null;

  // ① 结构化优先：`{ cards, lazyTouched, tabs: TabConfig[] }`，tabs 非空就以它为准（精确还原）
  if (Array.isArray(raw.tabs)) {
    const structured = raw.tabs.filter(isTabConfig).map((t) => ({ ...t }));
    if (structured.length > 0) return { kind: "config", tabs: structured };
  }
  // ② 老扁平形态：只有 `{ cards, lazyTouched }`，没有结构信息
  if ("cards" in raw) {
    return { kind: "bucket", cards: toStringArray(raw.cards), lazyTouched: toStringArray(raw.lazyTouched) };
  }
  // byTab：{ [tabId]: { cards, lazyTouched } } —— 所有值都带 cards 才认，否则当成别的形状
  const entries = Object.entries(raw).filter(([, v]) => isPlainObject(v) && "cards" in (v as Record<string, unknown>));
  if (entries.length === 0 || entries.length !== Object.keys(raw).length) return null;
  const tabs: Record<string, { cards: string[]; lazyTouched: string[] }> = {};
  for (const [tabId, v] of entries) {
    const o = v as Record<string, unknown>;
    tabs[tabId] = { cards: toStringArray(o.cards), lazyTouched: toStringArray(o.lazyTouched) };
  }
  return { kind: "byTab", tabs };
}

/** 取一个 tabs 容器快照里出现过的全部字段 id（按快照顺序，已去重）。 */
export function tabFieldIdsOf(entry: TabsSnapshot): string[] {
  if (entry.kind === "bucket") return [...entry.cards];
  if (entry.kind === "byTab") {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const b of Object.values(entry.tabs)) for (const id of b.cards) if (!seen.has(id)) { seen.add(id); out.push(id); }
    return out;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of entry.tabs) for (const id of tabIdsOfOne(t)) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/**
 * 编辑器本地的 tabs 配置 -> 快照信封里的 tabs 段。
 *
 * **产出对象形态**：一个容器一条，**值是对象** `{ cards, lazyTouched, tabs? }`，
 * 其中 `tabs` 字段的值才是 `TabConfig[]`（一个元素 = 一个选项卡页），
 * 页 id / 页名 / 字段顺序 / 卡片宽度 / 行边界全部随信封走，回退时原样还原。
 * 值不能是裸数组 —— 后端 `normalizeTabs` 走 `isPlainObject(input[key])`，裸数组会被判成
 * `{}` 整条丢掉，届时「回退前自动备份」存进去的 tabs 段是空的（P0 静默丢数据）。
 * `widths: {}` 与 `rows: []` 会被省掉（信封契约：可选字段不存在就省略，不塞空壳占位）。
 *
 * 为什么不能用扁平 `{ cards: [...] }`：展平会把 `widths` 与 `rows` 丢掉，
 * 回退后字段虽然回来了，但全部平铺、宽度走默认、分行全没了 —— 那是假回退。
 */
export function buildTabsSnapshot(configById: Record<string, readonly TabConfig[]>): Record<string, TabsSnapshotWire> {
  const out: Record<string, TabsSnapshotWire> = {};
  for (const [fieldId, tabs] of Object.entries(configById)) {
    const structured = tabs.filter(isTabConfig).map(compactTab);
    // cards 仍要写：老消费端（含后端判重与旧渲染端）只认它；缺了会被当成空容器
    const cards: string[] = [];
    for (const t of structured) for (const id of tabIdsOfOne(t)) if (!cards.includes(id)) cards.push(id);
    const entry: TabsSnapshotWire = { cards, lazyTouched: [] };
    // 结构快照非空才落进信封，与后端口径一致（老信封保持字节不变）
    if (structured.length > 0) entry.tabs = structured;
    out[fieldId] = entry;
  }
  return out;
}

/**
 * 后端 `POST /api/views/:viewId/detail-layout` 目前**能不能清空**一个选项卡容器。
 *
 * 现状 false：提交 `tabs: { 容器id: [] }` 会返回 200，但后端两处叠加导致**根本不写库** ——
 *   ① 路由只在 `entry.tabs.length > 0` 时才把该键收进待写集合；
 *   ② 净化阶段把空数组整条丢掉，写库对象里连这个键都不存在。
 * 于是前端看上去"保存成功、容器已清空"，刷新后旧分页原样回来 —— **静默 no-op**，
 * 比报错糟：用户以为做完了，实际什么都没发生。
 *
 * 后端已将这条作为 A1 报总监裁决，**裁决结果：本轮不做**（范围原因 —— 当前 UI 造不出 0 页
 * 容器、本轮需求里也没有"清空容器"这个功能，做了没有入口能用）。故本常量**保持 false**，
 * 保持到 A1 真正落地为止。
 *
 * **关于"这段代码现在跑得到吗"**（别让它变成没人知道会不会跑的代码）：
 * 当前 UI 路径**造不出 0 页容器**，两道保险 ——
 *   ① `initialTabsConfig` 对没有 tabsConfig 的容器兜一个默认页（"基本信息"）；
 *   ② `removeTab` 拦住删除最后一个分页（`tabs.length <= 1`）。
 * 于是前端写出去的快照里每个容器都至少有 1 页，**空容器版本从 UI 无从产生**，这条分支今天
 * 可达性为零；只可能被三类来源触发：直接调 API 打出来的空版本（后端 e2e 就是这么造的）、
 * 将来若加"清空该容器"入口、或外来/异构快照。**留着它买的不是功能，是"真出现空版本时不会
 * 静默错位"** —— 若删掉，一旦出现空版本，前端会填成 0 页 + toast 成功 + 保存静默不落库，
 * 且没有任何代码兜得住。
 *
 * 为什么不顺手删掉：删了等于把"将来重新开放清空"的能力一起埋掉，而保留它的成本只是一个
 * false + 一条测试。**列入待办**：若将来确认"永久不支持清空"，则这道防线的正确形态是硬约束
 * （直接不允许把容器填成 0 页），届时把常量删掉、toast 文案改成永久口径。本轮不做。
 */
export const TABS_CLEAR_SUPPORTED = false;

/**
 * 这份快照是不是「这个容器当时就是 0 页」。
 *
 * 判据：**既没有结构化 tabs（键不存在、或存在但是空数组），也没有扁平 cards**。
 *
 * 为什么必须写成"没有 tabs **或** tabs 为空"，而不是 `tabs.length === 0`：
 * 后端三个产路口（`formLayoutSnapshot.ts` / `formLayoutVersion.ts` / 净化）都是
 * **非空才落 `tabs` 键**，所以库里的信封里"空容器"长这样 —— `{ cards: [], lazyTouched: [] }`，
 * **根本没有 `tabs` 键**。只查 `tabs.length === 0` 会永远 false，回退那条分支等于白写，
 * 而且今天测不出来（这个态要等 A1 落地才可达），等到那天才暴雷。
 *
 * 另外，"从没配过"和"配了又被清空"在信封上确实长得一样 —— 但两者语义等价（都是"现在 0 页"），
 * 不需要区分，这里也不再区分（早期版本曾把它当"可疑空"一律跳过，那会让 A1 之后永远清不空）。
 */
export function isEmptyTabsEntry(entry: TabsSnapshot): boolean {
  const structured = entry.kind === "config" ? entry.tabs.length : 0;
  return structured === 0 && tabFieldIdsOf(entry).length === 0;
}

/**
 * 把快照里的 tabs 容器还原成可写回的 TabConfig[]。
 *
 * - **kind=config（结构化，正常路径）**：快照本身就是完整 tabsConfig，逐字节原样还原，
 *   页 id / 页名 / 宽度 / 行边界全部回来。这是"回到当时的样子"能成立的前提。
 * - kind=bucket / byTab（老的扁平形态，只可能来自存量快照）：只有扁平字段 id 列表，
 *   宽度与行边界**天生就没存**，只能以当前表上该字段已有的 TabConfig 为骨架重建：
 *   保留页 id、页名、每页内的行与宽度，只把字段重新分配回各页。分配规则与后端
 *   domain/formLayoutSnapshot.ts 的 distributeCards 同口径：
 *     ① 每页先留住「当前属于自己、且快照里也有」的字段（保持当前页内顺序）；
 *     ② 快照里剩下没归属的字段集中追加到第一页。
 */
export function restoreTabsConfig(entry: TabsSnapshot, current: readonly TabConfig[]): TabConfig[] {
  if (entry.kind === "config") return entry.tabs.map((t) => ({ ...t }));

  const wanted = tabFieldIdsOf(entry);
  if (wanted.length === 0) return [];

  // 当前没有任何骨架：造一个兜底页，不能把快照内容吞掉
  const skeleton: TabConfig[] = current.length > 0
    ? current.map((t) => ({ ...t }))
    : [{ id: "tab_restored", name: "基本信息", fieldIds: [] }];

  const wantedSet = new Set(wanted);
  const taken = new Set<string>();
  const assigned = new Map<string, string[]>();
  for (const t of skeleton) {
    const keep = tabIdsOfOne(t).filter((id) => wantedSet.has(id) && !taken.has(id));
    for (const id of keep) taken.add(id);
    assigned.set(t.id, keep);
  }
  const left = wanted.filter((id) => !taken.has(id));
  if (left.length > 0) {
    const firstId = skeleton[0]!.id;
    assigned.set(firstId, [...(assigned.get(firstId) ?? []), ...left]);
  }

  return skeleton.map((t, i) => {
    const id = t.id || `tab_restored_${i}`;
    const name = t.name || `选项卡 ${i + 1}`;
    return withCards(t, id, name, assigned.get(t.id) ?? []);
  });
}

/** 按 cards 重写一个 TabConfig：保留字段原本所在的行与宽度，新字段追加到末行。 */
function withCards(tab: TabConfig, id: string, name: string, cards: string[]): TabConfig {
  const rowOf = new Map<string, number>();
  const widthOf = new Map<string, number>();
  const rows = tab.rows ?? [];
  rows.forEach((r, ri) => {
    for (const it of r.items ?? []) {
      if (!widthOf.has(it.fieldId)) {
        widthOf.set(it.fieldId, Number(it.widthPct));
        rowOf.set(it.fieldId, ri);
      }
    }
  });
  for (const [fid, w] of Object.entries(tab.widths ?? {})) if (!widthOf.has(fid)) widthOf.set(fid, Number(w));
  const widthFor = (fid: string): FieldWidthPct => {
    const w = Number(widthOf.get(fid));
    return w === 25 || w === 50 || w === 75 || w === 100 ? (w as FieldWidthPct) : 50;
  };
  const widths: Record<string, FieldWidthPct> = {};
  for (const fid of cards) widths[fid] = widthFor(fid);

  if (rows.length === 0) return { id, name, fieldIds: cards, widths };

  const buckets: { fieldId: string; widthPct: FieldWidthPct }[][] = rows.map(() => []);
  const tail: { fieldId: string; widthPct: FieldWidthPct }[] = [];
  for (const fid of cards) {
    const item = { fieldId: fid, widthPct: widthFor(fid) };
    const ri = rowOf.get(fid);
    if (ri === undefined || !buckets[ri]) tail.push(item);
    else buckets[ri]!.push(item);
  }
  const nextRows = buckets.filter((r) => r.length > 0);
  if (tail.length > 0) nextRows.push(tail);
  return { id, name, fieldIds: cards, widths, rows: nextRows.map((items) => ({ items })) };
}
