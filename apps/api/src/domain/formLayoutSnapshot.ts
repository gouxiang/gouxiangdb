// apps/api/src/domain/formLayoutSnapshot.ts
// 表单设计器布局快照的信封构造 / 解析 / 序列化 / 字段 id 枚举。
//
// 本文件全是纯函数（无 IO、无 Prisma），单测可直接打。事务版在 formLayoutVersion.ts。
// tabs 配置的解析与回写原语在 formLayoutTabs.ts（为守「单文件 ≤300 行」公约拆出），
// 本文件末尾原样 re-export —— 既有 import 路径一律不变，调用方不必感知这次拆分。
//
// 信封契约（前后端共用，改结构必须同时 bump SNAPSHOT_ENVELOPE_VERSION）：
//   {
//     "version": 1,
//     "layout": <DetailLayout 全量 JSON 或 null>,
//     "tabs": { "<tabs 字段 id 或 tab uuid>": {
//         "cards": string[], "lazyTouched": string[], "tabs"?: TabConfig[]
//     } }
//   }
//   - tabs 的键一律是 string；cards 是该容器内/该选项卡内的字段 id 有序列表；
//     lazyTouched 是前端为懒加载容器"已展开过"的 tab id 列表（回退时据此决定要不要补渲染）；
//     tabs 是可选的【结构快照】(TabConfig[])，承载"哪个字段在哪个 tab"、宽度占比 widths
//     与显式行边界 rows —— cards 只是展平的成员集合，只靠它回退多 tab 容器会丢分组与排版。
//     缺失时（历史信封）回退退化为按 cards 重建，不会报错。
//   - 键序固定（version -> layout -> tabs，tabs 内部按 key 升序），因此同一份内容
//     序列化出的字符串是确定的，前端可用字符串比较判脏。

import type { DetailLayout, DetailRowColumns, FieldWidthPct } from "@gx/shared-types";

// 信封的结构版本号与两个 interface 的唯一真源在 @gx/shared-types（layoutVersion.ts）：
// 前端要构造信封 POST 保护备份，类型若只在服务端就会被复制一份、改结构时必然漂。
// 这里 import 后原样 re-export，服务端既有 import 路径全部不变。
import {
  SNAPSHOT_ENVELOPE_VERSION,
  SNAPSHOT_ORDER_FIELDS,
  type FormLayoutSnapshotEnvelope,
  type FormLayoutTabSnapshot,
} from "@gx/shared-types";

import {
  isPlainObject,
  isWidthPct,
  normalizeTabs,
  tabMemberIds,
  toColCount,
  toStringList,
} from "./formLayoutTabs.js";

export { SNAPSHOT_ENVELOPE_VERSION, SNAPSHOT_ORDER_FIELDS };
export type { FormLayoutSnapshotEnvelope, FormLayoutTabSnapshot };

/** 物理表名（schema.prisma 里 FormLayoutVersion @@map 的值）。 */
export const FORM_LAYOUT_VERSIONS_TABLE = "form_layout_versions";

/**
 * 本特性的回滚 SQL（与 prisma/docs/rollback/20260924010000_form_layout_versions.down.sql
 * 同内容）：先删索引再删表。导出给运维脚本与单测对齐使用。
 */
export const rollback_FORM_LAYOUT_VERSIONS = [
  'DROP INDEX IF EXISTS "form_layout_versions_viewId_version_key";',
  'DROP INDEX IF EXISTS "form_layout_versions_viewId_idx";',
  'DROP TABLE IF EXISTS "form_layout_versions";',
].join("\n");

export function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 信封的构造 / 解析 / 序列化
// ---------------------------------------------------------------------------

