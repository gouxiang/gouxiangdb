// apps/api/src/domain/formLayoutSanitize.ts
// 布局快照的纯净化：剔除已删字段留下的孤儿 item 与孤儿 tab slot。
//
// 只做"剔除"，不改结构 —— 不清空后重排、不扁平化嵌套、不改 colCount / 行边界。
// 纯函数；事务版（查存活字段 → 组装 alive 索引 → 调本文件）在 formLayoutReplay.ts。

import type { DetailLayout, FieldWidthPct } from "@gx/shared-types";
import {
  applyCardsToTab,
  tabMemberIds,
  type FormLayoutSnapshotEnvelope,
  type FormLayoutTabSnapshot,
} from "./formLayoutSnapshot.js";

// ---------------------------------------------------------------------------
// 纯净化（剔除已删字段留下的孤儿引用）
// ---------------------------------------------------------------------------

/** 当前表里仍然存活的字段 / tab 索引，由 sanitizeLayoutTx 查出来后喂给纯函数。 */
export interface LayoutAliveIndex {
  /** 未软删的字段 id */
  fieldIds: Set<string>;
  /** tabs 容器字段 id -> 该容器下现存 tab id 集合 */
  tabIdsByContainer: Map<string, Set<string>>;
}

export interface SanitizeResult {
  envelope: FormLayoutSnapshotEnvelope;
  /** 被剔除的孤儿字段 id（去重） */
  removedFieldIds: string[];
  /** 被剔除的孤儿 tabs 键（容器字段已删或该 uuid 已不存在） */
  removedTabKeys: string[];
}

/** 该 tabs 键是否仍存在：容器 id 命中，或某个容器的 tab uuid 命中。 */
function knownTabIds(key: string, alive: LayoutAliveIndex): Set<string> {
  const own = alive.tabIdsByContainer.get(key);
  if (own) return own;
  for (const ids of alive.tabIdsByContainer.values()) {
    if (ids.has(key)) return ids;
  }
  return new Set<string>();
}

function isAliveTabKey(key: string, alive: LayoutAliveIndex): boolean {
  if (alive.tabIdsByContainer.has(key)) return true;
  for (const ids of alive.tabIdsByContainer.values()) {
    if (ids.has(key)) return true;
  }
  return false;
}

/**
 * 净化信封：只剔除孤儿 item 与孤儿 tab slot ——
 *   - 不动行边界（不清空后再重排）、不改 colCount、不扁平化嵌套（tabs 行内结构原样留）；
 *   - 行内字段被删光后该行整行移除（空行没有承载信息，留着会渲染成空带）。
 */
export function sanitizeEnvelopeWith(
  env: FormLayoutSnapshotEnvelope,
  alive: LayoutAliveIndex,
): SanitizeResult {
  const removedFieldIds = new Set<string>();
  const removedTabKeys: string[] = [];

  // layout：逐行过滤已删字段，同步收窄 widths；空行移除。
  let layout: DetailLayout | null = null;
  if (env.layout) {
    const rows = env.layout.rows.map((r) => {
      const fieldIds = r.fieldIds.filter((id) => {
        if (alive.fieldIds.has(id)) return true;
        removedFieldIds.add(id);
        return false;
      });
      const widths: Record<string, FieldWidthPct> = {};
      if (r.widths) for (const id of fieldIds) if (r.widths[id] !== undefined) widths[id] = r.widths[id];
      return { colCount: r.colCount, fieldIds, ...(Object.keys(widths).length > 0 ? { widths } : {}) };
    }).filter((r) => r.fieldIds.length > 0);
    layout = { defaultRowColumns: env.layout.defaultRowColumns, rows };
  }

  // tabs：容器/tab uuid 已不存在的整条丢弃；仍存在的过滤掉已删字段的 card。
  const tabs: Record<string, FormLayoutTabSnapshot> = {};
  for (const key of Object.keys(env.tabs)) {
    const entry = env.tabs[key];
    if (!entry || !isAliveTabKey(key, alive)) {
      removedTabKeys.push(key);
      continue;
    }
    const cards = entry.cards.filter((id) => {
      if (alive.fieldIds.has(id)) return true;
      removedFieldIds.add(id);
      return false;
    });
    const tabIds = knownTabIds(key, alive);
    const cleaned: FormLayoutTabSnapshot = {
      cards,
      lazyTouched: entry.lazyTouched.filter((id) => tabIds.has(id)),
    };
    // 结构快照同样要剔除已删字段；用 applyCardsToTab 而不是暴力过滤，
    // 保住每个字段原本所在的行与宽度（行内剩 0 个字段的行会被它自己移除）。
    if (entry.tabs && entry.tabs.length > 0) {
      cleaned.tabs = entry.tabs.map((t) => {
        const kept = tabMemberIds(t).filter((id) => {
          if (alive.fieldIds.has(id)) return true;
          removedFieldIds.add(id);
          return false;
        });
        return applyCardsToTab(t, kept);
      });
    }
    tabs[key] = cleaned;
  }

  return {
    envelope: { version: env.version, layout, tabs },
    removedFieldIds: [...removedFieldIds],
    removedTabKeys,
  };
}
