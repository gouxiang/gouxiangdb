// 二级导航（L2）收起态持久化——与 l1-collapse.ts 同构（R-N-07/08 的 L2 版）。
//
// 与 L1 唯一的结构差别：L2 必须**三态**，L1 只需布尔两态。
//   原因：L2 的显隐在 768–1279 档是响应式行为（R-D-31/32 浮出面板默认收起），在 ≥1280 档是
//   常驻列。若照搬 L1「缺失即 false（展开）」的写法，档位默认态会被误当成用户意图落盘，
//   结果是「用户在窄屏被动收起一次 → 回到宽屏再也展开不回来」—— 正是本模块要修的死角。
//   故：null = 用户从未操作过（跟随档位）；true / false = 用户显式意图（压过档位）。
//
// 读写同样全量 try/catch：隐私模式 / 配额满时静默降级为「单次会话内有效」。

import { L1_WIDTH_COLLAPSED } from "./l1-collapse";

/** localStorage 键：L2 折叠态（"1" 收起 / "0" 展开 / 缺失或脏值 = 无用户意图）。 */
export const L2_COLLAPSED_KEY = "gx.l2.collapsed";

/** L2 收起态窄条宽度：与 L1 折叠档同规格（56），两条竖栏并排时视觉不打架。 */
export const L2_WIDTH_COLLAPSED = L1_WIDTH_COLLAPSED;

/**
 * 读用户显式意图。返回 null 表示「用户从未操作过」，调用方应改用响应式档位默认态。
 * SSR（无 window）一律 null：单测与真机首帧一致地走档位默认。
 */
export function readL2Collapsed(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(L2_COLLAPSED_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function writeL2Collapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(L2_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // localStorage 不可用（隐私模式 / 配额）时静默：折叠态退化为单次会话内有效
  }
}

/**
 * 优先级收口：用户显式意图 > 响应式档位默认。
 * 只有 intent 为 null（从未操作）时才采用 tierDefault（浮出档 true / 常驻档 false）。
 */
export function resolveL2Collapsed(intent: boolean | null, tierDefault: boolean): boolean {
  return intent ?? tierDefault;
}
