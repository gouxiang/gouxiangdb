// apps/web/src/features/kb/blocks.ts
// 知识库文档的"块模型"：Markdown 源码 <-> 结构化块 双向转换。
// 用于"编辑"态（所见即所得块编辑器）：块级语法（标题/列表/引用/代码/表格/任务/分割线/图片）
// 由结构化数据驱动并渲染成真实视觉元素；块内行内语法（粗/斜/删/码/高亮/链接）在
// contentEditable 中以真实 DOM 呈现，编辑后再序列化回 Markdown。
// 设计目标：md -> blocks -> md 尽量无损（不支持的高级语法以 raw 块原样透传，绝不丢内容）。

export type BlockType =
  | "p"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "ul" | "ol" | "task"
  | "quote"
  | "callout"
  | "toggle"
  | "code"
  | "hr"
  | "pagebreak"
  | "table"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "attachment"
  | "math"
  | "raw"; // 不支持/无法结构化的内容，原样透传

/** 提示块类型（GitHub Alerts） */
export type CalloutVariant = "note" | "tip" | "warning" | "important" | "caution";
export const CALLOUT_VARIANTS: CalloutVariant[] = ["note", "tip", "warning", "important", "caution"];

export interface Block {
  id: string;
  type: BlockType;
  /** 文本类块的行内 Markdown 源码（段落、标题、列表、待办、引用、提示块正文） */
  text?: string;
  /** task 勾选态 */
  checked?: boolean;
  /** code 语言 / math 无 */
  lang?: string;
  /** code 代码内容（多行） */
  code?: string;
  /** table：二维数组，第 0 行为表头（满网格，被合并覆盖的格为空串） */
  rows?: string[][];
  /** table：合并单元格。键 "r,c"（锚点/左上角格）→ { rs: 行跨, cs: 列跨 }；不进 markdown 文本，
   *  序列化时以 [[RxC]] 前缀（锚点）+ ::（被覆盖格）标记写进单元格内容 */
  spans?: Record<string, { rs: number; cs: number }>;
  /** 媒体类（image/video/audio/pdf/attachment）资源地址（可为 data: URL） */
  src?: string;
  /** image alt / pdf 标题 / 媒体说明 */
  alt?: string;
  /** attachment 文件名 */
  name?: string;
  /** callout 类型 */
  variant?: CalloutVariant;
  /** toggle 折叠块标题 */
  summary?: string;
  /** math 块公式源码 */
  formula?: string;
  /** raw 透传的原始 Markdown */
  raw?: string;
  /** 块级对齐（仅 p/h 标题/quote/callout/toggle 等文本类块生效）—— 不进 markdown 文本 */
  align?: "left" | "center" | "right" | null;
}

