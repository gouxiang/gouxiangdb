// apps/web/src/features/kb/collab/useDocPresence.ts
// 阶段 2 · 把「我在哪儿改」广播出去：本地光标 → awareness 的 selection / leases。
// 渲染侧（CollabCursorLayer / CollabLeaseLayer）早就挂好了，本文件是它们的**水源**。
//
// 为什么放在页面层而不是编辑器里：编辑器三态切换会整棵重挂载（切一次模式就重挂一次），
// 监听跟着建断会漏事件；而且 D6 要求不动编辑器内部结构 —— 这里只读 DOM 与 selection，
// 不往编辑器里塞任何回调、不新增它对外的接口。
//
// D6 UI 冻结：enabled 为 false（协同关闭 / 未连通）时本 hook **不挂任何监听、不发任何包**，
// 单机模式下 DOM 与改造前逐元素一致。

import { useEffect } from "react";
import type { RefObject } from "react";
import type { Doc } from "yjs";
import { htmlToInlineMd } from "@gx/blocks";
import { textNodesOf } from "../../collab/block-cursor-locator";
import { createCollabBlocks, hydrateBlocks } from "./blocksYjs";
import {
  CLEARED_PAYLOAD,
  LEASE_MS,
  docBlockSpans,
  leasePayload,
  locateDocOffset,
  selectionPayload,
  srcOffsetOfVisiblePos,
} from "./doc-caret";

/** 上报节流：光标每动一下都写 awareness 会让包量跟着按键数线性上涨，120ms 是手感与流量的折中。 */
export const PUBLISH_THROTTLE_MS = 120;

export interface UseDocPresenceOptions {
  /** 编辑器宿主容器（内含所有 `[data-editable]` 块）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** 发布口（useCollabSession.publish，引用稳定；未启用协同时是 no-op）。 */
  publish: (fields: Record<string, unknown>) => void;
  /** 协同是否真的通着（COLLAB_ENABLED && connected）；false 时本 hook 完全不动。 */
  enabled: boolean;
  /** 协同 Y.Doc：源码态下块 id 只能从共享结构里取（本地 mdToBlocks 会生成另一套 id）。 */
  doc: Doc | null;
  /** 当前整篇 Markdown（源码态定位用）；每次 handleChange 都会刷新到 ref，不触发重渲染。 */
  getMarkdown: () => string;
  /** 文档切换 / 内容重置时容器会整个换掉，用它触发重新绑定。 */
  revision: string;
}

/** 块 id 顺序取自协同共享结构（权威 id，跨端一致）。查不到（未播种）→ 空数组。 */
export function sharedBlockIds(doc: Doc | null): string[] {
  if (!doc) return [];
  try {
    return hydrateBlocks(createCollabBlocks(doc)).map((b) => b.id);
  } catch {
    return []; // 结构未就绪：本次不上报，下一次事件再试
  }
}

/** 光标所在块的可编辑宿主；不在容器内的选区（标题输入框、工具栏）一律不算。 */
function editableOf(node: Node | null, container: HTMLElement): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const found = el?.closest<HTMLElement>("[data-editable]") ?? null;
  return found && container.contains(found) ? found : null;
}

/**
 * 块内「可见文本位置」：与渲染侧 textNodesOf 用同一套文本段（跳过 contenteditable=false
 * 的原子节点），否则两端坐标系不一致，远端光标会偏。
 * 落点在元素上（空块 / 整块选中）时按子节点序号退化：0 → 块首，其余 → 块尾。
 */
function visiblePosIn(editable: HTMLElement, node: Node, offset: number): number | null {
  const nodes = textNodesOf(editable);
  let acc = 0;
  let total = 0;
  for (const t of nodes) {
    if (t === node) return acc + Math.min(Math.max(offset, 0), t.data.length);
    acc += t.data.length;
    total = acc;
  }
  return offset <= 0 ? 0 : total;
}

/** 所见即所得态：块 id 从 DOM 读，块内偏移走「可见文本位置 → 源码偏移」。 */
function readBlockCaret(container: HTMLElement): { blockId: string; offset: number; length: number } | null {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ?? null;
  if (!sel || sel.rangeCount === 0 || !anchor) return null;
  const editable = editableOf(anchor, container);
  const blockId = editable?.dataset.editable;
  if (!editable || !blockId) return null;
  const src = htmlToInlineMd(editable);
  const a = visiblePosIn(editable, anchor, sel.anchorOffset);
  const b = sel.isCollapsed ? a : visiblePosIn(editable, sel.focusNode as Node, sel.focusOffset);
  if (a === null || b === null) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const offset = srcOffsetOfVisiblePos(src, lo);
  return { blockId, offset, length: Math.max(0, srcOffsetOfVisiblePos(src, hi) - offset) };
}

