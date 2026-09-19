// apps/web/src/features/detail/save-layout.ts
// 表单设计器「保存布局」链路的纯编排层（可单测，无 React / 无网络依赖）
//
// 修的缺陷（P1 · 静默数据丢失）：
//   旧链路在调用方用 TanStack `mutate`（不返回 Promise、失败也不抛错），于是无论请求
//   成功还是失败（断网 / 409 / 500）都会 toast「已保存布局」并关闭面板。用户以为存了，
//   实际没存，下次打开布局回到旧状态。
//   这里把「算不算保存成功」收敛为唯一判定点：**只有 await persist 成功**才回调
//   onSuccess（由调用方 toast 成功 + 关闭面板）；失败只回调 onError，绝不谎报成功。

/** 成功文案：只有 await 成功才出现，与失败文案严格互斥 */
export const SAVE_OK_TEXT = "已保存布局";

/** 失败兜底文案：拿不到后端原因时用（断网、空 message 等） */
export const SAVE_FAILED_TEXT = "保存失败，请重试";

/**
 * 取可读错误原因，优先级：后端信封 message → 后端信封 error → 错误对象 message → 兜底。
 * 空白一律视为「没有原因」，走兜底文案，不把 "API 500: undefined" 这类噪音抛给用户。
 *
 * 用结构化鸭子类型而非 instanceof ApiError：避免本模块为了一个类型去 import
 * api/client.ts（那边在模块初始化就读部署 base / 鉴权 store，不适合纯单测环境）。
 */
export function errorMessageOf(err: unknown, fallback: string = SAVE_FAILED_TEXT): string {
  const body = serverBodyOf(err);
  // ApiError（HTTP 非 2xx）：只认服务端信封文案。信封里没有原因就直接兜底 ——
  // 不外泄 "API 500:" 这类包装噪音给用户看。
  if (body) return serverMessageOf(body) || fallback;
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const trimmed = raw.trim();
  return trimmed || fallback;
}

/** 取 ApiError 风格错误上的服务端响应体；非该形态返回 null */
function serverBodyOf(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  const body = (err as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  return body as Record<string, unknown>;
}

/** 从服务端信封上取文案：message 优先，其次 error */
function serverMessageOf(body: Record<string, unknown>): string {
  const m = body.message;
  if (typeof m === "string" && m.trim()) return m.trim();
  const e = body.error;
  if (typeof e === "string" && e.trim()) return e.trim();
  return "";
}

export interface SaveLayoutHooks<T> {
  /** 真正的落库动作。必须返回 Promise，失败必须 reject（调用方已统一改用 mutateAsync） */
  persist: (layout: T) => Promise<unknown>;
  /** 保存成功：调用方 toast 成功并关闭面板 */
  onSuccess: () => void;
  /** 保存失败：调用方**保持面板打开**并展示真实错误 */
  onError: (message: string) => void;
}

/**
 * 保存布局。返回是否保存成功。
 *
 * 语义保证（单测锁定）：persist reject 时 onSuccess 一次都不调用 → 面板不会被关掉；
 * persist 成功时 onError 一次都不调用 → 不会同时弹成功和失败两条 toast。
 */
export async function runSaveLayout<T>(layout: T, hooks: SaveLayoutHooks<T>): Promise<boolean> {
  try {
    await hooks.persist(layout);
  } catch (err) {
    hooks.onError(errorMessageOf(err));
    return false;
  }
  hooks.onSuccess();
  return true;
}