let _seq = 0;
export function uid(): string {
  _seq += 1;
  return `b${Date.now().toString(36)}${_seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newBlock(type: BlockType, partial: Partial<Block> = {}): Block {
  return { id: uid(), type, ...partial };
}

/* ------------------------- 行内 Markdown -> HTML（编辑/预览共用视觉） ------------------------- */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 链接 URL 安全校验：仅放行安全协议（http/https/mailto/tel）与相对路径/锚点。
 * 阻止 javascript:、data:text/html、vbscript: 等可执行协议的存储型 XSS。
 */
export function isSafeUrl(url: string): boolean {
  const u = url.trim();
  if (u === "" || u.startsWith("/") || u.startsWith("#") || u.startsWith("?")) return true;
  const proto = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (proto) {
    const scheme = proto[1]!.toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return true;
    // data: 仅放行图片（<img src> 场景）。data:text/html 等可执行/可内嵌文档类型一律拒绝，防 XSS。
    if (scheme === "data") {
      return /^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif);/i.test(u);
    }
    return false; // javascript: / vbscript: / file: / data:text-html 等
  }
  return true; // 无协议前缀，按相对路径处理
}

/** URL 不安全时降级为纯文本锚点（无 href，不可点击执行） */
function safeHref(url: string): string | null {
  return isSafeUrl(url) ? url : null;
}

/**
 * 行内 Markdown -> 可编辑 HTML。
 * 与 markdown.ts 的 inline 规则保持一致，并额外支持 ==高亮==、^上标^、~下标~、行内公式 $...$。
 * 输出的 HTML 用于 contentEditable（用户可直接在格式化结果上编辑）。
 */
export function inlineMdToHtml(src: string): string {
  const stash: string[] = [];
  const hold = (html: string) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let s = src;
  // 图片
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
    safeHref(url) !== null
      ? hold(`<img alt="${esc(alt)}" src="${esc(url)}" class="md-img" />`)
      : hold(esc(`![${alt}](${url})`)));
  // 链接（危险协议降级为纯文本，防 javascript: 存储型 XSS）
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, url) => {
    const href = safeHref(url);
    if (href === null) return hold(esc(`[${t}](${url})`));
    // 外链统一新窗口打开，内部链接（/kb /base）交给容器点击委托走 SPA 跳转
    const internal = href.startsWith("/kb") || href.startsWith("/base");
    const attrs = internal
      ? `href="${esc(href)}" class="md-link md-link-internal" data-href="${esc(href)}"`
      : `href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="md-link" data-href="${esc(href)}"`;
    return hold(`<a ${attrs}>${inlineRich(t)}</a>`);
  });
  // 成员提及 @[u:userId|显示名] → 可编辑 chip（data-user 存 id，序列化时还原协议）
  s = s.replace(/@\[u:([^|\]]+)\|([^\]]+)\]/g, (_m, id, label) =>
    hold(`<span class="md-mention" contenteditable="false" data-user="${esc(id)}">@${esc(label)}</span>`));
  // 行内代码
  s = s.replace(/`([^`]+)`/g, (_m, c) => hold(`<code class="md-code-inline">${esc(c)}</code>`));
  // 行内公式 $...$
  s = s.replace(/\$([^$\n]+)\$/g, (_m, f) =>
    hold(`<span class="md-math-inline" data-formula="${esc(f)}">${esc(f)}</span>`));
  // 行内颜色/背景色 span（htmlToInlineMd 产物）：
  // 开/闭标签各自进占位、内容留在原地——内容继续走下方 esc + 粗斜删等常规处理，
  // 因此 span 内的 **粗体** / ==高亮== 等语法也能正常渲染；
  // 开闭标签用栈配对，天然支持嵌套（连续应用文字色+背景色产生嵌套 span）。
  // 非法 style（不在白名单）只丢标签、内容降级为普通文本，防 CSS 注入。
  {
    const openStack: boolean[] = [];
    s = s.replace(/<span\s+style="([^"]*)"\s*>/g, (_m, style) => {
      const safe = sanitizeInlineStyle(style);
      openStack.push(!!safe);
      return hold(safe ? `<span style="${safe}">` : "");
    });
    s = s.replace(/<\/span>/g, () => {
      const paired = openStack.pop() ?? false;
      return hold(paired ? "</span>" : "");
    });
  }

  s = esc(s);
  // 高亮 ==x==
  s = s.replace(/==([^=\n]+)==/g, '<mark class="md-mark">$1</mark>');
  // 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // 删除线 ~~x~~
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // 斜体
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // 上标 ^x^
  s = s.replace(/\^([^^\n]+)\^/g, "<sup>$1</sup>");
  // 下标 ~x~（单波浪，排除已处理的 ~~）
  s = s.replace(/(^|[^~])~([^~\n]+)~([^~]|$)/g, "$1<sub>$2</sub>$3");

  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)] ?? "");
  // 换行
  s = s.replace(/\n/g, "<br/>");
  return s;
}

/** 链接文字等嵌套场景的简化行内（不递归占位） */
function inlineRich(text: string): string {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>');
}

/* ------------------------- 可编辑 HTML -> 行内 Markdown ------------------------- */

/**
 * 把 contentEditable 块内的 DOM 序列化回行内 Markdown。
 * 识别浏览器/execCommand 产生的 <strong>/<b>、<em>/<i>、<del>/<s>/<strike>、
 * <code>、<mark>、<sup>、<sub>、<a>、<br>、<img>。
 *
 * 行内颜色/背景色（右键菜单产物）：span[style*="color"] / span[style*="background"]
 * 不进 markdown 协议，**原样保留为 inline HTML**——markdown 兼容 raw HTML，
 * 用户在三态切换/预览/导出时样式一致。
 */
