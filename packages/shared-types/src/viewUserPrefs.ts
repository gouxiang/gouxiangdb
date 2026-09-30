// packages/shared-types/src/viewUserPrefs.ts
// 视图「用户个性化」偏好契约（#561）。
//
// 三层模型：
//   · views.config     = 视图默认配置（建视图者 / 管理者设的默认筛选、排序…）
//   · view_user_prefs  = 每个用户在该视图上的使用态覆盖（#561，本表一行/(view,user)）
//   · views.adminConfig= 管理员强制层（#560，强制隐藏/范围/顺序/封面/强制筛选）
//
// 生效：effective = resolveViewConfig(admin, applyUserPrefs(viewDefault, userPrefs))。
//
// 个性化只覆盖「使用态」键（filters/sorts/search/rowHeight/分组折叠/分组字段/聚合显示）；
// 字段范围/顺序/封面/卡片/详情字段由管理员层与视图默认决定，用户偏好不含这些键——
// 普通用户不改变"看得到哪些字段"，字段可见性始终遵循管理员配置与权限。
//
// 存储口径：userPrefs 为【全量】使用态快照（用户首次保存时以当前生效使用态为基线）。
// 用户一旦自定义即固化，视图默认随后变化不影响已自定义的用户；提供"重置为默认"
// （删除该用户的 prefs 行）。未自定义的用户始终跟随最新视图默认。

import type { FilterNode } from "./filters.js";
import type {
  AggFunc,
  RowHeight,
  SortSpec,
  ViewConfig,
} from "./views.js";

/** 用户个性化版本（当前唯一版本）。 */
export const VIEW_USER_PREFS_VERSION = 1 as const;

export interface ViewUserPrefs {
  version: 1;
  /** 用户自己的筛选；null 表示用户已显式清空（区别于"未自定义"）。 */
  filters: FilterNode | null;
  sorts: SortSpec[];
  search: string;
  rowHeight: RowHeight;
  /** 分组折叠状态（纯使用态）。 */
  collapsedGroupKeys: string[];
  groupByFieldId: string | null;
  /** 聚合显示选择（fieldId -> 聚合函数 / null）。 */
  aggregations: Record<string, AggFunc | null>;
}

export function defaultViewUserPrefs(
  overrides: Partial<ViewUserPrefs> = {},
): ViewUserPrefs {
  return {
    version: 1,
    filters: null,
    sorts: [],
    search: "",
    rowHeight: "medium",
    collapsedGroupKeys: [],
    groupByFieldId: null,
    aggregations: {},
    ...overrides,
  };
}

/**
 * 用用户偏好覆盖视图默认的使用态键，产出该用户的用户层配置。
 * prefs=null（未自定义）时原样返回 base，用户始终跟随视图默认。
 * 其余非使用态键（hiddenFieldIds/fieldOrder/封面/卡片/详情/行颜色/表单/详情布局）一律保留
 * base，不被偏好修改。
 */
export function applyUserPrefs(
  base: ViewConfig,
  prefs: ViewUserPrefs | null,
): ViewConfig {
  if (!prefs) return base;
  return {
    ...base,
    filters: prefs.filters,
    sorts: prefs.sorts,
    search: prefs.search,
    rowHeight: prefs.rowHeight,
    collapsedGroupKeys: prefs.collapsedGroupKeys,
    groupByFieldId: prefs.groupByFieldId,
    aggregations: prefs.aggregations,
  };
}
