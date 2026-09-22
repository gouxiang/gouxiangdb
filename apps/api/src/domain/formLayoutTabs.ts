// apps/api/src/domain/formLayoutTabs.ts
// 表单设计器布局：tabs 配置的解析 / 归一化 / 回写纯函数（无 IO、无 Prisma，单测可直接打）。
//
// 从 formLayoutSnapshot.ts 拆出来是为了守住「单文件 ≤300 行」公约：信封的构造、解析、
// 序列化与字段 id 枚举器留在 formLayoutSnapshot.ts，tabs 这一侧的解析与回写全在这里。
//
// 依赖方向固定为 **snapshot → tabs，不能反向**（反向会成环）：buildSnapshotEnvelope 要
// 调 normalizeTabs、collectReferencedFieldIds 要调 tabMemberIds。因此两个文件共用的取值
// 原语（isPlainObject / toStringList / 列数与宽度白名单）也放在本文件，由 snapshot import。
//
// formLayoutSnapshot.ts 会 re-export 本文件的全部导出 —— 既有 import 路径一律不变，
// 调用方不需要感知这次拆分。

import type {
  DetailRowColumns,
  FieldWidthPct,
  FormLayoutTabSnapshot,
  TabConfig,
  TabLayoutItem,
} from "@gx/shared-types";

// ---------------------------------------------------------------------------
// 取值原语（layout 与 tabs 共用）
// ---------------------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 只收非空字符串，去重保序；非数组/非字符串一律当空（快照来自前端，不信任入参）。 */
export function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string" || x.length === 0 || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

const COL_COUNTS = [1, 2, 3, 4];
const WIDTH_PCTS = [25, 50, 75, 100];

/** 宽度占比是否落在合法档位（25/50/75/100）。layout 侧的 widths 归一化也用它，避免两份白名单漂移。 */
export function isWidthPct(w: unknown): boolean {
  return WIDTH_PCTS.includes(Number(w));
}

export function toColCount(v: unknown, fallback: DetailRowColumns): DetailRowColumns {
  const n = Number(v);
  return COL_COUNTS.includes(n) ? (n as DetailRowColumns) : fallback;
}

// ---------------------------------------------------------------------------
// tabs 配置的解析与重建
// ---------------------------------------------------------------------------

/** 解析字段上的 tabsConfig 列；坏数据降级为 []（宁可不回写，也不要把 null 写坏整列）。 */
export function parseTabConfigs(raw: string | null | undefined): TabConfig[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  return coerceTabConfigs(v);
}

/**
 * 把任意入参强制成 TabConfig[]，并按固定键序（id -> name -> fieldIds -> widths -> rows）
 * 重建每个 tab —— 这样同一份内容序列化出的字符串是确定的，可用于判脏。
 */
export function coerceTabConfigs(v: unknown): TabConfig[] {
  if (!Array.isArray(v)) return [];
  const out: TabConfig[] = [];
  for (const t of v) {
    if (!isPlainObject(t)) continue;
    const id = typeof t["id"] === "string" ? t["id"] : "";
    if (id.length === 0) continue;
    const fieldIds = toStringList(t["fieldIds"]);
    const widths: Record<string, FieldWidthPct> = {};
    const rawWidths = isPlainObject(t["widths"]) ? t["widths"] : null;
    if (rawWidths) {
      for (const fid of fieldIds) {
        const w = Number(rawWidths[fid]);
        if (WIDTH_PCTS.includes(w)) widths[fid] = w as FieldWidthPct;
      }
    }
    const rowsRaw = Array.isArray(t["rows"]) ? t["rows"] : null;
    const rows = rowsRaw
      ? rowsRaw.filter(isPlainObject).map((r) => ({
          items: (Array.isArray(r["items"]) ? r["items"] : [])
            .filter(isPlainObject)
            .map((it) => {
              const w = Number(it["widthPct"]);
              return {
                fieldId: String(it["fieldId"] ?? ""),
                widthPct: (WIDTH_PCTS.includes(w) ? w : 50) as FieldWidthPct,
              };
            })
            .filter((it) => it.fieldId.length > 0),
        })).filter((r) => r.items.length > 0)
      : null;
    const tab: TabConfig = {
      id,
      name: typeof t["name"] === "string" ? t["name"] : "",
      fieldIds,
    };
    if (Object.keys(widths).length > 0) tab.widths = widths as TabConfig["widths"];
    if (rows && rows.length > 0) tab.rows = rows;
    out.push(tab);
  }
  return out;
}

/** tab 内的字段顺序：rows 优先（新数据），缺失时回退 fieldIds。 */
export function tabFieldIds(tab: TabConfig): string[] {
  const rows = Array.isArray(tab.rows) ? tab.rows : null;
  if (rows && rows.length > 0) {
    const out: string[] = [];
    for (const r of rows) for (const it of r.items ?? []) if (!out.includes(it.fieldId)) out.push(it.fieldId);
    return out;
  }
  return Array.isArray(tab.fieldIds) ? tab.fieldIds.filter((x) => typeof x === "string") : [];
}

/**
 * tab 内【所有被引用到的】字段 id（去重保序）：rows 优先，再补 fieldIds 里的漏网项。
 *
 * 为什么不能直接拿 tabFieldIds 或 t.fieldIds 某一个：TabConfig 是 rows 与 fieldIds/widths
 * **双写**的（见 shared-types 的注释），历史上一旦某一版没同步好两者就会漂 ——
 * 只取一边会把"另一边独有的活着字段"当成已删，在回退/净化里被静默剔除。
 * 这里取并集（rows 口径在前，fieldIds 补在后面），净化只删"两边都没有且库里也不存在"的。
 */