export function htmlToInlineMd(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const inner = Array.from(el.childNodes).map(walk).join("");
    switch (tag) {
      case "strong":
      case "b":
        return `**${inner}**`;
      case "em":
      case "i":
        return `*${inner}*`;
      case "del":
      case "s":
      case "strike":
        return `~~${inner}~~`;
      case "code":
        return `\`${inner.replace(/`/g, "'")}\``;
      case "mark":
        return `==${inner}==`;
      case "sup":
        return `^${inner}^`;
      case "sub":
        return `~${inner}~`;
      case "a": {
        const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
        return `[${inner}](${href})`;
      }
      case "img": {
        const src = el.getAttribute("src") || "";
        const alt = el.getAttribute("alt") || "";
        return `![${alt}](${src})`;
      }
      case "br":
        return "\n";
      case "span": {
        // 成员提及 chip：还原为 @[u:id|名]
        if (el.classList.contains("md-mention")) {
          const uid = el.getAttribute("data-user") || "";
          const label = (el.textContent ?? "").replace(/^@/, "");
          return `@[u:${uid}|${label}]`;
        }
        // 锚点粘贴 span：序列化为标准 GFM 链接 [title](href#anchor)
        // 修复 #2：保存后退化为纯文字 — 原代码落到 return inner（:256）丢 data-href/data-anchor
        if (el.classList.contains("md-anchor-pasted")) {
          const href = el.getAttribute("data-href") || "";
          const anchor = el.getAttribute("data-anchor") || "";
          if (!href) return inner;
          return `[${inner}](${href}${anchor ? `#${anchor}` : ""})`;
        }
        // 颜色/背景色：透传 style（仅允许 color / background-color 两条白名单属性，防 CSS 注入）
        const style = el.getAttribute("style");
        if (style) {
          const safe = sanitizeInlineStyle(style);
          if (safe) {
            return `<span style="${safe}">${inner}</span>`;
          }
        }
        return inner;
      }
      case "div":
      case "p":
        // contentEditable 换行常产生 <div>/<p>，转为软换行
        return (node.previousSibling ? "\n" : "") + inner;
      default:
        return inner;
    }
  };
  // 规范化：多个连续换行压缩，去掉首尾空白换行
  let md = Array.from(root.childNodes).map(walk).join("");
  md = md.replace(/\u00A0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return md;
}

/**
 * 极简 inline style sanitizer：仅放行 color 和 background-color 两条白名单属性，
 * 取值支持 #RRGGBB / #RGBA 字面量，或 Chromium CSSOM 赋值归一化产生的 rgb()/rgba()
 * （`el.style.color = "#FF4568"` 后 getAttribute 得到 `rgb(255, 69, 104)`）。
 * 全部归一化为 6 位大写 #RRGGBB 输出；其余 CSS 表达式一律拒绝。
 * 空字符串 / 其它属性 / 非法值返回 null（调用方应放弃透传）。
 */
export function sanitizeInlineStyle(style: string): string | null {
  const out: string[] = [];
  const re = /(color|background(-color)?)\s*:\s*([^;]+);?/gi;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(style)) !== null) {
    const prop = m[1]!.toLowerCase();
    const hex = cssColorToHex(m[3]!.trim());
    if (!hex) continue;
    const cssProp = prop === "background" || prop === "background-color" ? "background-color" : "color";
    out.push(`${cssProp}: ${hex}`);
    matched = true;
  }
  return matched ? out.join("; ") : null;
}

/**
 * 颜色值归一化：#hex(3/4/6/8 位) 或 rgb()/rgba()（逗号或空格分隔，可选 alpha）→ #RRGGBB。
 * 非法输入返回 null。hex 保持大写；rgb 分量超 255 拒绝。
 */
function cssColorToHex(val: string): string | null {
  const v = val.trim();
  // #hex 字面量
  const hm = /^#([0-9a-fA-F]{3,8})$/.exec(v);
  if (hm) {
    let h = hm[1]!;
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6); // 丢弃 alpha，导出一致性优先
    if (h.length !== 6) return null;
    return `#${h.toUpperCase()}`;
  }
  // rgb() / rgba()（CSSOM 归一化产物；兼容逗号与空格两种分隔）
  const rm = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})\s*(?:[,/]\s*(?:[\d.]+|%+)\s*)?\)$/i.exec(v);
  if (rm) {
    const r = Number(rm[1]!), g = Number(rm[2]!), b = Number(rm[3]!);
    if (r > 255 || g > 255 || b > 255) return null;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }
  return null;
}

/* ------------------------- 表格合并单元格（merge/split） -------------------------
 * 数据模型：rows 恒为满网格（被覆盖格为空串），spans 记录锚点的行列跨度。
 * Markdown 协议（round-trip，其他渲染器降级为普通文本表格）：
 *   锚点格内容：`[[RxC]] text`（R=行跨 C=列跨，1x1 时省略前缀）
 *   被覆盖格内容：`::`
 */

export interface TableSpan {
  rs: number;
  cs: number;
}

/** 锚点 span 前缀正则：[[2x3]] 后必须跟空格（无正文时允许只有前缀） */
const SPAN_PREFIX_RE = /^\[\[(\d+)x(\d+)\]\]\s?/;

