// apps/web/src/features/views/view-config-route.ts
// 视图配置「使用态 vs 结构层」分流（#561）。
//
// 普通成员在使用视图时产生的改动（搜索/筛选/排序/行高/分组折叠/分组字段/聚合显示）
// 只属于他自己，应写入该用户的 prefs，不覆盖共享 views.config；
// 结构层改动（字段范围/顺序/封面/卡片/详情/行颜色/表单/详情布局，以及视图重命名）
// 仍走原 PATCH /api/views/:id（且受 canSchema 权限约束）。
//
// 本文件是纯函数、无副作用，方便单测与在 ViewShell 中复用。
// 键集合与 packages/shared-types/src/viewUserPrefs.ts 的 7 个使用态键严格一致。

import type { ViewConfig, ViewUserPrefs } from "@gx/shared-types";

/** 写入个人 prefs 的「使用态」键（顺序无业务含义，仅作稳定枚举）。 */
export const USE_STATE_KEYS = [
  "filters",
  "sorts",
  "search",
  "rowHeight",
  "collapsedGroupKeys",
  "groupByFieldId",
  "aggregations",
] as const;

export type UseStateKey = (typeof USE_STATE_KEYS)[number];

const USE_STATE_KEY_SET: ReadonlySet<string> = new Set(USE_STATE_KEYS);

/**
 * 判断一个 config 局部补丁是否「只含使用态键」。
 * - 空对象返回 false：没有任何键可写，不应触发 prefs 通道。
 * - 只要混入一个非使用态键（如 hiddenFieldIds/detailLayout/rowColor…）即返回 false，
 *   交由原 updateView 通道处理。
 */
export function isUseStatePatch(partial: Record<string, unknown>): boolean {
  const keys = Object.keys(partial);
  if (keys.length === 0) return false;
  return keys.every((k) => USE_STATE_KEY_SET.has(k));
}

/**
 * 从一份（可能是本地合成的）ViewConfig 中抽出 7 个使用态键，
 * 组成可直接发给 PUT /api/views/:id/prefs 的补丁。不含 version，也不含任何结构层键。
 */
export function pickUseState(
  config: ViewConfig,
): Partial<Omit<ViewUserPrefs, "version">> {
  return {
    filters: config.filters,
    sorts: config.sorts,
    search: config.search,
    rowHeight: config.rowHeight,
    collapsedGroupKeys: config.collapsedGroupKeys,
    groupByFieldId: config.groupByFieldId,
    aggregations: config.aggregations,
  };
}
