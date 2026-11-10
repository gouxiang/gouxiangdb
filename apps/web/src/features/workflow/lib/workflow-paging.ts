// 工作流 page 基分页纯函数（#1317 刀 C3-a1）：零 IO、零 React，可表驱动单测。
//
// 后端工作流列表路由是【页码 page/limit】模型（不是 keyset 游标），单页上下限对齐
// apps/api/src/domain/workflow/workflowService.ts:21-22：DEFAULT_PAGE_SIZE=20、MAX_PAGE_SIZE=100。
// 刻意不 import features/kb/public-share-model.ts 的 pagerModel（那是 offset 基且跨 feature 反向耦合），
// 在 workflow 域内独立写 page 基版本；src/api/records-paging.ts 是 keyset 游标，与本文件无关。

/** 默认单页条数（对齐后端 workflowService.ts:21 DEFAULT_PAGE_SIZE）。 */
export const WORKFLOW_DEFAULT_PAGE_SIZE = 20;
/** 单页条数上限（对齐后端 workflowService.ts:22 MAX_PAGE_SIZE，超限请求会被夹到该值）。 */
export const WORKFLOW_MAX_PAGE_SIZE = 100;

/** 分页器推导状态（1 基页码；from/to 是给用户看的条目序号，total=0 时 from 为 0）。 */
export interface WorkflowPageState {
  page: number;
  pageSize: number;
  /** 当前页首条序号（1 基；总数为 0 时为 0）。 */
  from: number;
  /** 当前页末条序号。 */
  to: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
}

/** 页码规整：非有限数 / 非整数 / <1 一律回落第 1 页。 */
function normalizePage(page: number): number {
  return Number.isFinite(page) && Number.isInteger(page) && page >= 1 ? page : 1;
}

/** 单页条数规整：非法回落默认 20，超过上限 100 夹到 100。 */
function normalizePageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || !Number.isInteger(pageSize) || pageSize < 1) {
    return WORKFLOW_DEFAULT_PAGE_SIZE;
  }
  return Math.min(pageSize, WORKFLOW_MAX_PAGE_SIZE);
}

/** 总数规整：非有限数或负数回落 0（后端计数恒为非负整数）。 */
function normalizeTotal(total: number): number {
  return Number.isFinite(total) && total >= 0 ? total : 0;
}

/**
 * 由页码 / 单页条数 / 总数推导分页器状态。
 * 注意：当 page 超过实际总页数时，from 会大于 total、to 小于 from——纯函数如实计算不抹平，
 * UI 层通常会据此重拉回正（见测试锁定的超界行为），这里不擅自改页码以免掩盖调用方 bug。
 */
export function workflowPageState(page: number, pageSize: number, total: number): WorkflowPageState {
  const safePage = normalizePage(page);
  const safeSize = normalizePageSize(pageSize);
  const safeTotal = normalizeTotal(total);

  const from = safeTotal === 0 ? 0 : (safePage - 1) * safeSize + 1;
  const to = Math.min(safePage * safeSize, safeTotal);
  return {
    page: safePage,
    pageSize: safeSize,
    from,
    to,
    total: safeTotal,
    canPrev: safePage > 1,
    canNext: safePage * safeSize < safeTotal,
  };
}

/** 末页页码（total=0 时至少为 1，保证翻页夹边有合法落点）。 */
function lastPage(state: WorkflowPageState): number {
  return Math.max(1, Math.ceil(state.total / state.pageSize));
}

/** 上一页页码：不低于 1。 */
export function prevPage(state: WorkflowPageState): number {
  return Math.max(1, state.page - 1);
}

/** 下一页页码：不超过末页。 */
export function nextPage(state: WorkflowPageState): number {
  return Math.min(state.page + 1, lastPage(state));
}
