// apps/web/src/features/kb/canvas/CanvasEnhanceOverlay.tsx
// 画布增强层总装：
//  1. 遍历 board.children 中所有几何/连线节点，渲染注释角标、关联文档角标与 hover 预览（#118/#119）；
//  2. 对当前选中元素渲染「节点样式条」（线宽/文字样式/图片/注释/关联/连线形态，#116/#117/#120/#121）；
//  3. 关联文档的预览卡（全文滚动 + 拖拽调尺寸 + 弹窗编辑 + 跳转 + 取消关联，#119）。
// 全部 fixed 定位，每帧由 CanvasBoardProvider 的 frame 驱动重算屏幕矩形，跟随平移/缩放/拖拽。

import { useEffect, useMemo, useState } from "react";
import type { PlaitElement } from "@plait/core";
import {
  CanvasOverlayLayer,
  useCanvasBoard,
  type ScreenRect,
} from "./canvas-context";
import { isAnnotatable, isLineLike, isLinkBlock, isMindMapNode, isStyleBarEligible, type GxDocRef } from "./types";
import { readElementDocRef, readElementNote } from "./canvas-ops";
import { NodeBadges } from "./NodeBadges";
import { NodeStyleBar } from "./NodeStyleBar";
import { DocRefCard } from "./DocRefCard";
import { GxLinkBlockView } from "./GxLinkBlockView";
import { CanvasLinkEntry } from "./CanvasLinkEntry";
import { CanvasZOrderMenu } from "./CanvasZOrderMenu";

function flatten(elements: PlaitElement[], acc: PlaitElement[] = []): PlaitElement[] {
  for (const el of elements) {
    acc.push(el);
    if (Array.isArray(el.children) && el.children.length) flatten(el.children, acc);
  }
  return acc;
}

export function CanvasEnhanceOverlay() {
  const rt = useCanvasBoard();
  // 当前展开预览卡的关联节点 id 集合——允许同时展开多张，保持画布清爽（每张卡定位到自己的节点旁）
  const [openRefNodeIds, setOpenRefNodeIds] = useState<Set<string>>(new Set());

  const annotated = useMemo(() => {
    if (!rt?.board) return [];
    // frame 在闭包外通过 rt.frame 变化触发重渲染
    void rt.frame;
    return flatten(rt.board.children).filter((el) => {
      if (!isAnnotatable(el)) return false;
      return !!readElementNote(el) || !!readElementDocRef(el);
    });  }, [rt?.board, rt?.frame]);

  // F4: 直接插入式关联块（独立 gx-link-block）
  const linkBlocks = useMemo(() => {
    if (!rt?.board) return [];
    void rt.frame;
    return flatten(rt.board.children).filter(isLinkBlock);
  }, [rt?.board, rt?.frame]);

  // 切换 / 关闭预览卡
  function toggleOpenRef(id: string) {
    setOpenRefNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function closeOpenRef(id: string) {
    setOpenRefNodeIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const selectedRects = useMemo(() => {
    if (!rt?.board) return [];
    void rt.frame;
    const out: { id: string; rect: ScreenRect; el: PlaitElement }[] = [];
    for (const id of rt.selectedIds) {
      const el = flatten(rt.board.children).find((e) => e.id === id);
      if (!el || !isStyleBarEligible(el)) continue;
      const rect = rt.getLocalRect(el);
      if (rect) out.push({ id, rect, el });
    }
    return out;
  }, [rt?.board, rt?.selectedIds, rt?.frame]);

  if (!rt?.board || !rt.container) return null;
  const canEdit = rt.ctx.canEdit;

  // 选中工具条的锚点：多选时取包围盒并集
  let barAnchor: ScreenRect | null = null;
  if (selectedRects.length && canEdit) {
    const x1 = Math.min(...selectedRects.map((s) => s.rect.x));
    const y1 = Math.min(...selectedRects.map((s) => s.rect.y));
    const x2 = Math.max(...selectedRects.map((s) => s.rect.x + s.rect.width));
    const y2 = Math.max(...selectedRects.map((s) => s.rect.y + s.rect.height));
    barAnchor = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  return (
    <CanvasOverlayLayer>
      {/* F4: 直接插入式关联块（独立 gx-link-block 元素，不挂任何节点） */}
      {linkBlocks.map((el) => (
        <GxLinkBlockView
          key={`linkblock-${el.id}`}
          board={rt.board!}
          element={el}
          kbId={rt.ctx.kbId}
          publicToken={rt.ctx.publicToken}
          canEdit={canEdit}
        />
      ))}

      {/* 角标层：注释/关联（含 hover 预览），只读用户也可见 */}
      {annotated.map((el) => {
        const rect = rt.getLocalRect(el);
        if (!rect) return null;
        return (
          <NodeBadges
            key={`badge-${el.id}`}
            element={el}
            rect={rect}
            canEdit={canEdit}
            onOpenRef={() => toggleOpenRef(el.id)}
            isRefOpen={openRefNodeIds.has(el.id)}
          />
        );
      })}

      {/* 选中节点样式条（仅可编辑） */}
      {barAnchor && (
        <NodeStyleBar anchor={barAnchor} elements={selectedRects.map((s) => s.el)} />
      )}

      {/* 关联文档预览卡（多开：每张卡独立定位到自己的节点旁） */}
      {[...openRefNodeIds].map((id) => (
        <DocRefCardNode
          key={`refcard-${id}`}
          nodeId={id}
          onClose={() => closeOpenRef(id)}
          canEdit={canEdit}
        />
      ))}

      {/* 顶部工具栏"关联"入口（左上角，原 .app-toolbar 槽位，kb.css:309 隐藏后留出） */}
      <CanvasLinkEntry />

      {/* 统一图层管理：画布右键菜单 + ⌘]/⌘[/⌥⌘]/⌥⌘[（菜单 portal 到 body，不占裁剪层） */}
      <CanvasZOrderMenu />
    </CanvasOverlayLayer>
  );
}

/** 单独一层解析：预览卡随节点位置移动；节点被删/取消关联时自动关闭 */
function DocRefCardNode({
  nodeId,
  onClose,
  canEdit,
}: {
  nodeId: string;
  onClose: () => void;
  canEdit: boolean;
}) {
  const rt = useCanvasBoard();
  const board = rt?.board ?? null;
  const frame = rt?.frame;
  const el = useMemo(
    () => (board ? flatten(board.children).find((e) => e.id === nodeId) ?? null : null),
    [board, frame, nodeId],
  );
  const ref = el ? readElementDocRef(el) : null;
  const missing = !board || !el || !ref;
  // C-7：节点被删/取消关联时在提交后关闭——render 期直接 setState 会触发
  // "Cannot update a component while rendering" 且行为不可预期。
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (!rt || !el || !ref) return null;
  const rect = rt.getLocalRect(el);
  if (!rect) return null;
  return (
    <DocRefCard
      nodeId={nodeId}
      ref_={ref as GxDocRef}
      nodeRect={rect}
      canEdit={canEdit}
      kbId={rt.ctx.kbId}
      publicToken={rt.ctx.publicToken}
      onClose={onClose}
    />
  );
}
