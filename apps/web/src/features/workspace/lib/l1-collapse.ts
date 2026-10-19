// 阶段 1 壳层（骨架 S-1）：L1 折叠档持久化（R-N-07/08）。
//
// R-N-08 要求折叠态写 localStorage、跨会话保持、且不写 URL，故收敛到本模块单一真源，
// 避免各调用点各起键名。读写全量 try/catch：隐私模式 / 配额满时静默降级为「展开」。

/** localStorage 键：L1 折叠态（"1" 折叠 / 其余或缺失 = 展开）。 */
export const L1_COLLAPSED_KEY = "gx.l1.collapsed";

/** L1 两档宽度（2026-10-19 真机目验：展开档由 224 收窄到 196；折叠档仍 56）。 */
export const L1_WIDTH_EXPANDED = 196;
export const L1_WIDTH_COLLAPSED = 56;

/** L2 常驻宽度（骨架 S-1）。无二级内容时为 0（不占位）。 */
export const L2_WIDTH = 240;

/** R-D-30：1280–1439 档 L2 压到 208（其余档仍为 240）。 */
export const L2_WIDTH_COMPACT = 208;

/** 顶栏高度（骨架 S-1）。 */
export const TOPBAR_H = 56;

export function readL1Collapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(L1_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeL1Collapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(L1_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // localStorage 不可用（隐私模式 / 配额）时静默：折叠态退化为单次会话内有效
  }
}
