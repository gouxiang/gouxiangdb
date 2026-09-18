// apps/web/src/lib/sanitize-html.ts
// 零依赖 HTML 消毒剂：用于渲染用户可编辑的「富文本(richText)」字段值。
//
// 背景：richText 的编辑控件是纯 textarea，用户可存入任意 HTML（含 <img onerror>、<script>），
// 网格单元格用 dangerouslySetInnerHTML 渲染时会立刻执行 —— 属存储型 XSS。
// 项目禁止引入新依赖（DOMPurify 等），这里用白名单 + 属性过滤自实现。
//
// 策略：
//  1. 仅保留白名单标签（文本结构 + 常用富文本标签），其余标签剥离为纯文本
//  2. 剥离所有事件属性（on*）与危险属性（style 内的 expression/url(javascript:)）
//  3. URL 属性（href/src）仅放行安全协议，其余置为 "#"

const ALLOWED_TAGS = new Set([
  "p", "br", "div", "span", "section", "article",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "ul", "ol", "li",
  "blockquote", "pre", "code", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
  "a", "img", "figure", "figcaption",
]);

/** 允许保留的属性（按标签限定） */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

/** URL 安全协议白名单（防 javascript:/data:text/html 存储型 XSS） */
export function isSafeUrlAttr(url: string): boolean {
  const u = url.trim();
  if (u === "") return true;
  // 控制字符（含换行/制表）可绕过协议检测，先剔除再判断
  const cleaned = u.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  if (cleaned.startsWith("/") || cleaned.startsWith("#") || cleaned.startsWith("?")) return true;
  // 带 scheme 前缀：仅放行 http(s)/mailto/tel；其余（javascript:/vbscript:/data:
  // 等，含内联 data: 图片与 data:text/html）一律 fail-closed。data: 已被上方
  // scheme 正则命中，此处不再单列 data 特判（旧代码第 42 行永不可达，已删）。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned)) {
    return /^(https?:|mailto:|tel:)/i.test(cleaned);
  }
  // 无协议前缀：按相对路径放行
  return true;
}

/**
 * 消毒用户 HTML。
 * 注意：本函数面向「受信任度低但只允许富文本排版」的内容，
 * 通过解析+重建（而非正则替换）保证不执行脚本。
 */
export function sanitizeHtml(input: string): string {
  if (!input) return "";
  // 用 template 解析：脚本不会执行、图片不会加载（未插入文档）
  const tpl = document.createElement("template");
  tpl.innerHTML = input;

  const walk = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(false);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    // 危险标签连同内容一起丢弃
    if (["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button"].includes(tag)) {
      return null;
    }

    const fragment = document.createDocumentFragment();

    if (ALLOWED_TAGS.has(tag)) {
      const out = document.createElement(tag);
      const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value;
        // 事件属性与 srcdoc 一律剥离
        if (name.startsWith("on") || name === "srcdoc") continue;
        if (!allowed.has(name)) continue;
        if ((name === "href" || name === "src") && !isSafeUrlAttr(val)) {
          out.setAttribute(name, "#");
          continue;
        }
        // 外链强制新窗口 + 防反向 tabnabbing
        if (tag === "a" && name === "target" && val === "_blank") {
          out.setAttribute("rel", "noopener noreferrer");
        }
        out.setAttribute(name, val);
      }
      for (const child of Array.from(el.childNodes)) {
        const c = walk(child);
        if (c) out.appendChild(c);
      }
      fragment.appendChild(out);
    } else {
      // 非白名单标签：保留其文本内容（用 span 承载），避免内容丢失
      const span = document.createElement("span");
      for (const child of Array.from(el.childNodes)) {
        const c = walk(child);
        if (c) span.appendChild(c);
      }
      fragment.appendChild(span);
    }
    return fragment;
  };

  const result = document.createElement("div");
  for (const child of Array.from(tpl.content.childNodes)) {
    const c = walk(child);
    if (c) result.appendChild(c);
  }
  return result.innerHTML;
}
