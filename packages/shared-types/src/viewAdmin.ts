// packages/shared-types/src/viewAdmin.ts
// 视图「管理员配置层」契约（#560）。
//
// 背景：原 ViewConfig 是单层共享配置，管理员设定（可展示字段范围/顺序、封面、视图级强制
// 筛选）与普通用户个性化（自己的筛选/排序/搜索）混在同一对象，任何人 PATCH 都会覆盖共享
// 配置。现将管理员设定独立成 ViewAdminConfig（views.adminConfig 列），用户态仍是 ViewConfig。
//
// 生效口径（resolveViewConfig）：
//   · 管理员 filters 对所有人生效，与用户 filters 做 AND；
//   · 管理员 hiddenFieldIds 强制隐藏，与用户 hiddenFieldIds 取并集；
//   · 管理员 fieldOrder 非空时强制列序，否则沿用用户 fieldOrder；
//   · 封面 coverFieldId / 画廊 cardFieldIds / 详情 detailFieldIds：管理员给值即以此为准；
//   · 其余键（行高/排序/搜索/分组/聚合/行颜色/表单/详情布局）沿用用户层。
// 合成后仍交既有管线；字段权限掩码（fieldMask/scope）在下游继续裁剪，故「字段可见性遵循
// 权限」自动成立——管理员层无法越过权限把无权字段放出来。

import type { FilterNode } from "./filters.js";
import type { ViewConfig } from "./views.js";

/** 管理员配置层版本（当前唯一版本）。 */
export const VIEW_ADMIN_CONFIG_VERSION = 1 as const;

export interface ViewAdminConfig {
  version: 1;
  /** 可展示字段的顺序；非空即作为视图列序（管理员统一列序）。 */
  fieldOrder: string[];
  /** 管理员强制隐藏的字段（所有用户都看不到）。 */
  hiddenFieldIds: string[];
  /** 视图级强制筛选：对所有用户生效，与用户个性化筛选 AND。 */
  filters: FilterNode | null;
  /** 画廊封面字段（attachment）。 */
  coverFieldId: string | null;
  /** 画廊卡片上展示的字段。 */
  cardFieldIds: string[];
  /** 详情视图字段范围/顺序。 */
  detailFieldIds: string[];
}

export function defaultViewAdminConfig(
  overrides: Partial<ViewAdminConfig> = {},
): ViewAdminConfig {
  return {
    version: 1,
    fieldOrder: [],
    hiddenFieldIds: [],
    filters: null,
    coverFieldId: null,
    cardFieldIds: [],
    detailFieldIds: [],
    ...overrides,
  };
}

/** 两棵过滤树取 AND；任一为 null 直接取另一棵。 */
export function andFilterNodes(
  a: FilterNode | null,
  b: FilterNode | null,
): FilterNode | null {
  if (!a) return b;
  if (!b) return a;
  return { kind: "and", children: [a, b] };
}

/** 两个字段 id 列表取并集（去重，保持先 a 后 b 的出现顺序）。 */
function unionIds(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...a, ...b]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 合成视图唯一生效配置：管理员层为基线，用户层叠加使用态。
 * admin=null（老视图 / 未配置）时原样返回 user，行为与历史完全一致。
 */
export function resolveViewConfig(
  admin: ViewAdminConfig | null,
  user: ViewConfig,
): ViewConfig {
  if (!admin) return user;
  return {
    ...user,
    filters: andFilterNodes(admin.filters, user.filters ?? null),
    hiddenFieldIds: unionIds(admin.hiddenFieldIds, user.hiddenFieldIds ?? []),
    fieldOrder: admin.fieldOrder.length > 0 ? admin.fieldOrder : user.fieldOrder,
    coverFieldId: admin.coverFieldId ?? user.coverFieldId,
    cardFieldIds: admin.cardFieldIds.length > 0 ? admin.cardFieldIds : user.cardFieldIds,
    detailFieldIds:
      admin.detailFieldIds.length > 0 ? admin.detailFieldIds : user.detailFieldIds,
  };
}