/** 归一化 layout：非对象/无 rows 一律 null（"未编排"语义）；widths 只留仍在本行的字段。 */
export function normalizeLayout(input: unknown): DetailLayout | null {
  if (!isPlainObject(input)) return null;
  const rawRows = Array.isArray(input["rows"]) ? input["rows"] : null;
  if (!rawRows) return null;
  const rows = rawRows.filter(isPlainObject).map((r) => {
    const fieldIds = toStringList(r["fieldIds"]);
    const widths: Record<string, FieldWidthPct> = {};
    const rawWidths = isPlainObject(r["widths"]) ? r["widths"] : null;
    if (rawWidths) {
      for (const id of fieldIds) {
        const w = Number(rawWidths[id]);
        if (isWidthPct(w)) widths[id] = w as FieldWidthPct;
      }
    }
    const row: { colCount: DetailRowColumns; fieldIds: string[]; widths?: Record<string, FieldWidthPct> } = {
      colCount: toColCount(r["colCount"], 2),
      fieldIds,
    };
    if (Object.keys(widths).length > 0) row.widths = widths;
    return row;
  });
  return { defaultRowColumns: toColCount(input["defaultRowColumns"], 2), rows };
}

/**
 * 构造信封。键序严格按 SNAPSHOT_ORDER_FIELDS，tabs 键升序 —— 同一内容必得同一字符串。
 * 入参不合法时降级为"空布局 + 空 tabs"，不抛错（快照是旁路，不能阻断保存主流程）。
 */
export function buildSnapshotEnvelope(
  layout: unknown,
  tabs: unknown = {},
  version: number = SNAPSHOT_ENVELOPE_VERSION,
): FormLayoutSnapshotEnvelope {
  return {
    version,
    layout: normalizeLayout(layout),
    tabs: normalizeTabs(tabs),
  };
}

/** 从库里的 snapshot 字符串反解信封；坏 JSON / 非对象返回 null（调用方按"无快照"处理）。 */
export function extractSnapshot(raw: string | null | undefined): FormLayoutSnapshotEnvelope | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const v = typeof parsed["version"] === "number" ? parsed["version"] : SNAPSHOT_ENVELOPE_VERSION;
  return buildSnapshotEnvelope(parsed["layout"], parsed["tabs"], v);
}

/** 序列化（键序已由 buildSnapshotEnvelope 保证，勿再手动改字段顺序）。 */
export function serializeSnapshot(env: FormLayoutSnapshotEnvelope): string {
  return JSON.stringify(env);
}

/**
 * 信封里【所有被引用到的字段 id】（去重）的单一枚举器。
 *
 * 探活（sanitizeLayoutTx 查哪些字段还活着）与净化（剔除哪些字段）必须共用这一份，
 * 否则会出这种事故：某个字段只在结构快照 tabs[].fieldIds 里出现、没进 cards，
 * 于是它没被查探活 → 被判成"已删" → 静默剔除，哪怕它在库里活得好好的。
 * 以后信封再新增承载字段 id 的结构，只改这一处。
 */
export function collectReferencedFieldIds(env: FormLayoutSnapshotEnvelope): string[] {
  const out = new Set<string>();
  const add = (id: unknown): void => {
    if (typeof id === "string" && id.length > 0) out.add(id);
  };
  for (const r of env.layout?.rows ?? []) for (const id of r.fieldIds) add(id);
  for (const [key, entry] of Object.entries(env.tabs)) {
    add(key); // tabs 的键本身可能是容器字段 id，探活时要一并查（还要拿它的 tabsConfig）
    if (!entry) continue;
    for (const id of entry.cards) add(id);
    for (const t of entry.tabs ?? []) for (const id of tabMemberIds(t)) add(id);
  }
  return [...out];
}

/**
 * 判断一个 Prisma 异常是不是"tabsConfig 列不存在"。
 * 用途：tabsConfig 是历史迁移加的列，若某环境迁移没落齐，回退 tabs 这一步应【跳过并记日志】
 * 而不是让整个回退 500。只认"列名 + 缺失语义"同时命中，避免把别的错误误判吞掉。
 */
export function isMissingTabsConfigColumn(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!msg) return false;
  return /tabsConfig/i.test(msg) && /(no such column|does not exist|unknown (argument|field)|has no column)/i.test(msg);
}

// ---------------------------------------------------------------------------
// 再导出：tabs 侧纯函数（parseTabConfigs / coerceTabConfigs / normalizeTabs(WithIssues) /
// tabFieldIds / tabMemberIds / applyCardsToTab / NormalizeTabIssue）。
// 保留在文件末尾，是为了让既有 `from "./formLayoutSnapshot.js"` 的 import 一行都不用改。
// ---------------------------------------------------------------------------
export * from "./formLayoutTabs.js";
