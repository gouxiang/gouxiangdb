// packages/blocks/src/inlineOffsets.ts
// 行内 Markdown 源码 ↔ 渲染 HTML 的偏移映射（DESIGN §13 末 + §12-A14「做，不降级」）。
//
// 背景：知识库块正文存的是**行内 Markdown 源码**（`**粗**`、`[链接](url)`、`@[u:id|名]`、
// `<span style="color:#F00">`…），而 contentEditable 里呈现的是 blocks.ts:115 inlineMdToHtml
// 渲染后的 HTML。两者偏移不一致 —— 协同层要把「远端改了源码第 37 个字符」换算成
// 「DOM 上第 N 个偏移」，就必须有这张映射表。
//
// 硬约束：html 必须与 inlineMdToHtml(src) **逐字节相同**（渲染结果已是全站唯一真源）。
// 因此这里不去改 inlineMdToHtml（改它可能破坏现有渲染，收益不抵风险），而是写一个
// **并行的带标注实现**：把它的每一步（hold 占位符栈、esc、各条正则）都做在同一个
// 「带源码下标标注的字符串」（TagStr）上，最后按标注累加出偏移表。
//
// 要点（全文件统一的一条规则）：标注语义：输出的每个字符记一个源码下标 tag，含义是
//   「算到源码第 tag+1 个位置时，该字符已经出现」。于是
//       srcToHtml[i] = 标注 < i 的字符数
//   各类输出按此规则派生：
//     · 正文字符：tag = 它自己的源码下标（逐个标注）；
//     · 包裹正文的语法标记（`**` 开 / 闭、`<a ...>` / `</a>`、`<strong>` / `</strong>`…）：
//       开标签标「紧挨其前的最后一个源码字符」，闭标签标「标记区间的最后一个源码字符」。
//       以 `ab**cd**ef` 为例（`<strong>` 标 3、`</strong>` 标 7）：
//         源码 0/1/2/3 → `<strong>` 之前；4（c 之前）→ `<strong>` 之后（打进去的字带格式）；
//         5/6/7 → 仍在 `</strong>` 之前（续打仍是同一格式）；8（越过整个闭标记）→ 之后。
//     · 原子对象（图片 / 提及 chip / `<span style>` 开闭标签）：整段渲染物挂到
//       「该匹配最后一个源码字符」，因此源码落在对象内部一律指向对象**之前**
//       （光标不会停进不可编辑对象里），越过末尾才落到对象**之后**。
//   由此，「光标停在语法标记内部 / 边上」这类退化情况都有确定落点：标记所占的每个源码位置
//   各自落到一个真实 HTML 位置，不会越界、不会指向不存在的位置。
// 边界：srcToHtml 长度恒为 src.length + 1，srcToHtml[0] === 0，
// srcToHtml[src.length] === html.length（全部源码内容渲染完的位置）。

import { isSafeUrl, sanitizeInlineStyle } from "./blocks";

/** 带源码下标标注的字符串：text[i] 的源码下标是 tag[i]，两者等长 */
interface TagStr {
  text: string;
  tag: number[];
}

export interface InlineOffsets {
  /** 与 inlineMdToHtml(src) 逐字节相同的 HTML */
  html: string;
  /** 长度 src.length + 1；srcToHtml[i] = 源码第 i 个字符之前 对应的 HTML 位置 */
  srcToHtml: number[];
}

/* ---------------- TagStr 基本操作 ---------------- */

/** 取 current string 位置 i 对应的源下标；越界时夹到最近的有效下标（input 为空返回 0） */
function tagAt(t: TagStr, i: number): number {
  if (t.tag.length === 0) return 0;
  if (i < 0) return t.tag[0]!;
  if (i >= t.tag.length) return t.tag[t.tag.length - 1]!;
  return t.tag[i]!;
}

function sliceT(t: TagStr, start: number, end: number): TagStr {
  return { text: t.text.slice(start, end), tag: t.tag.slice(start, end) };
}

/** 构造一串标注统一为 tag 的字符（语法标记 / 纯样式 / 占位符） */
function lit(text: string, tag: number): TagStr {
  const tag$ = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) tag$[i] = tag;
  return { text, tag: tag$ };
}

function concatT(parts: TagStr[]): TagStr {
  let text = "";
  let n = 0;
  for (const p of parts) n += p.tag.length;
  const tag = new Array<number>(n);
  let k = 0;
  for (const p of parts) {
    text += p.text;
    for (const v of p.tag) tag[k++] = v;
  }
  return { text, tag };
}

/** 与 blocks.ts 的 esc 同语义（注意：单引号不属于逃逸集） */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 逐字符逃逸：每个字符独立映射，标注跟随该字符。
 * 与「整串 esc」等价 —— esc 的四条替换互不产生对方的逃逸字符，故无顺序耦合。
 */
function escT(t: TagStr): TagStr {
  const parts: TagStr[] = [];
  const table: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  for (let i = 0; i < t.text.length; i++) {
    const rep = table[t.text[i]!];
    parts.push(rep === undefined ? sliceT(t, i, i + 1) : lit(rep, t.tag[i]!));
  }
  return concatT(parts);
}

