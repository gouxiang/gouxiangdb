// apps/web/src/features/collab/CollabCursorLayer.tsx
// 他人协同光标浮层（DESIGN.md §13 第 3 条）。
//
// D6 硬约束：本组件渲染成编辑器容器的**兄弟节点**，绝对不得写进编辑器内部 DOM。
//   验收判据之一就是「编辑器内部 DOM 里不得出现协同光标元素」。
//   因此这里只是往**容器外层**画一个绝对定位的浮层（没有任何东西被插进编辑器），挂载点由宿主页面决定
//   （DocEditorPage.tsx:257 的 `<div className="relative min-h-0 flex-1 bg-gx-surface">` 就是现成的宿主）。
//
// 定位链路见 block-cursor-locator.ts 文件头；本组件只负责：取编辑器容器的矩形 →
// 逐个 peer 量测 → 换算成本地坐标 → 画竖线与人名标签（贴边翻转由 placeLabel 负责）。
//
// 覆盖不到的部分（如实说明，勿假装）：本仓 vitest 跑 node 环境且无 jsdom，
// Range.getBoundingClientRect / TreeWalker 无法单测。能在 node 里单测的纯数学已全部下沉
// 到 block-cursor-locator.ts 与 overlay-anchors.ts，本文件只留 DOM 粘合。

import { useMemo } from "react";
import type { CollabPresenceEntry } from "@gx/shared-types";
import { displayNameOf, splitPresence } from "./collab-peers";
import { measureCaretAt } from "./block-cursor-locator";
import { placeLabel, toLocalRect, useDomTicker } from "./overlay-anchors";

/**
 * 标签尺寸的估值。**无布局环境下无法测量文字宽度**（没有 jsdom / 不在渲染后测量），
 * 故取常态估值：最多 5 个字 × 12px + 内边距 ≈ 72×18。
 * 它只用于「要不要贴边翻转」的判定，略有误差不影响正确性 —— 判定偏保守时标签会早一点翻到左侧。
 */
const LABEL_WIDTH_EST = 72;
const LABEL_HEIGHT_EST = 18;

export interface CollabCursorLayerProps {
  /** 编辑器容器，必须是 relative 定位；浮层以它为坐标系。 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 直接传 useCollabSession 的 entries（含自己，组件内部自行剔除）。 */
  entries: readonly CollabPresenceEntry[];
  selfId: string | null;
  /**
   * 取某个块的**行内 Markdown 源码**。
   * 为什么必须由宿主提供：块正文存的是带格式标记的原文，而浮层活在编辑器外部、拿不到 Block[]，
   * 没有源码就无法做「源码 offset → DOM 位置」换算。取不到就返回 null，该 peer 本次不画 —— 宁缺勿错。
   */
  getBlockSource: (blockId: string) => string | null;
}

interface PlacedCursor {
  id: string;
  nick: string;
  color: string;
  left: number;
  top: number;
  height: number;
  labelLeft: number;
  labelTop: number;
}

export function CollabCursorLayer({
  containerRef,
  entries,
  selfId,
  getBlockSource,
}: CollabCursorLayerProps): JSX.Element | null {
  const docPeers = useMemo(() => {
    return splitPresence(entries, selfId).peers.filter(
      (p) => p.selection?.kind === "doc",
    ) as Array<CollabPresenceEntry & { selection: Extract<CollabPresenceEntry["selection"], { kind: "doc" }> }>;
  }, [entries, selfId]);

  const signal = useMemo(
    () => docPeers.map((p) => `${p.id}|${p.selection.blockId}|${p.selection.offset}`).join(","),
    [docPeers],
  );
  const tick = useDomTicker(containerRef, docPeers.length > 0, signal);

  // 注：tick 不在这个闭包里被读到，但它是「容器滚动 / resize / 远端 reflow 后重新量测」的节拍信号，
  // 必须作为依赖参与，否则坐标会停滞 —— 相关 lint 误报在下方依赖数组处定向关闭。
  const placed = useMemo<PlacedCursor[]>(() => {
    const container = containerRef.current;
    if (!container || docPeers.length === 0) return [];
    const containerRect = container.getBoundingClientRect();
    const box = {
      left: containerRect.left,
      top: containerRect.top,
      width: containerRect.width,
      height: containerRect.height,
    };
    const out: PlacedCursor[] = [];
    for (const peer of docPeers) {
      const src = getBlockSource(peer.selection.blockId);
      if (src === null) continue; // 拿不到源码就画不出来，宁缺勿错
      const caret = measureCaretAt(container, peer.selection.blockId, src, peer.selection.offset);
      if (!caret) continue; // 块不在 DOM / 文本节点已被远端热补换掉
      const local = toLocalRect(box, {
        left: caret.left,
        top: caret.top,
        width: 0,
        height: caret.height,
      });
      const label = placeLabel(
        { x: local.left, y: local.top, height: local.height },
        { width: LABEL_WIDTH_EST, height: LABEL_HEIGHT_EST },
        { width: box.width, height: box.height },
      );
      out.push({
        id: peer.id,
        nick: displayNameOf(peer),
        color: peer.color,
        left: local.left,
        top: local.top,
        height: local.height,
        labelLeft: label.left,
        labelTop: label.top,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick 是重算节拍信号，见上方 useMemo 说明
  }, [containerRef, docPeers, getBlockSource, tick]);

  // D6：没有可画的光标时不产出任何 DOM
  if (placed.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      aria-hidden="true"
      data-gx-collab="cursors"
    >
      {placed.map((c) => (
        <span key={c.id}>
          <span
            className="absolute w-0.5 rounded-full"
            style={{ left: c.left, top: c.top, height: c.height, backgroundColor: c.color }}
          />
          <span
            className="absolute whitespace-nowrap rounded-gx-sm px-1 text-gx-11 font-medium text-white"
            style={{ left: c.labelLeft, top: c.labelTop, backgroundColor: c.color }}
          >
            {c.nick}
          </span>
        </span>
      ))}
    </div>
  );
}
