// apps/web/src/features/kb/collab/doc-caret.ts
// 阶段 2 · 本地光标/占用的**坐标换算**（纯函数，node 环境可测 —— 本仓 vitest 无 jsdom）。
//
// 远端光标契约（shared-types 的 CollabSelection）：`{ kind:"doc", blockId, offset, length }`，
// 其中 offset 是「**该块行内 Markdown 源码**里的字符偏移」，不是 DOM 偏移、也不是可见文本偏移
// （块正文存的是 `**粗**` 这种带标记的原文，屏幕上却是格式化后的样子）。渲染侧用的是
// block-cursor-locator 的 planSrcOffset（src offset → 可见文本位置），所以本文件发布侧必须
// 用**它的逆运算**，两侧共用同一条链路才不会各算各的。
//
// 两条取坐标的路径（编辑器三态决定走哪条）：
//   ① 所见即所得态：每个块是独立 contentEditable（`[data-editable="<blockId>"]`），
//      块 id 从 DOM 直接读，块内偏移 = 「可见文本位置 → 源码偏移」（srcOffsetOfVisiblePos）。
//   ② 源码态：整篇 Markdown 在一个 textarea 里，只有整篇字符偏移 —— 先按块正文把整篇切成
//      若干源码区间（docBlockSpans，对齐时借 mdToBlocks 的块正文，不另写一份解析器），
//      再定位（locateDocOffset）。块 id 不在这里生成：块 id 是协同共享结构里的权威 id，
//      由调用方（DOM 或 Y 结构）传入，本文件只做位置对齐。

import { mdToBlocks } from "@gx/blocks";
import { planSrcOffset } from "../../collab/block-cursor-locator";
import { contentOf } from "./blocksYjs";

/** 单次占用的租期：过期即视为释放，**不做无限续期**（停手不动也会在 15s 后自动让出）。 */
export const LEASE_MS = 15_000;

/** 整篇源码里属于某个块的区间（左闭右开）；空块是零长区间，用于占位。 */
export interface DocBlockSpan {
  blockId: string;
  start: number;
  end: number;
}

/**
 * 可见文本位置 → 块内 Markdown 源码偏移（srcOffsetOfVisiblePos 的逆方向由本函数给出）。
 *
 * 依据：planSrcOffset(s) 对 s 单调不减（srcToHtml 与 htmlPosToTextPos 都单调），
 * 故线性扫描「第一个可见位置 ≥ visiblePos 的源码下标」即为所求。这样选中的是**平局区间里
 * 最小的那个** s —— 语义是「插在最后一个已看见的字符之后、闭合标记之前」：光标停在
 * `**粗|**` 时给出 offset=3（紧跟「粗」），而不是 5（越过闭合标记），与渲染侧的落点一致。
 *
 * 越界一律夹住：visiblePos ≤ 0 → 0；超过全部可见长度 → src.length。
 */
export function srcOffsetOfVisiblePos(src: string, visiblePos: number): number {
  const target = Number.isFinite(visiblePos) ? Math.max(0, Math.trunc(visiblePos)) : 0;
  if (target === 0) return 0;
  for (let s = 1; s <= src.length; s += 1) {
    if (planSrcOffset(src, s) >= target) return s;
  }
  return src.length;
}

/**
 * 整篇 Markdown → 块源码区间（按块在文中的先后顺序，与 blockIds **按序对齐**）。
 *
 * 对齐方式：块正文取自 mdToBlocks（块的唯一权威解析器，不另抄一份规则），再在正文里按序
 * 顺序查找它出现的位置 —— 单调推进光标，故区间互不重叠且递增。块 id 由调用方给出
 * （协同共享结构里的权威 id），本函数只负责「第 i 个块落在整篇的哪一段」。
 *
 * 任一处对不上（块数不一致 / 正文被转义改写而查不到）就返回空数组 —— 宁可不上报，
 * 也不把错位的块 id 广播出去（那会让别人屏幕上出现凭空跳动的光标）。
 */
export function docBlockSpans(md: string, blockIds: readonly string[]): DocBlockSpan[] {
  const blocks = mdToBlocks(md);
  if (blocks.length !== blockIds.length || blockIds.length === 0) return [];
  const spans: DocBlockSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const content = contentOf(blocks[i]!);
    if (!content) {
      spans.push({ blockId: blockIds[i]!, start: cursor, end: cursor }); // 空块：零长占位
      continue;
    }
    const at = md.indexOf(content, cursor);
    if (at < 0) {
      spans.push({ blockId: blockIds[i]!, start: cursor, end: cursor });
      continue;
    }
    spans.push({ blockId: blockIds[i]!, start: at, end: at + content.length });
    cursor = at + content.length;
  }
  return spans;
}

/**
 * 整篇偏移 → `{ blockId, offset }`（块内源码偏移）。
 *
 * 边界约定（都锁在单测里）：
 *   - 文首：offset ≤ 首块起点 → 首块，块内 0；
 *   - 文末：offset ≥ 末块终点 → 末块，块内取块尾（不是整篇尾，否则远端会画到块外）；
 *   - 块与块交界：命中**前一个**块的块尾（第一个满足 offset ≤ end 的块），
 *     与「光标停在某行行尾属于该行」的直觉一致；
 *   - 空块：零长区间，块内恒为 0。
 * 无区间（块 id 与正文对不上）→ null，调用方据此跳过本次上报。
 */
export function locateDocOffset(
  spans: readonly DocBlockSpan[],
  offset: number,
): { blockId: string; offset: number } | null {
  if (spans.length === 0) return null;
  const pos = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const first = spans[0]!;
  if (pos <= first.start) return { blockId: first.blockId, offset: 0 };
  for (const span of spans) {
    if (pos <= span.end) {
      return { blockId: span.blockId, offset: Math.min(Math.max(pos - span.start, 0), span.end - span.start) };
    }
  }
  const last = spans[spans.length - 1]!;
  return { blockId: last.blockId, offset: last.end - last.start };
}

/** 选区载荷（源码坐标）；length 为选中的源码字符数，折叠光标为 0。 */
export function selectionPayload(blockId: string, offset: number, length = 0): Record<string, unknown> {
  return {
    selection: {
      kind: "doc",
      blockId,
      offset: Math.max(0, Math.trunc(offset)),
      length: Math.max(0, Math.trunc(length)),
    },
  };
}

/** 占用载荷：只占当前这一块，到期自动失效（不续期）。 */
export function leasePayload(blockId: string, now: number): Record<string, unknown> {
  const since = Number.isFinite(now) ? Math.trunc(now) : 0;
  return { leases: [{ unit: blockId, since, expiresAt: since + LEASE_MS }] };
}

/** 清空载荷：失焦 / 离开页面时发，别人屏幕上我的光标必须立刻消失。 */
export const CLEARED_PAYLOAD: Record<string, unknown> = { selection: null, leases: [] };
