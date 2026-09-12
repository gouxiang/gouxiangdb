// apps/web/src/features/kb/canvas/canvas-context.tsx
// 画布增强层的运行时上下文：持有 PlaitBoard 实例、当前帧号（驱动 overlay 重定位）、
// 选中元素快照（只保留 id，具体元素每帧从 board.children 按 id 解析，避免拿到移动中的陈旧引用）。
//
// overlay 定位原理：plait 画布是带 viewBox 的 SVG，节点坐标是 viewBox 坐标。
//  toHostPointFromViewBoxPoint: viewBox -> SVG 宿主像素
//  toScreenPointFromHostPoint:  宿主像素 -> 浏览器视口像素
// 二者组合即可把元素包围盒换算为 fixed 定位矩形；平移/缩放/拖节点都会改 board 状态，
// 由 DrawnixCanvas 透传的 onChange（BoardChangeData：children/selection/viewport 任一变化）
// 驱动 notify 重算（rAF 合帧，不侵入库、不覆盖 board 内部钩子）。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  PlaitBoard,
  RectangleClient,
  getElementById,
  getSelectedElements,
  toHostPointFromViewBoxPoint,
  toScreenPointFromHostPoint,
  type PlaitElement,
} from "@plait/core";

export interface CanvasEnhanceContextValue {
  /** 画布所属知识库 id（内部页有；公开分享页可能无） */
  kbId?: string;
  /** 公开分享 token；存在时文档拉取/保存走匿名 PublicApi */
  publicToken?: string;
  /** 当前画布自身的文档 id（用于关联选择器排除"把当前画布关联给自己"） */
  currentDocId?: string;
  /** 当前用户是否可编辑（决定面板/编辑入口是否出现） */
  canEdit: boolean;
}

export interface CanvasRuntimeHandles {
  /** board 任意变更（children/selection/viewport）时调用，rAF 合帧重定位 overlay */
  notify: () => void;
  /** 立即同步当前命中元素 id 列表（选中命令写完后调用） */
  syncSelection: () => void;
}

/** 画布裁剪层（overlay 容器）相对浏览器视口的几何；浮层据此换算"画布框本地坐标" */
export interface CanvasViewport {
  /** 裁剪层左上角在浏览器视口中的坐标 */
  origin: { x: number; y: number };
  width: number;
  height: number;
}

interface CanvasRuntime {
  board: PlaitBoard | null;
  /** overlay 层 portal 目标（.kb-canvas-overlay 裁剪层） */
  container: HTMLElement | null;
  frame: number;
  selectedIds: string[];
  /** 裁剪层视口几何（每帧 / ResizeObserver 刷新） */
  viewport: CanvasViewport;
  ctx: CanvasEnhanceContextValue;
  notify: () => void;
  refreshSelection: () => void;
  /** 浏览器视口坐标 -> 画布框本地坐标（减去裁剪层原点） */
  toLocalX: (clientX: number) => number;
  toLocalY: (clientY: number) => number;
  /** 元素浏览器视口包围盒 -> 裁剪层本地包围盒（元素消失/无几何时 null） */
  getLocalRect: (el: PlaitElement) => ScreenRect | null;
}

/** 浮层在裁剪层内的钳制边界（四周留 gap 像素安全边距） */
export interface ClampBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const CanvasBoardContext = createContext<CanvasRuntime | null>(null);

