// apps/web/src/features/collab/block-cursor-locator.ts
// 协同光标的坐标换算：远端给的是「块 id + 行内 Markdown **源码** offset」，要画到屏幕上
// 必须换算成 contentEditable 里某个文本节点内的偏移（DESIGN.md §13 第 3 条与 §12-A14）。
//
// 换算链路（每一步都对应下面的一个函数）：
//   src + srcOffset
//     → srcToHtml[.]  → **HTML 字符串**里的位置（inlineMdToHtmlWithOffsets）
//     → htmlPosToTextPos(.) → **可见文本**里的位置（剥掉标签与实体）
//     → locateInSegments(.) → 第几个文本节点 / 节点内第几个字（TreeWalker 得到的段）
//     → Range.setStart + getBoundingClientRect → 屏幕坐标
//
// 只有最后两步（textNodesOf / measureCaretAt）真正依赖 DOM，其余全部是纯函数 ——
// 本仓 vitest 跑在 node 环境且没有 jsdom，把它们抽成纯函数换来的正是**可测性**：
// 「光标停在 `**` 这类格式标记边上」是这个链路最容易错的地方，必须锁死。
//
// 为什么必须走 src 而不是直接用 DOM：块正文存的是带格式标记的原文（`**粗**`、`[链接](url)`、
// `@[u:id|名]`），屏幕上却是格式化后的样子，两者位置对不上（这是 §13 明确列出的唯一投入点）。

import { inlineMdToHtmlWithOffsets, type InlineOffsets } from "@gx/blocks";

export interface TextSegment {
  text: string;
}

export interface SegmentHit {
  index: number;
  innerOffset: number;
}

/** 源码→偏移映射的 memo 上限；防止长会话里 Map 无限增长（Map 保插入序，删最老的即近似 LRU）。 */
export const OFFSET_CACHE_MAX = 256;

const cache = new Map<string, InlineOffsets>();

/**
 * 远端每次改动都会重算一次映射，而同一份源码在短时间内会被反复计算（多个 peer 的光标、
 * 250ms 轮询的每个 tick 都会命中同一批块），故做 memo。
 */
