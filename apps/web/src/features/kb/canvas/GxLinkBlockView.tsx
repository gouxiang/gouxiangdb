// apps/web/src/features/kb/canvas/GxLinkBlockView.tsx
// F4: 直接插入式关联块视图（KB-EDITOR-ROUND-5 瘦身为纯几何适配层）。
// 取数 / body / 编辑弹窗全部收敛到 RefEmbedCard；本文件只保留：
//   - 几何适配：以 plait points（viewBox 坐标）驱动 LinkBlockForeignObject 的 x/y/宽高
//   - resize 手柄 → resizeLinkBlock
//   - 双击/跳转（useLinkResolve + navigate）
//   - 本地重命名 setLinkBlockDisplayTitle、删除 removeLinkBlock
//
// 层级：卡片不再渲染为 overlay 里固定 z-index 的独立 HTML，而是经 LinkBlockForeignObject
//   注入到该元素 geom <g> 的同层紧随位置（一个补偿 g 内的 foreignObject），从而与普通图形
//   共用 board.children 这唯一层级真源——置于顶层/底层/上移/下移对普通图形和关联卡统一生效
//   （geom g 重排时补偿 g 由 MutationObserver 守持跟随）。补偿 g 的 transform 抵消 viewBox
//   负原点，是 Safari/WebKit 下 foreignObject 复杂 HTML 正常栅格化的必要条件。

import { useState } from "react";
import type { PlaitBoard } from "@plait/core";
import { useNavigate } from "react-router-dom";
import { toast } from "../../../components/ui";
import { useLinkResolve } from "../hooks/useLinkResolve";
import type { GxLinkBlock } from "./types";
import {
  moveLinkBlock,
  removeLinkBlock,
  resizeLinkBlock,
  screenDeltaToViewBox,
  setLinkBlockDisplayTitle,
} from "./canvas-ops";
import { RefEmbedCard } from "./RefEmbedCard";
import { LinkBlockForeignObject } from "./LinkBlockForeignObject";

/** 拖拽判定阈值（px）：低于该位移视为点击，不进入拖动态、不写历史 */
const DRAG_THRESHOLD = 4;

interface GxLinkBlockViewProps {
  board: PlaitBoard;
  element: GxLinkBlock;
  kbId?: string;
  publicToken?: string;
  canEdit: boolean;
}

const MIN_W = 200;
const MIN_H = 120;
const MAX_W = 600;
const MAX_H = 400;

function getElementBox(el: GxLinkBlock): { x: number; y: number; w: number; h: number } {
  const [p1, p2] = el.points;
  return { x: p1[0], y: p1[1], w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]) };
}