/** 源码态：整篇 textarea 的偏移 → 块 id + 块内偏移（块 id 只能取共享结构里的）。 */
function readSourceCaret(
  container: HTMLElement,
  md: string,
  ids: readonly string[],
): { blockId: string; offset: number; length: number } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !container.contains(active)) return null;
  const spans = docBlockSpans(md, ids);
  if (spans.length === 0) return null;
  const start = active.selectionStart ?? 0;
  const hit = locateDocOffset(spans, start);
  if (!hit) return null;
  // 选区长度按整篇字符数折算（跨块选区会偏保守，光标落点才是契约的关键项）
  const length = Math.max(0, (active.selectionEnd ?? start) - start);
  return { blockId: hit.blockId, offset: hit.offset, length };
}

export function useDocPresence({
  containerRef,
  publish,
  enabled,
  doc,
  getMarkdown,
  revision,
}: UseDocPresenceOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    /** 节流器：120ms 内合并成一包，尾部补一拍（避免最后一次位置丢失）。 */
    const throttle = (emit: () => void) => {
      let last = 0;
      let timer: number | null = null;
      return {
        trigger(): void {
          const wait = PUBLISH_THROTTLE_MS - (Date.now() - last);
          if (wait <= 0) {
            last = Date.now();
            emit();
            return;
          }
          if (timer === null) {
            timer = window.setTimeout(() => {
              timer = null;
              last = Date.now();
              emit();
            }, wait);
          }
        },
        cancel(): void {
          if (timer !== null) clearTimeout(timer);
          timer = null;
        },
      };
    };

    let lastSelKey = "";
    let leaseUntil = 0; // 当前占着的块的到期时间（0 = 没占）
    let leaseBlock = "";
    let leaseTimer: number | null = null;

    const emitSelection = throttle(() => {
      const caret = readBlockCaret(container) ?? readSourceCaret(container, getMarkdown(), sharedBlockIds(doc));
      if (!caret) {
        if (lastSelKey !== "none") {
          lastSelKey = "none";
          publish(CLEARED_PAYLOAD);
        }
        return;
      }
      const key = `${caret.blockId}:${caret.offset}:${caret.length}`;
      if (key === lastSelKey) return; // 位置没变就不发包
      lastSelKey = key;
      publish(selectionPayload(caret.blockId, caret.offset, caret.length));
    });

    const emitLease = throttle(() => {
      if (!leaseBlock) return;
      publish(leasePayload(leaseBlock, Date.now()));
    });

    function dropLease(): void {
      leaseBlock = "";
      leaseUntil = 0;
      if (leaseTimer !== null) clearTimeout(leaseTimer);
      leaseTimer = null;
      publish({ leases: [] });
    }

    /** 正在改这一块 → 起租；租期固定 LEASE_MS，到点自动让出（不续期，停手即释放）。 */
    function holdBlock(blockId: string): void {
      const now = Date.now();
      const changed = blockId !== leaseBlock;
      leaseBlock = blockId;
      // 同一块且租期未过 → 什么都不做（打字期间的绝大多数事件落在这里，必须短路掉）
      if (!changed && now < leaseUntil) return;
      leaseUntil = now + LEASE_MS;
      emitLease.trigger(); // 换块 / 租期已过：都要重新广播一次
      if (leaseTimer !== null) clearTimeout(leaseTimer);
      leaseTimer = window.setTimeout(() => {
        leaseTimer = null;
        if (leaseBlock) dropLease();
      }, LEASE_MS);
    }

    const onSelectionChange = () => emitSelection.trigger();
    const onFocusIn = () => emitSelection.trigger();
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      // 焦点还在编辑器内（块之间跳）不算离开；落到标题输入框/别处才清空。
      if (next instanceof Node && container.contains(next)) return;
      lastSelKey = "none";
      if (leaseBlock) dropLease();
      publish(CLEARED_PAYLOAD);
    };
    const onInput = (e: Event) => {
      // 所见即所得态：块 id 从 DOM 读；源码态：把整篇偏移换算成块后再起租。
      const blockId =
        editableOf(e.target as Node | null, container)?.dataset.editable ??
        readSourceCaret(container, getMarkdown(), sharedBlockIds(doc))?.blockId ??
        null;
      if (blockId) holdBlock(blockId);
      emitSelection.trigger();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("input", onInput);

    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("input", onInput);
      emitSelection.cancel();
      emitLease.cancel();
      if (leaseTimer !== null) clearTimeout(leaseTimer);
      leaseTimer = null;
      // 卸载/断连：必须把光标与占用一起撤掉，否则别人屏幕上会留下一具"幽灵光标"。
      publish(CLEARED_PAYLOAD);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision 只作重绑触发：文档切换后容器整个换掉
  }, [enabled, publish, containerRef, doc, revision]);
}