export function tabMemberIds(tab: TabConfig): string[] {
  const out: string[] = [];
  const push = (id: unknown): void => {
    if (typeof id !== "string" || id.length === 0 || out.includes(id)) return;
    out.push(id);
  };
  for (const id of tabFieldIds(tab)) push(id);
  for (const id of Array.isArray(tab.fieldIds) ? tab.fieldIds : []) push(id);
  for (const r of Array.isArray(tab.rows) ? tab.rows : []) {
    for (const it of r.items ?? []) push(it.fieldId);
  }
  return out;
}

/**
 * 把一份有序 cards 写回单个 tab。
 * 纪律：保留每个字段原本所在的行与宽度（不重排列、不扁平化），
 * 快照里新出现、当前 tabsConfig 里没有的字段追加到末行。
 */
export function applyCardsToTab(tab: TabConfig, cards: string[]): TabConfig {
  const widthOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  rows.forEach((row, ri) => {
    for (const it of row.items ?? []) {
      if (widthOf.has(it.fieldId)) continue;
      widthOf.set(it.fieldId, Number(it.widthPct));
      rowOf.set(it.fieldId, ri);
    }
  });
  for (const [fid, w] of Object.entries(tab.widths ?? {})) {
    if (!widthOf.has(fid)) widthOf.set(fid, Number(w));
  }
  const widthFor = (fid: string): FieldWidthPct => {
    const w = widthOf.get(fid);
    return WIDTH_PCTS.includes(Number(w)) ? (Number(w) as FieldWidthPct) : 50;
  };
  const widths: Record<string, FieldWidthPct> = {};
  for (const fid of cards) widths[fid] = widthFor(fid);

  if (rows.length === 0) {
    return { id: tab.id, name: tab.name, fieldIds: cards, widths };
  }
  const buckets: TabLayoutItem[][] = rows.map(() => []);
  const tail: string[] = [];
  for (const fid of cards) {
    const ri = rowOf.get(fid);
    if (ri === undefined || !buckets[ri]) {
      tail.push(fid);
      continue;
    }
    buckets[ri].push({ fieldId: fid, widthPct: widthFor(fid) });
  }
  const nextRows = buckets.filter((r) => r.length > 0);
  if (tail.length > 0) {
    nextRows.push(tail.map((fid) => ({ fieldId: fid, widthPct: widthFor(fid) })));
  }
  return { id: tab.id, name: tab.name, fieldIds: cards, widths, rows: nextRows.map((items) => ({ items })) };
}

// ---------------------------------------------------------------------------
// tabs 映射的归一化
// ---------------------------------------------------------------------------

/**
 * 归一化 tabs 时被"静默归零"的容器值 —— 调用方必须据此报警或拒绝，不能吞掉。
 *
 * kind：
 *   - "not-object"：值是数组 / 字符串 / 数字 / 布尔等非对象。前端最容易犯的一种是把
 *     `tabs[容器id]` 直接发成裸的 TabConfig[]（结构化数组应嵌在容器对象的 `tabs` 键里），
 *     旧实现会把它静默变成 `{}`，于是整个容器的选项卡配置无声丢失且不报错。
 *   - "object-without-members"：是对象，但既没有 cards 也没有 fieldIds/tabs，
 *     等于一个空容器 —— 多半也是发错了，但语义上无害，只作提示。
 */
export interface NormalizeTabIssue {
  key: string;
  kind: "not-object" | "object-without-members";
}

/** 归一化 tabs 映射并带回可疑项（防御性，供 API 边界拒绝或告警）。 */
export function normalizeTabsWithIssues(
  input: unknown,
): { tabs: Record<string, FormLayoutTabSnapshot>; issues: NormalizeTabIssue[] } {
  if (!isPlainObject(input)) return { tabs: {}, issues: [] };
  const out: Record<string, FormLayoutTabSnapshot> = {};
  const issues: NormalizeTabIssue[] = [];
  for (const key of Object.keys(input).filter((k) => k.length > 0).sort()) {
    const raw = input[key];
    // null / undefined 视为"这个容器当前为空"，是合法语义，不算可疑
    const isEmpty = raw === null || raw === undefined;
    if (!isPlainObject(raw)) {
      if (!isEmpty) issues.push({ key, kind: "not-object" });
    }
    const src = isPlainObject(raw) ? raw : {};
    const cards = toStringList(src["cards"] ?? src["fieldIds"]);
    const tabs = coerceTabConfigs(src["tabs"]);
    if (isPlainObject(raw) && cards.length === 0 && tabs.length === 0) {
      issues.push({ key, kind: "object-without-members" });
    }
    const entry: FormLayoutTabSnapshot = { cards, lazyTouched: toStringList(src["lazyTouched"]) };
    // 结构快照只在非空时落进信封：老信封没有这个字段，保持字节不变（向后兼容）。
    if (tabs.length > 0) entry.tabs = tabs;
    out[key] = entry;
  }
  return { tabs: out, issues };
}

/** 归一化 tabs 映射：键升序（确定性），值内键序固定为 cards -> lazyTouched -> tabs。 */
export function normalizeTabs(input: unknown): Record<string, FormLayoutTabSnapshot> {
  return normalizeTabsWithIssues(input).tabs;
}