export function GxLinkBlockView({ board, element, kbId, publicToken, canEdit }: GxLinkBlockViewProps) {
  // resize 中的 viewBox 尺寸（松手落库后回归 element 尺寸）
  const [liveVb, setLiveVb] = useState<{ w: number; h: number } | null>(null);
  // 拖拽中的 viewBox 位移（不写 plait，仅驱动 foreignObject 视觉跟随；松手一次性落库）
  const [dragVb, setDragVb] = useState<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  const resolveLink = useLinkResolve();

  const box = getElementBox(element);
  // 非 resize 时尺寸以最新 element 为准（撤销/重做/外部写入即时跟随）；resize 中用未落库的 liveVb。
  const w = liveVb ? liveVb.w : box.w;
  const h = liveVb ? liveVb.h : box.h;
  const x = box.x + (dragVb?.x ?? 0);
  const y = box.y + (dragVb?.y ?? 0);
  const dragging = dragVb !== null;

  const target = `/kb/${kbId ?? ""}/${element.gxLinkRef.kind}/${element.gxLinkRef.docId}`;

  function handleNavigate() {
    void resolveLink(target).then((res: { ok: boolean; toast?: string }) => {
      if (!res.ok) {
        toast(res.toast || "目标不可访问", "error");
        return;
      }
      navigate(target);
    });
  }

  /**
   * 右下角手柄 resize。
   * 关键点 1：setPointerCapture 把指针锁到手柄。嵌入 body 是另一张只读内嵌画布，
   *   其容器在捕获阶段对 pointermove stopPropagation；向缩小方向移动（鼠标滑入卡片 body）
   *   时若不捕获，事件被内嵌画布截断、onMove 停火 → 表现为"只能放大"。捕获后路径绕开内嵌画布。
   * 关键点 2：屏幕增量经 screenDeltaToViewBox 换算为 viewBox 增量（消化缩放/平移），
   *   非 100% 缩放下尺寸与手感才正确。
   */
  function handleResizeStart(e: React.PointerEvent) {
    if (!canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持则退化为非捕获 */
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const start = getElementBox(element);
    let live = { w: start.w, h: start.h };
    setLiveVb(live);

    const onMove = (ev: PointerEvent) => {
      const { dx, dy } = screenDeltaToViewBox(
        board,
        { x: startX, y: startY },
        { x: ev.clientX, y: ev.clientY },
      );
      live = {
        w: Math.max(MIN_W, Math.min(MAX_W, start.w + dx)),
        h: Math.max(MIN_H, Math.min(MAX_H, start.h + dy)),
      };
      setLiveVb(live);
    };
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      try {
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      resizeLinkBlock(board, element, live.w, live.h);
      setLiveVb(null);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  /**
   * 按住 header 拖拽移动整个关联块。
   * - 命中按钮 / 输入框 / 链接 / resize 手柄时直接放行，不进入拖拽
   * - 移动 < DRAG_THRESHOLD 视为点击（不打断双击跳转、按钮点击）
   * - 拖拽中把屏幕位移换算为 viewBox 位移驱动 foreignObject 跟随（不逐帧写 plait），
   *   松手一次性 moveLinkBlock —— 一次拖拽只产生一个撤销历史项
   * 说明：卡片已在 svg 内，pointerdown 会被 DrawnixCanvas 的板级守卫跳过外层板处理，
   *   但不影响本组件 React 事件，故这里无需再依赖"事件不经 plait 容器"的旧前提。
   */
  function handleHeaderPointerDown(e: React.PointerEvent) {
    if (!canEdit) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("button, input, textarea, a, select, [data-no-drag]")) return;
    if (t?.closest('[role="presentation"]')) return; // resize 手柄
    e.preventDefault();

    const headerEl = e.currentTarget as HTMLElement;
    try {
      headerEl.setPointerCapture(e.pointerId);
    } catch {
      /* 退化为 window 监听 */
    }

    const startX = e.clientX;
    const startY = e.clientY;
    let armed = false;
    let last = { x: 0, y: 0 };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!armed && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!armed) armed = true;
      const vb = screenDeltaToViewBox(
        board,
        { x: startX, y: startY },
        { x: ev.clientX, y: ev.clientY },
      );
      last = { x: vb.dx, y: vb.dy };
      setDragVb(last);
    };
    const onUp = (ev: PointerEvent) => {
      headerEl.removeEventListener("pointermove", onMove);
      headerEl.removeEventListener("pointerup", onUp);
      try {
        if (headerEl.hasPointerCapture(ev.pointerId)) headerEl.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      if (armed) moveLinkBlock(board, element, last.x, last.y);
      setDragVb(null);
    };
    headerEl.addEventListener("pointermove", onMove);
    headerEl.addEventListener("pointerup", onUp);
  }

  return (
    <LinkBlockForeignObject
      board={board}
      elementId={element.id}
      x={x}
      y={y}
      width={w}
      height={h}
      dragging={dragging}
      onDoubleClick={handleNavigate}
    >
      <RefEmbedCard
        gxRef={element.gxLinkRef}
        kbId={kbId}
        publicToken={publicToken}
        canEdit={canEdit}
        // 容器视觉类已由 LinkBlockForeignObject 的 HTML 包裹层提供；这里加 relative 作为
        // resize 手柄(absolute)的定位包含块，不重复边框/背景。
        containerClassName="relative flex h-full w-full flex-col overflow-hidden"
        containerStyle={{}}
        onHeaderPointerDown={canEdit ? handleHeaderPointerDown : undefined}
        canRename
        onRename={(v) => setLinkBlockDisplayTitle(board, element, v.trim() ? v : null)}
        jumpEnabled={!!kbId}
        onJump={handleNavigate}
        showRefresh={!publicToken}
        onDelete={canEdit ? () => removeLinkBlock(board, element) : undefined}
        trailingNode={
          canEdit ? (
            <div
              role="presentation"
              onPointerDown={handleResizeStart}
              // 热区按 1/zoom 补偿：缩放到很小时仍有不小于 12px 的可点面积
              style={{
                width: Math.max(12, 12 / (board.viewport?.zoom ?? 1)),
                height: Math.max(12, 12 / (board.viewport?.zoom ?? 1)),
                background: "linear-gradient(135deg, transparent 50%, var(--gx-text-hint, #888780) 50%)",
              }}
              className="absolute bottom-0 right-0 touch-none cursor-se-resize"
            />
          ) : null
        }
      />
    </LinkBlockForeignObject>
  );
}
