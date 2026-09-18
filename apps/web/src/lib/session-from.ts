// apps/web/src/lib/session-from.ts
// R-D-17 会话过期（401）「来路」记录：重新登录后回到原页与原滚动位置。
//
// 刻意不写进 URL（避免改动既有 401 硬跳转的语义与可测性），只落在 sessionStorage，
// 登录成功后消费一次即清除。存储不可用（隐私模式 / SSR）时全部静默返回 null，
// 行为完全等同于没有该能力——不引入新的失败路径。
//
// 单独成文件的原因：apps/api 的登录页单测会整体 mock `api/client`，
// 若把读取函数放在 client.ts 里，mock 里拿不到它就会在渲染期抛错。

const KEY = "gx.session.from";

/** 401 拦截时调用：记下当前页（含查询串）。非 /login、非改密页才记。 */
export function saveSessionFrom(here: string): void {
  try {
    if (!here.startsWith("/") || here.startsWith("/login") || here.includes("/change-password")) return;
    window.sessionStorage.setItem(KEY, here);
  } catch {
    // 忽略：存储不可用时登录仍落到默认页
  }
}

/** 登录页调用：读出并清除「来路」。SSR / 无存储 / 值非法 → null。 */
export function takeSessionFrom(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const v = window.sessionStorage.getItem(KEY);
    if (v) window.sessionStorage.removeItem(KEY);
    return v && v.startsWith("/") ? v : null;
  } catch {
    return null;
  }
}