export function CanvasBoardProvider({
  board,
  container,
  ctx,
  onHandles,
  children,
}: {
  board: PlaitBoard | null;
  container: HTMLElement | null;
  ctx: CanvasEnhanceContextValue;
  /** 把事件入口回传给 DrawnixCanvas，供其接到 Drawnix 的 onChange 回调 */
  onHandles?: (h: CanvasRuntimeHandles) => void;
  children: ReactNode;
}) {
  const [frame, setFrame] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewport, setViewport] = useState<CanvasViewport>({ origin: { x: 0, y: 0 }, width: 0, height: 0 });
  const rafRef = useRef(0);
  const boardRef = useRef(board);
  boardRef.current = board;
  const containerRef = useRef<HTMLElement | null>(container);
  containerRef.current = container;

  // 测量裁剪层（overlay 容器）相对浏览器视口的几何。
  // 浮层定位从"浏览器视口系"改到"画布框本地系"后，需要该原点做减法、用容器宽高做钳制，
  // 这样嵌套在弹窗/分栏里的小画布，浮层不会再溢出到它所在框体之外。
  const measureViewport = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewport((prev) => {
      const next = { origin: { x: r.left, y: r.top }, width: r.width, height: r.height };
      if (
        prev.origin.x === next.origin.x &&
        prev.origin.y === next.origin.y &&
        prev.width === next.width &&
        prev.height === next.height
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const syncSelection = () => {
    const b = boardRef.current;
    if (!b) return;
    let ids: string[] = [];
    try {
      ids = getSelectedElements(b).map((e) => e.id);
    } catch {
      ids = [];
    }
    setSelectedIds((prev) => (prev.join() === ids.join() ? prev : ids));
  };

  const notify = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      syncSelection();
      measureViewport();
      setFrame((f) => f + 1);
    });
  };

  useEffect(() => {
    onHandles?.({ notify, syncSelection });
    // board 就绪时首帧定位
    if (board) {
      syncSelection();
      measureViewport();
      const id = requestAnimationFrame(() => setFrame((f) => f + 1));
      return () => cancelAnimationFrame(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  // 容器出现 / 尺寸变化（弹窗动画、分栏拖拽、窗口缩放）时刷新视口几何
  useEffect(() => {
    measureViewport();
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureViewport());
    ro.observe(container);
    window.addEventListener("resize", measureViewport);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measureViewport);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const toLocalX = useCallback((clientX: number) => clientX - viewport.origin.x, [viewport.origin.x]);
  const toLocalY = useCallback((clientY: number) => clientY - viewport.origin.y, [viewport.origin.y]);

  // 元素包围盒从浏览器视口系换算到裁剪层本地系（供浮层用 absolute 定位）
  const getLocalRect = useCallback(
    (el: PlaitElement): ScreenRect | null => {
      const b = boardRef.current;
      if (!b) return null;
      const screen = getElementScreenRect(b, el);
      if (!screen) return null;
      return {
        x: screen.x - viewport.origin.x,
        y: screen.y - viewport.origin.y,
        width: screen.width,
        height: screen.height,
      };
    },
    [viewport.origin.x, viewport.origin.y],
  );

  const value = useMemo<CanvasRuntime>(
    () => ({
      board,
      container,
      frame,
      selectedIds,
      viewport,
      ctx,
      notify,
      refreshSelection: syncSelection,
      toLocalX,
      toLocalY,
      getLocalRect,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, container, frame, selectedIds, viewport, ctx, toLocalX, toLocalY, getLocalRect],
  );

  return <CanvasBoardContext.Provider value={value}>{children}</CanvasBoardContext.Provider>;
}

export function useCanvasBoard(): CanvasRuntime | null {
  return useContext(CanvasBoardContext);
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function viewBoxRectToScreen(board: PlaitBoard, rect: RectangleClient): ScreenRect {
  const [x, y] = toScreenPointFromHostPoint(
    board,
    toHostPointFromViewBoxPoint(board, [rect.x, rect.y]),
  );
  const [x2, y2] = toScreenPointFromHostPoint(
    board,
    toHostPointFromViewBoxPoint(board, [rect.x + rect.width, rect.y + rect.height]),
  );
  return { x, y, width: x2 - x, height: y2 - y };
}

/** 按 id 从最新 board.children 解析元素（每帧调用，避免陈旧引用） */
export function resolveElement(board: PlaitBoard | null, id: string): PlaitElement | null {
  if (!board) return null;
  return getElementById(board, id) ?? null;
}

/** 元素当前的屏幕包围盒；元素消失/未挂载时返回 null */
export function getElementScreenRect(board: PlaitBoard, el: PlaitElement): ScreenRect | null {
  const rect = board.getRectangle(el);
  if (!rect) return null;
  return viewBoxRectToScreen(board, rect);
}

/**
 * 把增强 overlay 内容 portal 到画布外层容器。
 *
 * 包裹层 `.kb-canvas-overlay` 是 absolute inset-0 + overflow:hidden 的【裁剪层 / 包含块】：
 *  - 内部所有浮层统一用 absolute + 画布框本地坐标（见 viewport/toLocalX/toLocalY），
 *    不再用浏览器视口系的 fixed —— 画布嵌在弹窗、分栏等较小框体时，浮层不会溢出框外；
 *  - overflow:hidden 是硬裁剪兜底：任何漏网的越界像素都被裁在画布可视区内；
 *  - pointer-events:none 保证裁剪层本身不挡画布平移/缩放，交互性子浮层自行 pointer-events:auto。
 * 全屏编辑弹窗（EditorModal/CanvasEditModal/DocEditModal）仍 portal 到 document.body，不受此裁剪。
 */
export function CanvasOverlayLayer({ children }: { children: ReactNode }) {
  const rt = useCanvasBoard();
  if (!rt?.container) return null;
  // 挂 plait 官方的"画布附着元素"类：plait 选区插件在 globalPointerUp 中若发现抬手目标
  // 命中 .plait-board-attached，就不会执行"点空白清空选区"。自带浮动工具条/缩放条都挂这个类。
  // 这样点样式条/色板/预览卡既不会清空节点选区，也无需拦截事件（React onClick 正常触发）。
  //
  // data-gx-overlay 是我方增强层的专属标记：只读"允许查看交互"模式下，DrawnixCanvas 会在
  // 容器捕获阶段拦截结构编辑手势，但必须放行本层内的角标/预览卡（否则公开分享页角标点不开）。
  // 不直接用 .plait-board-attached 作为放行依据，以免误放 plait 自带的浮动控件。
  return createPortal(
    <div className="kb-canvas-overlay plait-board-attached" data-gx-overlay="1">
      {children}
    </div>,
    rt.container,
  );
}

/**
 * 把浮层左上角钳制在画布裁剪层边界内（四周留 gap 像素安全边距）。
 * 入参 x/y 已是【裁剪层本地坐标】。浮层比裁剪层还宽/高时退化为贴边（max 不小于 gap）。
 */
export function clampToViewport(
  vp: CanvasViewport,
  x: number,
  y: number,
  w: number,
  h: number,
  gap = 8,
): { x: number; y: number } {
  const maxX = Math.max(gap, vp.width - w - gap);
  const maxY = Math.max(gap, vp.height - h - gap);
  return {
    x: Math.min(Math.max(gap, x), maxX),
    y: Math.min(Math.max(gap, y), maxY),
  };
}