/** 从 markdown 表格行（已 split 的单元格文本数组）解析出 spans；无合并返回 undefined */
export function parseTableSpans(rows: string[][]): Record<string, TableSpan> | undefined {
  const spans: Record<string, TableSpan> = {};
  const occupied = new Set<string>();
  const rowCount = rows.length;
  const colCount = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
  // 第一遍：识别锚点（[[RxC]] 前缀），登记其覆盖区域
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      const m = SPAN_PREFIX_RE.exec(rows[r]![c] ?? "");
      if (!m) continue;
      const rs = Math.max(1, Math.min(Number(m[1]), rowCount - r));
      const cs = Math.max(1, Math.min(Number(m[2]), colCount - c));
      if (rs === 1 && cs === 1) continue; // [[1x1]] 视为普通格
      spans[`${r},${c}`] = { rs, cs };
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          if (dr === 0 && dc === 0) continue;
          occupied.add(`${r + dr},${c + dc}`);
        }
      }
    }
  }
  if (Object.keys(spans).length === 0) return undefined;
  // 第二遍：被锚点覆盖但内容不是 :: 的格（容错：内容拼进锚点、原格置空由调用方处理不了，
  // 解析层仅做只读识别——渲染层不会输出被覆盖格，内容不会丢但不可见；序列化层会重写为 ::）
  return spans;
}

/** 锚点格内容剥掉 [[RxC]] 前缀后的正文 */
export function stripSpanPrefix(cell: string): string {
  return cell.replace(SPAN_PREFIX_RE, "");
}

/**
 * 序列化：把 spans 写回 markdown 表格行。
 * 锚点格加 [[RxC]] 前缀；被覆盖格写 ::。返回新数组（不改原 rows）。
 */
export function applyTableSpans(rows: string[][], spans?: Record<string, TableSpan>): string[][] {
  const out = rows.map((r) => [...r]);
  if (!spans) return out;
  const covered = new Set<string>();
  for (const [key, sp] of Object.entries(spans)) {
    const [r, c] = key.split(",").map(Number);
    if (r == null || c == null || Number.isNaN(r) || Number.isNaN(c)) continue;
    if (out[r] === undefined || c >= (out[r]?.length ?? 0)) continue;
    const rs = Math.max(1, sp.rs), cs = Math.max(1, sp.cs);
    for (let dr = 0; dr < rs; dr++) {
      for (let dc = 0; dc < cs; dc++) {
        if (dr === 0 && dc === 0) continue;
        covered.add(`${r + dr},${c + dc}`);
      }
    }
    const body = stripSpanPrefix(out[r]![c] ?? "").trim();
    out[r]![c] = body ? `[[${rs}x${cs}]] ${body}` : `[[${rs}x${cs}]]`;
  }
  for (const key of covered) {
    const [r, c] = key.split(",").map(Number);
    if (out[r] !== undefined && c < (out[r]?.length ?? 0)) out[r]![c] = "::";
  }
  return out;
}

export interface TableOccupancy {
  /** 每个网格位置对应的锚点坐标（"r,c"）；被覆盖格指向其锚点 */
  anchorAt: (string | null)[][];
  /** 锚点格集合（"r,c"） */
  anchors: Set<string>;
}

/** 计算占用图：渲染表格时用来决定每个 td 的 colSpan/rowSpan 与隐藏格（以 spans 元数据为准） */
export function tableOccupancy(rows: string[][], spans?: Record<string, TableSpan>): TableOccupancy {
  const rowCount = rows.length;
  const colCount = rowCount ? Math.max(...rows.map((r) => r.length)) : 0;
  const anchorAt: (string | null)[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => null),
  );
  const anchors = new Set<string>();
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      if (anchorAt[r]![c] !== null) continue; // 已被上方/左方锚点覆盖
      const key = `${r},${c}`;
      // 普通格也是它自己的锚点（占用图对每个网格位置都给出锚点坐标）
      anchorAt[r]![c] = key;
      const sp = spans?.[key];
      if (!sp) continue;
      const rs = Math.max(1, Math.min(sp.rs, rowCount - r));
      const cs = Math.max(1, Math.min(sp.cs, colCount - c));
      if (rs > 1 || cs > 1) anchors.add(key);
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < rowCount && c + dc < colCount) anchorAt[r + dr]![c + dc] = key;
        }
      }
    }
  }
  return { anchorAt, anchors };
}

/**
 * 解析后清洗：剥掉锚点格的 [[RxC]] 前缀；被覆盖格内容并进锚点后置空。
 * 保证编辑器中输入框只显示正文；返回 {rows, spans?}。
 */