/**
 * 语义等价于 String.prototype.replace(re, build)：在 t.text 上顺序匹配、不回扫替换结果。
 * 每处匹配的渲染结果由 build 依据「当前原文 t」与「匹配 m」自行拼装。
 */
function replaceT(t: TagStr, re: RegExp, build: (m: RegExpExecArray, from: TagStr) => TagStr): TagStr {
  const parts: TagStr[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(t.text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    parts.push(sliceT(t, last, m.index));
    parts.push(build(m, t));
    last = m.index + m[0].length;
  }
  parts.push(sliceT(t, last, t.text.length));
  return concatT(parts);
}

/** 捕获组 k 在 from.text 上的区间 [start, end)（依赖 /d 标志给出的 indices） */
function groupRange(m: RegExpExecArray, k: number): [number, number] {
  const g = m.indices![k]!;
  return [g[0]!, g[1]!];
}

/** 用 open/close 标签包裹第 1 组内容：开标签标「内容首字符前一位」、闭标签标「匹配末字符」 */
function wrapG1(m: RegExpExecArray, from: TagStr, open: string, close: string): TagStr {
  const [cs, ce] = groupRange(m, 1);
  return concatT([
    lit(open, tagAt(from, cs - 1)),
    sliceT(from, cs, ce),
    lit(close, tagAt(from, m.index + m[0].length - 1)),
  ]);
}

/** 链接文字等嵌套场景的简化行内（对应 blocks.ts 的 inlineRich：esc + 粗 + 码，不递归占位） */
function inlineRichT(content: TagStr): TagStr {
  let c = escT(content);
  c = replaceT(c, /\*\*([^*]+)\*\*/gd, (m, from) => wrapG1(m, from, "<strong>", "</strong>"));
  c = replaceT(c, /`([^`]+)`/gd, (m, from) =>
    wrapG1(m, from, '<code class="md-code-inline">', "</code>"));
  return c;
}

/* ---------------- 主流程：inlineMdToHtml 的带标注并行实现 ---------------- */

export function inlineMdToHtmlWithOffsets(src: string): InlineOffsets {
  const stash: TagStr[] = [];
  /**
   * 与原实现的 hold 同形：把渲染物暂存为 \u0000<index>\u0000 占位符。
   * 占位符本身的标注先统一取「匹配最后一个源码字符」（真正展开时会被 stash 内的标注取代）。
   */
  const hold = (piece: TagStr, lastTag: number): TagStr => {
    stash.push(piece);
    return lit(`\u0000${stash.length - 1}\u0000`, lastTag);
  };

  let t: TagStr = { text: src, tag: Array.from(src, (_c, i) => i) };

  // 图片
  t = replaceT(t, /!\[([^\]]*)\]\(([^)\s]+)\)/gd, (m, from) => {
    const alt = m[1]!;
    const url = m[2]!;
    const last = tagAt(from, m.index + m[0].length - 1);
    const html = isSafeUrl(url)
      ? `<img alt="${esc(alt)}" src="${esc(url)}" class="md-img" />`
      : esc(`![${alt}](${url})`);
    return hold(lit(html, last), last);
  });
  // 链接（危险协议降级为纯文本，防 javascript: 存储型 XSS）
  t = replaceT(t, /\[([^\]]+)\]\(([^)\s]+)\)/gd, (m, from) => {
    const label = m[1]!;
    const url = m[2]!;
    const last = tagAt(from, m.index + m[0].length - 1);
    if (!isSafeUrl(url)) return hold(lit(esc(`[${label}](${url})`), last), last);
    // 外链统一新窗口打开，内部链接（/kb /base）交给容器点击委托走 SPA 跳转
    const internal = url.startsWith("/kb") || url.startsWith("/base");
    const attrs = internal
      ? `href="${esc(url)}" class="md-link md-link-internal" data-href="${esc(url)}"`
      : `href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="md-link" data-href="${esc(url)}"`;
    const [cs, ce] = groupRange(m, 1);
    return hold(
      concatT([lit(`<a ${attrs}>`, tagAt(from, cs - 1)), inlineRichT(sliceT(from, cs, ce)), lit("</a>", last)]),
      last,
    );
  });
  // 成员提及 @[u:userId|显示名] → 可编辑 chip（整块原子：contenteditable="false"）
  t = replaceT(t, /@\[u:([^|\]]+)\|([^\]]+)\]/gd, (m, from) => {
    const id = m[1]!;
    const label = m[2]!;
    const last = tagAt(from, m.index + m[0].length - 1);
    const html =
      `<span class="md-mention" contenteditable="false" data-user="${esc(id)}">@${esc(label)}</span>`;
    return hold(lit(html, last), last);
  });
  // 行内代码
  t = replaceT(t, /`([^`]+)`/gd, (m, from) => {
    const [cs, ce] = groupRange(m, 1);
    const last = tagAt(from, m.index + m[0].length - 1);
    return hold(
      concatT([lit('<code class="md-code-inline">', tagAt(from, cs - 1)), escT(sliceT(from, cs, ce)), lit("</code>", last)]),
      last,
    );
  });
  // 行内公式 $...$
  t = replaceT(t, /\$([^$\n]+)\$/gd, (m, from) => {
    const f = m[1]!;
    const [cs, ce] = groupRange(m, 1);
    const last = tagAt(from, m.index + m[0].length - 1);
    return hold(
      concatT([
        lit(`<span class="md-math-inline" data-formula="${esc(f)}">`, tagAt(from, cs - 1)),
        escT(sliceT(from, cs, ce)),
        lit("</span>", last),
      ]),
      last,
    );
  });
  // 行内颜色/背景色 span（htmlToInlineMd 产物）：开闭标签各自进占位、内容留在原地，
  // 用栈配对以支持嵌套；非法 style 只丢标签、内容降级为普通文本，防 CSS 注入。
  {
    const openStack: boolean[] = [];
    t = replaceT(t, /<span\s+style="([^"]*)"\s*>/gd, (m, from) => {
      const safe = sanitizeInlineStyle(m[1]!);
      openStack.push(!!safe);
      const last = tagAt(from, m.index + m[0].length - 1);
      return hold(lit(safe ? `<span style="${safe}">` : "", last), last);
    });
    t = replaceT(t, /<\/span>/gd, (m, from) => {
      const paired = openStack.pop() ?? false;
      const last = tagAt(from, m.index + m[0].length - 1);
      return hold(lit(paired ? "</span>" : "", last), last);
    });
  }

  t = escT(t);

  // 以下渲染均作用于逃逸后的文本，顺序与 blocks.ts 完全一致
  t = replaceT(t, /==([^=\n]+)==/gd, (m, from) => wrapG1(m, from, '<mark class="md-mark">', "</mark>"));
  t = replaceT(t, /\*\*([^*]+)\*\*/gd, (m, from) => wrapG1(m, from, "<strong>", "</strong>"));
  t = replaceT(t, /__([^_]+)__/gd, (m, from) => wrapG1(m, from, "<strong>", "</strong>"));
  t = replaceT(t, /~~([^~]+)~~/gd, (m, from) => wrapG1(m, from, "<del>", "</del>"));
  t = replaceT(t, /\*([^*\n]+)\*/gd, (m, from) => wrapG1(m, from, "<em>", "</em>"));
  t = replaceT(t, /\^([^^\n]+)\^/gd, (m, from) => wrapG1(m, from, "<sup>", "</sup>"));
  // 下标 ~x~（单波浪；首尾各捕获一个定界字符，该字符要保持自己的标注）
  t = replaceT(t, /(^|[^~])~([^~\n]+)~([^~]|$)/gd, (m, from) => {
    const [ps, pe] = groupRange(m, 1);
    const [cs, ce] = groupRange(m, 2);
    const [qs, qe] = groupRange(m, 3);
    return concatT([
      sliceT(from, ps, pe),
      lit("<sub>", tagAt(from, cs - 1)),
      sliceT(from, cs, ce),
      lit("</sub>", tagAt(from, m.index + m[0].length - 1)),
      sliceT(from, qs, qe),
    ]);
  });

  // 占位符还原（与原实现一致：不回扫替换结果，故嵌套占位符会以字面形式留下，属既有行为）
  t = replaceT(t, /\u0000(\d+)\u0000/gd, (m) => stash[Number(m[1]!)] ?? lit("", 0));
  // 换行
  t = replaceT(t, /\n/gd, (m, from) => lit("<br/>", tagAt(from, m.index)));

  return { html: t.text, srcToHtml: buildMap(t.tag, src.length) };
}

/** 由每个 HTML 字符的标注累加出 srcToHtml[i] = 标注 < i 的字符数 */
function buildMap(tag: number[], srcLen: number): number[] {
  // 按 (tag + 1) 分桶；tag < 0 或 >= srcLen 的异常标注分别归入首尾桶，保证总长守恒
  const buckets = new Array<number>(srcLen + 2).fill(0);
  for (const k of tag) buckets[Math.min(Math.max(k + 1, 0), srcLen + 1)] += 1;
  const out = new Array<number>(srcLen + 1);
  let acc = 0;
  for (let i = 0; i <= srcLen; i++) {
    acc += buckets[i]!;
    out[i] = acc;
  }
  return out;
}

/**
 * 反向查询：给定 HTML 位置，返回落在它之内（紧邻其后）的源码偏移。
 * srcToHtml 单调不减，故二分即可；htmlPos 在 [0, html.length] 之间取值才有意义，
 * 越界时夹到最近的源码端点。
 */
export function htmlToSrcAt(offsets: InlineOffsets, htmlPos: number): number {
  const a = offsets.srcToHtml;
  if (a.length === 0) return 0;
  if (htmlPos >= a[a.length - 1]!) return a.length - 1;
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! <= htmlPos) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, hi);
}