function offsetsOf(src: string): InlineOffsets {
  const hit = cache.get(src);
  if (hit) return hit;
  const made = inlineMdToHtmlWithOffsets(src);
  cache.set(src, made);
  if (cache.size > OFFSET_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return made;
}

/**
 * 源码 offset → 该块**可见文本**中的位置（= TreeWalker 按序拼接文本节点得到的坐标系）。
 * 越界的 srcOffset 一律夹到 [0, src.length]，保证永不返回越界位置。
 */
export function planSrcOffset(src: string, srcOffset: number): number {
  const offsets = offsetsOf(src);
  const clamped = Number.isFinite(srcOffset)
    ? Math.min(Math.max(Math.trunc(srcOffset), 0), src.length)
    : 0;
  const htmlPos = offsets.srcToHtml[clamped] ?? offsets.srcToHtml[offsets.srcToHtml.length - 1] ?? 0;
  return htmlPosToTextPos(offsets.html, htmlPos);
}

/**
 * HTML 字符串位置 → 可见文本位置。
 *
 * 两个坑：
 *   1. 属性值里可能含 `>`（如 `<span class="md-math-inline" data-formula="a>b">`），
 *      朴素地找 `>` 会提前结束标签，所以进入 `<` 后要跟踪引号。
 *   2. 实体 `&amp;` `&lt;` `&#39;` 在 HTML 里是好几个字符，在浏览器 DOM 里只是 1 个字符。
 *
 * 越界的 htmlPos 夹到 [0, 可见长度]。
 */
export function htmlPosToTextPos(html: string, htmlPos: number): number {
  const clamped = Math.min(Math.max(Math.trunc(htmlPos), 0), html.length);
  let textLen = 0;
  let i = 0;
  while (i < clamped) {
    const ch = html[i]!;
    if (ch === "&") {
      const semi = html.indexOf(";", i);
      // 实体最长按 8 字符处理即可覆盖 &#x27; / &quot; 这类；超长就当普通字符
      if (semi > i && semi - i <= 8) {
        textLen += 1;
        i = semi + 1;
        continue;
      }
      textLen += 1;
      i += 1;
      continue;
    }
    if (ch === "<") {
      i = skipTag(html, i);
      continue;
    }
    textLen += 1;
    i += 1;
  }
  return textLen;
}

/** 从 `<` 起跳过整个标签，返回标签结束后的下标。会跳过引号内的 `>`。 */
function skipTag(html: string, start: number): number {
  let i = start + 1;
  let quote: string | null = null;
  while (i < html.length) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * 在若干文本段里找第 textPos 个可见字符落在哪一段的哪个位置。
 *
 * 约定（与浏览器 caret 行为对齐）：textPos 落在某段**内部** → 落在该段；
 * 恰好落在两段边界上 → 取**后一段的开头**（因此这里用严格小于做判定），好处有二：
 *   ① `Range.setStart(node, 0)` 永远合法，不必担心某段长度为 0 的退化情形；
 *   ② 插入符在边界上时属性属于它右侧的文本，落点语义与用户预期一致。
 * textPos === 总长度（文末）时已无后一段可取，落在最后一段末尾。
 * segments 为空（块确实没有文本）→ null，调用方据此跳过该光标。
 */
export function locateInSegments(
  segments: readonly TextSegment[],
  textPos: number,
): SegmentHit | null {
  if (segments.length === 0) return null;
  let acc = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const len = segments[index]!.text.length;
    if (textPos < acc + len) return { index, innerOffset: textPos - acc };
    acc += len;
  }
  const last = segments.length - 1;
  return { index: last, innerOffset: segments[last]!.text.length };
}

/**
 * DOM 专用（无 jsdom，测不了）：收集 root 下的文本节点。
 * 必须跳过 `contenteditable="false"` 的原子节点内部（@提及 chip、图片、行内公式），
 * 它们的文本不属于可编辑正文，光标停进去既画不出来也没有意义。
 */
export function textNodesOf(root: Node): Text[] {
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    let keep = true;
    const parent = node.parentElement;
    if (parent && parent.closest('[contenteditable="false"]')) keep = false;
    if (keep) out.push(node as Text);
    node = walker.nextNode();
  }
  return out;
}

/**
 * DOM 专用（测不了）：定位某块某源码偏移处的插入符，返回**视口坐标**。
 * 找不到块、块里没有文本、或文本节点已被远端热补换掉 → 返回 null（调用方跳过该光标，宁缺勿错）。
 */
export function measureCaretAt(
  container: HTMLElement,
  blockId: string,
  src: string,
  srcOffset: number,
): { left: number; top: number; height: number } | null {
  const editable = container.querySelector(`[data-editable="${cssEscape(blockId)}"]`);
  if (!editable) return null;
  const nodes = textNodesOf(editable);
  if (nodes.length === 0) return null;
  const hit = locateInSegments(
    nodes.map((n) => ({ text: n.data })),
    planSrcOffset(src, srcOffset),
  );
  if (!hit) return null;
  const target = nodes[hit.index];
  if (!target) return null;
  const doc = target.ownerDocument;
  const range = doc.createRange();
  const inner = Math.min(hit.innerOffset, target.data.length);
  range.setStart(target, inner);
  range.setEnd(target, inner);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0)) {
    // 折叠 Range 在部分浏览器/空行上取不到矩形：退回宿主元素自身的位置
    const host = (target.parentElement ?? editable) as HTMLElement;
    const hostRect = host.getBoundingClientRect();
    return { left: hostRect.left, top: hostRect.top, height: hostRect.height };
  }
  return { left: rect.left, top: rect.top, height: rect.height || editable.getBoundingClientRect().height };
}

/** 块 id 可能含引号/反斜杠，进属性选择器前必须转义。SSR（无 CSS 对象）下退化处理，保持不崩。 */
export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