export function stripTableMarks(
  rows: string[][],
  spans: Record<string, TableSpan> | undefined,
): { rows: string[][]; spans?: Record<string, TableSpan> } {
  if (!spans) return { rows: rows.map((r) => r.map((c) => stripSpanPrefix(c))) };
  const out = rows.map((r) => r.map((c) => stripSpanPrefix(c)));
  const occ = tableOccupancy(out, spans);
  for (const [key, sp] of Object.entries(spans)) {
    const [r, c] = key.split(",").map(Number);
    const rs = Math.max(1, Math.min(sp.rs, out.length - r));
    const cs = Math.max(1, Math.min(sp.cs, (out[r]?.length ?? 0) - c));
    const parts: string[] = [];
    for (let dr = 0; dr < rs; dr++) {
      for (let dc = 0; dc < cs; dc++) {
        if (dr === 0 && dc === 0) continue;
        const t = (out[r + dr]?.[c + dc] ?? "").trim();
        if (t && t !== "::") parts.push(t);
      }
    }
    if (parts.length && out[r]) {
      const own = (out[r]![c] ?? "").trim();
      out[r]![c] = [own, ...parts].filter(Boolean).join(" ");
    }
  }
  // 被覆盖格置空（内容已并入锚点）
  for (let r = 0; r < out.length; r++) {
    for (let c = 0; c < (out[r]?.length ?? 0); c++) {
      const a = occ.anchorAt[r]?.[c];
      if (a && a !== `${r},${c}`) out[r]![c] = "";
    }
  }
  return { rows: out, spans };
}

