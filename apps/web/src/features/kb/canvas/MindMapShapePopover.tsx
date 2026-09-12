// apps/web/src/features/kb/canvas/MindMapShapePopover.tsx
// F5: 思维导图节点形状切换面板（round-rectangle / underline）。
// 枚举值对齐 @plait/mind 0.89.2 MindElementShape（element.d.ts:47-50）。
// 修复 #4-P0：原占位用 mind-topic / mind-branch 错值，已替换为真实 plait 字段。

import { useEffect, useRef, type ReactNode } from "react";
import type { IconName } from "../../../components/icons";
import { Icon } from "../../../components/icons";
import { useCanvasBoard } from "./canvas-context";

interface MindMapShapePopoverProps {
  x: number;
  y: number;
  onPick: (shape: "round-rectangle" | "underline") => void;
  onClose: () => void;
}

const SHAPES: { v: "round-rectangle" | "underline"; label: string; desc: string; icon: IconName }[] = [
  { v: "round-rectangle", label: "圆角矩形", desc: "主题节点，居中强调", icon: "circle" },
  { v: "underline", label: "下划线节点", desc: "分支节点，紧凑延展", icon: "underline" },
];

export function MindMapShapePopover({ x, y, onPick, onClose }: MindMapShapePopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rt = useCanvasBoard();
  const vw = rt?.viewport.width || window.innerWidth;
  const vh = rt?.viewport.height || window.innerHeight;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute gx-z-canvas-popover rounded-gx-md border border-gx-separator bg-gx-surface p-1.5 shadow-2xl"
      style={{ left: Math.min(x, Math.max(8, vw - 188 - 8)), top: Math.min(y, Math.max(8, vh - 220 - 8)), width: 180 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-0.5">
        {SHAPES.map((it) => (
          <button
            key={it.v}
            type="button"
            onClick={() => onPick(it.v)}
            className="flex items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left hover:bg-gx-bg"
          >
            <Icon name={it.icon} size={16} />
            <span className="text-gx-12">
              <span className="block font-medium text-gx-text-primary">{it.label}</span>
              <span className="block text-gx-11 text-gx-text-hint">{it.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}