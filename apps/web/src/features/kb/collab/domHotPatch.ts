// apps/web/src/features/kb/collab/domHotPatch.ts
// 远端文本补丁 → 编辑器 DOM 的**最小热补**（DESIGN §13 约束①：绝不整块重写 innerHTML，
// 否则光标乱跳、中文输入法中断）。
//
// 坐标换算复用 features/collab/block-cursor-locator.ts（planSrcOffset / locateInSegments /
// textNodesOf）—— 那边已经把「行内 Markdown 源码 offset ↔ 可见文本 offset」锁死并单测过，
// 这里不重复实现。本文件只多两件小事：
//   ① nextCaretOffset —— 光标位移（纯函数，可单测）
//   ② applyPatchesToDom —— Range 删除 + 就地插入 + 光标复位（DOM，仓库无 jsdom，测不了）
//
// 安全边界：一旦「DOM 可见文本」与「源码渲染后的可见文本」对不上（例如补丁正好砍在 `**`
// 这类格式标记中间），**不猜**，返回 false 由调用方回落到整块重写 —— 宁可重写一次，
// 也不把内容写歪。

import { inlineMdToHtml } from "@gx/blocks";
import { htmlPosToTextPos, locateInSegments, planSrcOffset, textNodesOf } from "../../collab/block-cursor-locator";
import { applyPatchToText, type TextPatch } from "./blocksYjsState";

/** HTML 实体 → 可见字符（与 block-cursor-locator 的实体判定同规则）。 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};
const ENTITY_MAX = 8;

/** 与 block-cursor-locator 内的私有 skipTag 同规则（那边未导出，这里按同样语义实现）。 */
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

/** HTML → 可见文本（去标签 + 反转义）。纯函数，供"DOM 是否已是最新"的判定使用。 */
export function visibleTextOf(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === "&") {
      const semi = html.indexOf(";", i);
      if (semi > i && semi - i <= ENTITY_MAX) {
        const raw = html.slice(i, semi + 1);
        out += ENTITIES[raw] ?? raw;
        i = semi + 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "<") {
      i = skipTag(html, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export interface DomPatch {
  index: number;
  remove: number;
  /** 插入后**可见**的字符数（源码里的 `**` 之类标记不占可见长度） */
  insertLen: number;
}

/**
 * 光标位移：补丁区间整体在光标之前 → 按净增量平移；整体在光标之后 → 不动；
 * 相交（远端改的正是光标所在/紧邻处）→ 夹到插入内容末尾，符合"别人的字插进来后光标跟在后面"。
 */
export function nextCaretOffset(caret: number, patch: DomPatch): number {
  if (patch.index + patch.remove <= caret) return Math.max(0, caret + patch.insertLen - patch.remove);
  if (patch.index >= caret) return caret;
  return patch.index + patch.insertLen;
}

function segmentsOf(nodes: readonly Text[]): Array<{ text: string }> {
  return nodes.map((n) => ({ text: n.data }));
}

function visibleLength(html: string): number {
  return htmlPosToTextPos(html, html.length);
}

/** 当前选区起点在 el 可见文本里的偏移；选区不在 el 内 → null。 */
function caretOffsetIn(el: HTMLElement): number | null {
  const sel = el.ownerDocument.getSelection?.() ?? null;
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

function setCaretAt(el: HTMLElement, offset: number): void {
  const nodes = textNodesOf(el);
  const hit = locateInSegments(segmentsOf(nodes), offset);
  if (!hit) return;
  const node = nodes[hit.index];
  if (!node) return;
  const range = el.ownerDocument.createRange();
  range.setStart(node, Math.min(hit.innerOffset, node.data.length));
  range.collapse(true);
  const sel = el.ownerDocument.getSelection?.() ?? null;
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function applyOne(el: HTMLElement, patch: TextPatch, src: string): boolean {
  const nodes = textNodesOf(el);
  const total = nodes.reduce((n, t) => n + t.data.length, 0);
  // 一致性闸门：DOM 可见长度必须与源码渲染长度一致，否则映射不可信 → 交回整块重写
  if (total !== planSrcOffset(src, src.length)) return false;
  const from = planSrcOffset(src, patch.index);
  const to = planSrcOffset(src, patch.index + patch.remove);
  const startHit = locateInSegments(segmentsOf(nodes), from);
  const endHit = locateInSegments(segmentsOf(nodes), to);
  if (!startHit || !endHit) return false;
  const caret = caretOffsetIn(el);
  const range = el.ownerDocument.createRange();
  range.setStart(nodes[startHit.index]!, startHit.innerOffset);
  range.setEnd(nodes[endHit.index]!, endHit.innerOffset);
  range.deleteContents();
  const html = inlineMdToHtml(patch.insert);
  const insertLen = visibleLength(html);
  if (html !== "") {
    const tpl = el.ownerDocument.createElement("template");
    tpl.innerHTML = html;
    range.insertNode(tpl.content);
  }
  if (caret !== null) setCaretAt(el, nextCaretOffset(caret, { index: from, remove: to - from, insertLen }));
  return true;
}

/** 按顺序应用一组补丁（坐标随遍历演化）；中途任一步不可信 → 返回 false。 */
export function applyPatchesToDom(
  el: HTMLElement,
  patches: readonly TextPatch[],
  prevSrc: string,
): boolean {
  let src = prevSrc;
  for (const patch of patches) {
    if (!applyOne(el, patch, src)) return false;
    src = applyPatchToText(src, patch);
  }
  return true;
}