/** 插入/删除行或列时平移 spans（含跨界的锚点裁剪） */
export function shiftTableSpans(
  spans: Record<string, TableSpan> | undefined,
  axis: "row" | "col",
  index: number,
  delta: 1 | -1,
): Record<string, TableSpan> | undefined {
  if (!spans) return undefined;
  const out: Record<string, TableSpan> = {};
  for (const [key, sp] of Object.entries(spans)) {
    const [r, c] = key.split(",").map(Number);
    const pos = axis === "row" ? r : c;
    if (delta === 1) {
      // 插入：跨界锚点跨 1；位置 >= index 平移 +1
      let { rs, cs } = sp;
      if (axis === "row") {
        if (pos < index && pos + rs > index) rs += 1;
      } else {
        if (pos < index && pos + cs > index) cs += 1;
      }
      const np = pos >= index ? pos + 1 : pos;
      out[`${axis === "row" ? np : r},${axis === "row" ? c : np}`] = { rs, cs };
    } else {
      // 删除 index 行/列
      const pos = axis === "row" ? r : c;
      const extent = axis === "row" ? sp.rs : sp.cs;
      if (pos === index) {
        // 锚点本身在被删行/列：跨度减 1；锚点所在轴跨度归 0 → 锚点整体消失
        let { rs, cs } = sp;
        if (axis === "row") rs -= 1; else cs -= 1;
        if (rs > 0 && cs > 0 && (rs > 1 || cs > 1)) out[`${r},${c}`] = { rs, cs };
      } else if (pos < index && pos + extent > index) {
        // 锚点跨界覆盖被删行/列：跨度减 1
        const next = axis === "row" ? { rs: sp.rs - 1, cs: sp.cs } : { rs: sp.rs, cs: sp.cs - 1 };
        if (next.rs > 0 && next.cs > 0 && (next.rs > 1 || next.cs > 1)) out[`${r},${c}`] = next;
      } else if (pos > index) {
        out[`${axis === "row" ? r - 1 : r},${axis === "row" ? c : c - 1}`] = { ...sp };
      } else {
        // pos + extent <= index：完全在删除位上方，不受影响
        out[`${r},${c}`] = { ...sp };
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------- Markdown -> 块 ------------------------- */

// `#` 后允许无正文：blocksToMd 出口的 .trim() 会把行尾空标题 "## " 削成 "##"，
// 若此处强制要求 \s+，空标题往返一次就退化为字面 "##" 段落（CommonMark 亦视 "#" 为标题）。
const HEADING_RE = /^(#{1,6})(?:\s+(.*))?$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const IMG_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/* ---- 富文本组件（Markdown 兼容 HTML 扩展语法） ---- */
/** 从一段 HTML 标签字符串中提取属性值 */
function attr(tag: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m ? m[1]! : "";
}
const VIDEO_RE = /^<video\b[^>]*>\s*(?:<\/video>)?\s*$/i;
const AUDIO_RE = /^<audio\b[^>]*>\s*(?:<\/audio>)?\s*$/i;
const PDF_RE = /^<iframe\b[^>]*class="[^"]*kb-pdf[^"]*"[^>]*>\s*<\/iframe>\s*$/i;
const ATTACH_RE = /^<a\b[^>]*class="[^"]*kb-attach[^"]*"[^>]*>([\s\S]*?)<\/a>\s*$/i;
const PAGEBREAK_RE = /^<div\b[^>]*class="[^"]*kb-page-break[^"]*"[^>]*>\s*(?:<\/div>)?\s*$/i;
const DETAILS_OPEN_RE = /^<details\b[^>]*>\s*$/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/i;
const SUMMARY_RE = /^<summary[^>]*>([\s\S]*?)<\/summary>\s*$/i;
/** GitHub Alerts 提示块首行：> [!NOTE] / [!TIP] / [!WARNING] / [!IMPORTANT] / [!CAUTION] */
const CALLOUT_RE = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*$/i;

/** 判断一段媒体 src 的 MIME 类型（用于按类型插入 video/audio/pdf） */
export function mediaKindOf(file: File): "image" | "video" | "audio" | "pdf" | "file" {
  const t = file.type || "";
  const name = file.name.toLowerCase();
  if (t.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(name)) return "image";
  if (t.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(name)) return "video";
  if (t.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(name)) return "audio";
  if (t === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  return "file";
}

export function mdToBlocks(src: string): Block[] {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  // E-1：对齐标记 <!-- align:center|right -->（blocksToMd 产出）作用于紧邻的下一块
  const ALIGN_RE = /^<!--\s*align:(center|right)\s*-->$/;
  let pendingAlign: "center" | "right" | null = null;
  const pushBlock = (blk: Block) => {
    if (pendingAlign) {
      blk.align = pendingAlign;
      pendingAlign = null;
    }
    blocks.push(blk);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // 对齐标记行：记录后跳过
    const alignHit = ALIGN_RE.exec(line.trim());
    if (alignHit) {
      pendingAlign = alignHit[1] as "center" | "right";
      i++;
      continue;
    }

    // 代码块
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束 ```
      pushBlock(newBlock("code", { lang: lang || "", code: buf.join("\n") }));
      continue;
    }

    // 数学块 $$ ... $$
    if (line.trimStart().startsWith("$$")) {
      // 单行 $$...$$ 或多行
      const rest = line.trim().slice(2);
      if (rest.endsWith("$$") && rest.length > 2) {
        pushBlock(newBlock("math", { formula: rest.slice(0, -2).trim() }));
        i++;
        continue;
      }
      const buf: string[] = rest ? [rest] : [];
      i++;
      while (i < lines.length && !lines[i]!.trim().endsWith("$$")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束 $$
      pushBlock(newBlock("math", { formula: buf.join("\n").trim() }));
      continue;
    }

    // 分割线
    if (HR_RE.test(line)) {
      pushBlock(newBlock("hr"));
      i++;
      continue;
    }

    // 分页符 <div class="kb-page-break">
    if (PAGEBREAK_RE.test(line.trim())) {
      pushBlock(newBlock("pagebreak"));
      i++;
      continue;
    }

    // 视频 <video src="..." controls></video>
    if (VIDEO_RE.test(line.trim())) {
      const tag = line.trim();
      pushBlock(newBlock("video", { src: attr(tag, "src"), alt: attr(tag, "title") || attr(tag, "alt") }));
      i++;
      continue;
    }

    // 音频 <audio src="..." controls></audio>
    if (AUDIO_RE.test(line.trim())) {
      const tag = line.trim();
      pushBlock(newBlock("audio", { src: attr(tag, "src"), alt: attr(tag, "title") || attr(tag, "alt") }));
      i++;
      continue;
    }

    // PDF <iframe class="kb-pdf" src="..."></iframe>
    if (PDF_RE.test(line.trim())) {
      const tag = line.trim();
      pushBlock(newBlock("pdf", { src: attr(tag, "src"), alt: attr(tag, "title") || "PDF 文档" }));
      i++;
      continue;
    }

    // 附件 <a class="kb-attach" href="..." download>文件名</a>
    {
      const att = ATTACH_RE.exec(line.trim());
      if (att) {
        const tag = line.trim().slice(0, line.trim().indexOf(">") + 1);
        const href = attr(tag, "href");
        const name = att[1]!.trim() || attr(tag, "download") || "附件";
        pushBlock(newBlock("attachment", { src: href, name }));
        i++;
        continue;
      }
    }

    // 折叠块 <details><summary>标题</summary> ... </details>
    // 支持 <details> 单独成行，或 <details><summary>..</summary> 同行，甚至单行完整写法
    if (/^<details\b/i.test(line.trim())) {
      const openTag = line.trim();
      let summary = "折叠块";
      let inlineRest = openTag.replace(/^<details\b[^>]*>/i, "");
      const buf: string[] = [];
      // 同行可能：<summary>..</summary> ... </details>
      const inlineSummary = SUMMARY_RE.exec(inlineRest);
      let closedOnOpenLine = false;
      if (inlineSummary) {
        summary = inlineSummary[1]!;
        inlineRest = inlineRest.replace(SUMMARY_RE, "");
      }
      if (/<\/details>/i.test(inlineRest)) {
        const beforeClose = inlineRest.split(/<\/details>/i)[0] ?? "";
        if (beforeClose.trim()) buf.push(beforeClose.trim());
        closedOnOpenLine = true;
      }
      let j = i + 1;
      if (!inlineSummary && !closedOnOpenLine && j < lines.length && SUMMARY_RE.test(lines[j]!.trim())) {
        summary = SUMMARY_RE.exec(lines[j]!.trim())![1]!;
        j++;
      }
      while (!closedOnOpenLine && j < lines.length) {
        const cur = lines[j]!;
        if (/<\/details>/i.test(cur)) {
          const before = cur.split(/<\/details>/i)[0] ?? "";
          if (before.trim()) buf.push(before.trim());
          break;
        }
        buf.push(cur);
        j++;
      }
      j = closedOnOpenLine ? i + 1 : j + 1; // 跳过 </details> 所在行
      pushBlock(newBlock("toggle", { summary, text: buf.join("\n").trim() }));
      i = j;
      continue;
    }

    // 标题
    const h = HEADING_RE.exec(line);
    if (h) {
      pushBlock(newBlock(`h${h[1]!.length}` as BlockType, { text: h[2] ?? "" }));
      i++;
      continue;
    }

    // 图片独占一行
    const img = IMG_LINE_RE.exec(line);
    if (img) {
      pushBlock(newBlock("image", { alt: img[1]!, src: img[2]! }));
      i++;
      continue;
    }

    // 表格
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      const splitRow = (r: string): string[] => {
        let t = r.trim();
        if (t.startsWith("|")) t = t.slice(1);
        if (t.endsWith("|")) t = t.slice(0, -1);
        return t.split("|").map((c) => c.trim());
      };
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [header];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      // 合并单元格协议：[[RxC]] 锚点前缀 + :: 被覆盖标记 → spans 元数据 + 清洗后的 rows
      const parsed = stripTableMarks(rows, parseTableSpans(rows));
      pushBlock(newBlock("table", { rows: parsed.rows, spans: parsed.spans }));
      continue;
    }

    // 提示块（GitHub Alerts）：> [!NOTE] / > [!TIP] / > [!WARNING] / > [!IMPORTANT] / > [!CAUTION]
    if (QUOTE_RE.test(line)) {
      const first = line.replace(QUOTE_RE, "$1").trim();
      const cm = CALLOUT_RE.exec(first);
      if (cm) {
        const variant = cm[1]!.toLowerCase() as CalloutVariant;
        const buf: string[] = [];
        let k = i + 1;
        // 跳过可能的空 "> " 行，收集后续引用正文
        while (k < lines.length && QUOTE_RE.test(lines[k]!)) {
          const t = lines[k]!.replace(QUOTE_RE, "$1");
          buf.push(t);
          k++;
        }
        pushBlock(newBlock("callout", { variant, text: buf.join("\n").trim() }));
        i = k;
        continue;
      }
    }

    // 引用（连续 > 行合并为一个 quote 块，内部软换行）
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        buf.push(lines[i]!.replace(QUOTE_RE, "$1"));
        i++;
      }
      pushBlock(newBlock("quote", { text: buf.join("\n") }));
      continue;
    }

    // 列表项（每行一个块，相邻同类型在渲染时连体）
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const content = ul ? ul[2]! : ol![3]!;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      if (task) {
        pushBlock(newBlock("task", { checked: task[1]!.toLowerCase() === "x", text: task[2]! }));
      } else if (ol) {
        pushBlock(newBlock("ol", { text: content }));
      } else {
        pushBlock(newBlock("ul", { text: content }));
      }
      i++;
      continue;
    }

    // 空行
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 普通段落：合并连续普通行
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !HEADING_RE.test(lines[i]!) &&
      !UL_RE.test(lines[i]!) &&
      !OL_RE.test(lines[i]!) &&
      !QUOTE_RE.test(lines[i]!) &&
      !HR_RE.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith("```") &&
      !lines[i]!.trimStart().startsWith("$$") &&
      !IMG_LINE_RE.test(lines[i]!) &&
      !ALIGN_RE.test(lines[i]!.trim()) &&
      !isComponentLine(lines[i]!) &&
      !(lines[i]!.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!))
    ) {
      buf.push(lines[i]!);
      i++;
    }
    pushBlock(newBlock("p", { text: buf.join("\n") }));
  }

  if (blocks.length === 0) pushBlock(newBlock("p", { text: "" }));
  return blocks;
}

/** 判断某一行是否为结构化富文本组件（媒体/分页/折叠），段落合并不应吞掉这些行 */
function isComponentLine(l: string): boolean {
  const t = l.trim();
  return (
    PAGEBREAK_RE.test(t) ||
    VIDEO_RE.test(t) ||
    AUDIO_RE.test(t) ||
    PDF_RE.test(t) ||
    ATTACH_RE.test(t) ||
    DETAILS_OPEN_RE.test(t) ||
    DETAILS_CLOSE_RE.test(t) ||
    SUMMARY_RE.test(t)
  );
}

/* ------------------------- 块 -> Markdown ------------------------- */

const isListLike = (t: BlockType) => t === "ul" || t === "ol" || t === "task";

export function blocksToMd(blocks: Block[]): string {
  const out: string[] = [];
  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx]!;
    const prev = blocks[idx - 1];
    const gap = () => {
      // 列表/任务/引用相邻不额外空行；其余块之间空一行
      if (out.length === 0) return;
      if (out[out.length - 1] === "") return;
      out.push("");
    };
    // E-1：块对齐持久化——align（center/right）序列化为紧邻内容前的注释标记行，
    // mdToBlocks/renderMarkdown 双端识别还原；left/ null 不写（默认值）。
    const pushAlign = () => {
      if (b.align && b.align !== "left") out.push(`<!-- align:${b.align} -->`);
    };

    switch (b.type) {
      case "p":
        gap();
        pushAlign();
        out.push((b.text ?? "").trim());
        break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        gap();
        pushAlign();
        const level = Number(b.type[1]);
        out.push(`${"#".repeat(level)} ${(b.text ?? "").trim()}`);
        break;
      }
      case "ul":
        // 列表项之间不空行；与非列表块之间空行
        if (prev && !isListLike(prev.type)) gap();
        pushAlign();
        out.push(`- ${(b.text ?? "").trim()}`);
        break;
      case "ol":
        if (prev && !isListLike(prev.type)) gap();
        pushAlign();
        // 有序号：连续 ol 从 1 递增
        let n = 1;
        for (let k = idx - 1; k >= 0 && blocks[k]!.type === "ol"; k--) n++;
        out.push(`${n}. ${(b.text ?? "").trim()}`);
        break;
      case "task":
        if (prev && !isListLike(prev.type)) gap();
        pushAlign();
        out.push(`- [${b.checked ? "x" : " "}] ${(b.text ?? "").trim()}`);
        break;
      case "quote":
        gap();
        pushAlign();
        out.push((b.text ?? "").split("\n").map((l) => `> ${l}`).join("\n"));
        break;
      case "callout": {
        gap();
        pushAlign();
        const variant = (b.variant ?? "note").toUpperCase();
        const body = (b.text ?? "").trim();
        const lines = body ? body.split("\n") : [""];
        out.push(`> [!${variant}]`);
        for (const l of lines) out.push(`> ${l}`);
        break;
      }
      case "toggle": {
        gap();
        out.push("<details>");
        out.push(`<summary>${b.summary ?? "折叠块"}</summary>`);
        const body = (b.text ?? "").trim();
        if (body) {
          out.push("");
          out.push(body);
        }
        out.push("");
        out.push("</details>");
        break;
      }
      case "pagebreak":
        gap();
        out.push('<div class="kb-page-break"></div>');
        break;
      case "code":
        gap();
        out.push("```" + (b.lang ?? ""));
        out.push(b.code ?? "");
        out.push("```");
        break;
      case "math":
        gap();
        out.push("$$");
        out.push(b.formula ?? "");
        out.push("$$");
        break;
      case "hr":
        gap();
        out.push("---");
        break;
      case "table": {
        gap();
        const rows = b.rows ?? [];
        if (rows.length === 0) break;
        // 序列化前把 spans 写回 markdown 标记（[[RxC]] 前缀 + :: 被覆盖格）
        const out2 = applyTableSpans(rows, b.spans);
        const cols = Math.max(...out2.map((r) => r.length));
        const norm = out2.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? ""));
        out.push("| " + norm[0]!.join(" | ") + " |");
        out.push("| " + norm[0]!.map(() => "---").join(" | ") + " |");
        for (let r = 1; r < norm.length; r++) {
          out.push("| " + norm[r]!.join(" | ") + " |");
        }
        break;
      }
      case "image":
        gap();
        out.push(`![${b.alt ?? ""}](${b.src ?? ""})`);
        break;
      case "video":
        gap();
        out.push(`<video src="${b.src ?? ""}" controls preload="metadata"${b.alt ? ` title="${b.alt}"` : ""}></video>`);
        break;
      case "audio":
        gap();
        out.push(`<audio src="${b.src ?? ""}" controls preload="metadata"${b.alt ? ` title="${b.alt}"` : ""}></audio>`);
        break;
      case "pdf":
        gap();
        out.push(`<iframe class="kb-pdf" src="${b.src ?? ""}" title="${b.alt ?? "PDF 文档"}"></iframe>`);
        break;
      case "attachment":
        gap();
        out.push(`<a class="kb-attach" href="${b.src ?? ""}" download>${b.name ?? "附件"}</a>`);
        break;
      case "raw":
        gap();
        out.push(b.raw ?? "");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
