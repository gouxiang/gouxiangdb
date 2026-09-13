// apps/api/src/domain/queryPlan/flags.ts
// M1/S6 sidecar 读路径开关与阈值（与写侧 GX_M1_SIDECAR、hydration GX_HYDRATE_PREFETCH 独立）。
//
// GX_M1_SIDECAR_READ：
//   off（默认，含未设置）→ 读路径完全走 S5 行为（全表 hydrate + 内存 filter/sort），
//                          不查 sidecar、不产生新查询，回滚只需置 off。
//   shadow               → 旧路径结果照返回；额外跑物理计划器并对拍（recordId 序列/total/
//                          filteredTotal/aggregations），差异只记日志、绝不影响响应。
//   on                   → 读路径走 queryPlan 计划器（physical 下推 + 当页 hydrate）。
// 灰度纪律：shadow 连续一迭代差异 0 才允许切 on（对齐项目灰度约定，S7 起持续 shadow 观测）。
//
// 独立于写开关：GX_M1_SIDECAR=off（停写）时读 sidecar 无意义，planner 自动不启用。

export type SidecarReadMode = "off" | "shadow" | "on";

export function resolveSidecarReadMode(env: NodeJS.ProcessEnv = process.env): SidecarReadMode {
  const v = (env.GX_M1_SIDECAR_READ ?? "off").trim().toLowerCase();
  if (v === "on" || v === "shadow") return v;
  return "off"; // 默认保守：任何未知值/空值都回退
}

/** 写侧 sidecar 是否在维护（停写时读派生表无意义，强制回退旧路径）。 */
export function resolveSidecarWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GX_M1_SIDECAR !== "off";
}

/** 读计划器是否可实际启用（读开关非 off 且写侧未停）。shadow/on 分别由调用方区分。 */
export function sidecarReadUsable(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSidecarReadMode(env) !== "off" && resolveSidecarWriteEnabled(env);
}

/**
 * 受限宽口径阈值：含计算字段残余筛选/排序时，物理粗筛候选数超过该值则不硬算，
 * 由服务端返回 degraded 提示（S8 才在 UI 置灰，S6 只保证服务端口径、不伪造全量）。
 */
export const DEFAULT_INMEM_LIMIT = 50_000;

export function resolveInMemLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GX_M1_INMEM_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INMEM_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INMEM_LIMIT;
}
