// apps/web/src/lib/clipboard.ts
// 复制文本的单一真源：三级降级，保证非安全上下文（局域网 HTTP 直连，如
// http://192.168.31.167）下「复制」按钮不会必然失败。
//
// 背景（已坐实的缺陷）：navigator.clipboard 只在安全上下文（HTTPS / localhost /
// file://）存在。本产品实际以局域网 HTTP 部署，navigator.clipboard === undefined，
// 裸调用 `navigator.clipboard.writeText(...)` 直接抛 TypeError → 被 catch 成
// 「复制失败」，且没有任何降级路径，用户只能手选。
//
// 三级降级：
//   1. 安全上下文 + 异步剪贴板 API（权限可能被拒 / 缺用户手势，必须 catch 后继续降级）；
//   2. document.execCommand("copy") + 临时只读 textarea（HTTP 与老浏览器兜底，含 iOS 坑）；
//   3. 都失败 → 返回 false，由调用方给「手动选中 + Ctrl/⌘C」的明确提示。

/** 复制失败统一提示：复制对象是链接 / URL 时使用。 */
export const COPY_FAIL_HINT_LINK = "复制失败，请手动选中链接后按 Ctrl/⌘ + C";
/** 复制失败统一提示：复制对象是令牌 / 代码片段等非链接文本时使用。 */
export const COPY_FAIL_HINT_TEXT = "复制失败，请手动选中内容后按 Ctrl/⌘ + C";

type WriteText = (text: string) => Promise<void>;

/**
 * 路径 1：异步剪贴板 API。仅安全上下文可用；不可用时返回 null 让调用方降级。
 * 注意必须绑定 this —— 部分浏览器（Safari）对未绑定的 clipboard 方法抛 Illegal invocation。
 */
function asyncClipboard(): WriteText | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  if (window.isSecureContext !== true) return null;
  const api: { writeText?: WriteText } | undefined = navigator.clipboard as
    | { writeText?: WriteText }
    | undefined;
  return typeof api?.writeText === "function" ? api.writeText.bind(api) : null;
}

function currentRange(doc: Document): Range | null {
  if (typeof doc.getSelection !== "function") return null;
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return sel.getRangeAt(0).cloneRange();
}

function restoreRange(doc: Document, range: Range | null): void {
  if (!range || typeof doc.getSelection !== "function") return;
  const sel = doc.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * 路径 2：execCommand("copy") + 临时 textarea。
 * 移动端三个必须处理的坑（不处理会在 iOS Safari 上静默失败）：
 *   - textarea 需 contentEditable=true 且 readOnly=true，否则 iOS 选不中；
 *   - select() 在 iOS 老版本无效，用 setSelectionRange(0, len*2) 超大上界兜底；
 *   - 元素需移出视口但不能 display:none / visibility:hidden（不可选中则复制不到），
 *     故用 position:fixed + opacity:0；fontSize:16px 防 iOS 聚焦时页面缩放。
 */
function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const doc = document;
  if (typeof doc.execCommand !== "function") return false;
  const host = doc.body ?? doc.documentElement;
  if (!host) return false;

  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.contentEditable = "true";
  ta.readOnly = true;
  ta.setAttribute("readonly", "");
  const st = ta.style;
  st.position = "fixed";
  st.top = "0";
  st.left = "0";
  st.opacity = "0";
  st.pointerEvents = "none";
  st.fontSize = "16px";

  const prevFocus = doc.activeElement as HTMLElement | null;
  const prevRange = currentRange(doc);

  host.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length * 2);
    return doc.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    if (prevFocus && typeof prevFocus.focus === "function") {
      prevFocus.focus({ preventScroll: true });
    }
    restoreRange(doc, prevRange);
  }
}

/**
 * 复制文本到剪贴板，成功 true / 失败 false。任何情况下都不抛异常。
 * 调用方约定：true → toast("…已复制","success")；false → toast(COPY_FAIL_HINT_*,"error")
 * 并主动 select() 只读输入框，让用户可直接按 Ctrl/⌘ + C。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // 路径 1：现代 / 安全上下文。权限被拒、缺用户手势都会 reject，catch 后落到路径 2。
  try {
    const write = asyncClipboard();
    if (write) {
      await write(text);
      return true;
    }
  } catch {
    /* 落到下一级 */
  }

  // 路径 2：HTTP 与老浏览器兜底。
  try {
    if (execCommandCopy(text)) return true;
  } catch {
    /* 落到下一级 */
  }

  // 路径 3：全部失败，交由调用方提示手动复制。
  return false;
}
