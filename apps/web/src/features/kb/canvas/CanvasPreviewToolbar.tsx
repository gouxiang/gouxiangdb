// apps/web/src/features/kb/canvas/CanvasPreviewToolbar.tsx
// F1: 版本管理器/历史快照预览工具条——放大/缩小/还原/适配视图 + 键盘滑动。
// 仅在只读 + 允许查看交互（allowViewInteraction=true）的场景显示；编辑态用主工具条。
//
// 数据来源：通过 forwardRef<DrawnixCanvasHandle> 拿到 board 命令句柄，
// 内部监听 handle.getZoom() 通过 setInterval 轮询（200ms）实现百分比显示——
// plait 的 viewport 变化没有 React 事件，简单轮询代价 < 1% CPU，不引入事件层。

import { useEffect, useRef, useState } from "react";
import type { DrawnixCanvasHandle } from "../DrawnixCanvas";
import { Icon } from "../../../components/icons";

interface CanvasPreviewToolbarProps {
  handle: DrawnixCanvasHandle | null;
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.1;

export function CanvasPreviewToolbar({ handle }: CanvasPreviewToolbarProps) {
  const [zoom, setZoom] = useState<number>(() => (handle ? handle.getZoom() : 1));
  const panStateRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });

  // 轮询 zoom 变化（用户滚轮/触控板缩放同步显示）
  useEffect(() => {
    if (!handle) return;
    const id = setInterval(() => {
      const z = handle.getZoom();
      setZoom((prev) => (Math.abs(prev - z) < 0.001 ? prev : z));
    }, 200);
    return () => clearInterval(id);
  }, [handle]);

  // 键盘平移：箭头键移动视图（与主工具一致），+/- 缩放，0 还原，F 适配
  useEffect(() => {
    if (!handle) return;
    const onKey = (e: KeyboardEvent) => {
      // IME 守卫
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      // 焦点在编辑器内时不拦截
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const step = 50;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handle.panBy(step, 0);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handle.panBy(-step, 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        handle.panBy(0, step);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handle.panBy(0, -step);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        handle.zoomBy(ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        handle.zoomBy(-ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        handle.setZoom(1);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        handle.fit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handle]);

  if (!handle) return null;

  const pct = Math.round(zoom * 100);
  const atMin = zoom <= ZOOM_MIN + 0.001;
  const atMax = zoom >= ZOOM_MAX - 0.001;

  return (
    <div
      className="canvas-preview-toolbar fixed bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-gx-md border border-gx-separator bg-gx-surface p-1 shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => {
        // 工具条上的滚轮直接驱动缩放（不被 plait 拦截）
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        handle.zoomBy(e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
      }}
    >
      <button
        type="button"
        title="缩小（-）"
        disabled={atMin}
        onClick={() => handle.zoomBy(-ZOOM_STEP)}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary disabled:opacity-30"
      >
        <Icon name="minus" size={14} />
      </button>
      <span className="min-w-[44px] px-1 text-center text-gx-12 tabular-nums text-gx-text-secondary">{pct}%</span>
      <button
        type="button"
        title="放大（+）"
        disabled={atMax}
        onClick={() => handle.zoomBy(ZOOM_STEP)}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary disabled:opacity-30"
      >
        <Icon name="plus" size={14} />
      </button>
      <span className="mx-0.5 h-4 w-px bg-gx-separator" />
      <button
        type="button"
        title="还原 100%（0）"
        onClick={() => handle.setZoom(1)}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary"
      >
        <span className="text-gx-11 font-medium">1:1</span>
      </button>
      <button
        type="button"
        title="适配视图（F）"
        onClick={() => handle.fit()}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary"
      >
        <Icon name="expand" size={14} />
      </button>
      <span className="mx-0.5 h-4 w-px bg-gx-separator" />
      <button
        type="button"
        title="手形平移（按住拖动）"
        onPointerDown={(e) => {
          panStateRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = panStateRef.current;
          if (!s.active) return;
          const dx = e.clientX - s.lastX;
          const dy = e.clientY - s.lastY;
          s.lastX = e.clientX;
          s.lastY = e.clientY;
          handle.panBy(dx, dy);
        }}
        onPointerUp={(e) => {
          panStateRef.current.active = false;
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        }}
        onPointerCancel={() => { panStateRef.current.active = false; }}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary"
      >
        <Icon name="swap" size={14} />
      </button>
    </div>
  );
}