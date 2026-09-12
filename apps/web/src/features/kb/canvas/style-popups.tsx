// apps/web/src/features/kb/canvas/style-popups.tsx
// 节点样式条的各类弹层：颜色色板、线宽滑块、虚实选择。纯展示 + 回调，不直接碰 board。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FILL_COLORS, NO_COLOR, STROKE_COLORS, TRANSPARENT } from "./canvas-colors";
import { useCanvasBoard } from "./canvas-context";

/** 通用弹层：absolute 定位在裁剪层内的触发按钮旁，点击外部/Esc 关闭。
 *  x/y 已是裁剪层本地坐标；钳制边界用裁剪层尺寸（而非浏览器视口），嵌套画布不溢出框体。 */
export function PopoverShell({
  x,
  y,
  onClose,
  width = 216,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rt = useCanvasBoard();
  const [rect, setRect] = useState<{ left: number; top: number }>({ left: x, top: y });
  // 定位完成前先隐藏，避免弹层在初始 (x,y) 闪一帧。
  // 注意：不能用"clamp 后 left 是否等于 x"判定——当 x 本就在可视边界内时
  // clamp 是恒等变换，left===x 永远成立，弹层会永久 visibility:hidden（线上实测 bug）。
  const [positioned, setPositioned] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 裁剪层尺寸（弹层在其内 absolute）；裁剪层未就绪时退化到浏览器视口（仅防御）
    const vw = rt?.viewport.width || window.innerWidth;
    const vh = rt?.viewport.height || window.innerHeight;
    const left = Math.min(Math.max(8, x), Math.max(8, vw - r.width - 8));
    const top = Math.min(Math.max(8, y), Math.max(8, vh - r.height - 8));
    setRect({ left, top });
    setPositioned(true);
  }, [x, y, rt?.viewport.width, rt?.viewport.height]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延迟一帧绑定，避免打开弹层的同一次点击立即触发关闭
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
      className="absolute gx-z-canvas-popover rounded-gx-md border border-gx-separator bg-gx-surface p-2 shadow-2xl"
      style={{ left: rect.left, top: rect.top, width, visibility: positioned ? undefined : "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function Swatches({
  colors,
  current,
  onPick,
}: {
  colors: string[];
  current: string | null;
  onPick: (c: string | null) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-1">
      {colors.map((c) => {
        const none = c === NO_COLOR || c === TRANSPARENT;
        const active = current === (none ? null : c);
        return (
          <button
            key={c}
            type="button"
            title={none ? "无颜色" : c}
            onClick={() => onPick(none ? null : c)}
            className={`relative h-5 w-5 rounded border ${
              active ? "ring-2 ring-gx-accent ring-offset-1" : "border-gx-separator"
            }`}
            style={{ backgroundColor: none ? "transparent" : c }}
          >
            {none && <span className="absolute inset-0 flex items-center justify-center text-gx-text-hint">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5l14 14" />
              </svg>
            </span>}
          </button>
        );
      })}
    </div>
  );
}

export function StrokeColorPopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string | null;
  onPick: (c: string | null) => void;
  onClose: () => void;
}) {
  return (
    <PopoverShell x={x} y={y} onClose={onClose}>
      <div className="mb-1.5 text-gx-11 font-medium text-gx-text-hint">线条 / 描边颜色</div>
      <Swatches colors={STROKE_COLORS} current={current} onPick={(c) => { onPick(c); onClose(); }} />
    </PopoverShell>
  );
}

export function FillColorPopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string | null;
  onPick: (c: string | null) => void;
  onClose: () => void;
}) {
  return (
    <PopoverShell x={x} y={y} onClose={onClose}>
      <div className="mb-1.5 text-gx-11 font-medium text-gx-text-hint">填充颜色</div>
      <Swatches colors={FILL_COLORS} current={current} onPick={(c) => { onPick(c); onClose(); }} />
    </PopoverShell>
  );
}

export function TextStyleColorPopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string | null;
  onPick: (c: string | null) => void;
  onClose: () => void;
}) {
  return (
    <PopoverShell x={x} y={y} onClose={onClose}>
      <div className="mb-1.5 text-gx-11 font-medium text-gx-text-hint">文字颜色</div>
      <Swatches colors={STROKE_COLORS} current={current} onPick={(c) => { onPick(c); onClose(); }} />
    </PopoverShell>
  );
}

export function StrokeWidthPopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: number;
  onPick: (w: number) => void;
  onClose: () => void;
}) {
  return (
    <PopoverShell x={x} y={y} onClose={onClose} width={190}>
      <div className="mb-1 flex items-center justify-between text-gx-11 text-gx-text-hint">
        <span>线条粗细</span>
        <span className="tabular-nums text-gx-text-secondary">{current}px</span>
      </div>
      <input
        type="range"
        min={1}
        max={12}
        step={1}
        value={current}
        autoFocus
        onChange={(e) => onPick(Number(e.target.value))}
        onPointerUp={onClose}
        onKeyUp={(e) => e.key === "Enter" && onClose()}
        className="w-full accent-gx-accent"
      />
      <div className="mt-1 flex justify-between text-gx-10 text-gx-text-hint">
        <span>1</span><span>12</span>
      </div>
    </PopoverShell>
  );
}

const STYLES = [
  { v: "solid", label: "实线", dash: "" },
  { v: "dashed", label: "虚线", dash: "6 4" },
  { v: "dotted", label: "点线", dash: "1 4" },
] as const;

export function StrokeStylePopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string;
  onPick: (s: "solid" | "dashed" | "dotted") => void;
  onClose: () => void;
}) {
  return (
    <PopoverShell x={x} y={y} onClose={onClose} width={150}>
      <div className="mb-1.5 text-gx-11 font-medium text-gx-text-hint">线型</div>
      <div className="flex flex-col gap-1">
        {STYLES.map((s) => (
          <button
            key={s.v}
            type="button"
            onClick={() => { onPick(s.v); onClose(); }}
            className={`flex items-center gap-2 rounded-gx-sm px-2 py-1.5 text-gx-12 hover:bg-gx-bg ${
              current === s.v ? "text-gx-accent" : "text-gx-text-primary"
            }`}
          >
            <svg width="28" height="12" viewBox="0 0 28 12">
              <line x1="2" y1="6" x2="26" y2="6" stroke="currentColor" strokeWidth="2" strokeDasharray={s.dash} strokeLinecap="round" />
            </svg>
            {s.label}
          </button>
        ))}
      </div>
    </PopoverShell>
  );
}
