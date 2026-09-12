// apps/web/src/features/kb/canvas/canvas-ops.ts
// 画布增强面板的全部写操作。原则：
//  1. 样式一律走 plait 原生 transform（PropertyTransforms / DrawTransforms / TextTransforms），
//     自动进入 plait 撤销栈（Ctrl/Cmd+Z 可撤销），onValueChange 自动触发我方防抖上云。
//  2. 多选生效：所有样式操作对当前选中元素逐个应用，与 Drawnix 自带浮动工具条行为一致。
//  3. 注释/关联等自定义字段通过 Transforms.setNode 走标准 set_node op，同样进撤销栈。
//  4. 只读板不允许调用（UI 层已禁，这里再做一次防御）。

import {
  PlaitBoard,
  Transforms,
  getSelectedElements,
  addSelectedElement,
  clearSelectedElement,
  idCreator,
  toHostPoint,
  toHostPointFromViewBoxPoint,
  toScreenPointFromHostPoint,
  toViewBoxPoint,
  RectangleClient,
  type PlaitElement,
  type Point,
} from "@plait/core";
import { PropertyTransforms } from "@plait/common";
import {
  ArrowLineMarkerType,
  ArrowLineShape,
  DrawTransforms,
  PlaitDrawElement,
  isHitDrawElement,
} from "@plait/draw";
import { TextTransforms, MarkTypes } from "@plait/text-plugins";
import { Alignment } from "@plait/common";
import { ArrowLineHandleKey } from "@plait/draw";
import type { GxDocRef, GxLinkBlock, GxShapeElement } from "./types";
import { isLinkBlock, isMindMapNode } from "./types";

const isReadonly = (board: PlaitBoard) => PlaitBoard.isReadonly(board) === true;

/** 元素级样式：描边颜色（null = 恢复默认） */
export function setStrokeColor(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  PropertyTransforms.setStrokeColor(board, color, { getMemorizeKey: () => "gx" });
}

/** 元素级样式：描边虚实（solid/dashed/dotted），对几何与连线均有效 */
export function setStrokeStyle(board: PlaitBoard, style: "solid" | "dashed" | "dotted") {
  if (isReadonly(board)) return;
  PropertyTransforms.setStrokeStyle(board, style, { getMemorizeKey: () => "gx" });
}

/** 线宽（px，1-12），几何描边与连线共用 */
export function setStrokeWidth(board: PlaitBoard, width: number) {
  if (isReadonly(board)) return;
  const w = Math.min(12, Math.max(1, Math.round(width)));
  PropertyTransforms.setStrokeWidth(board, w, { getMemorizeKey: () => "gx" });
}

/** 填充色（null = 恢复默认填充），仅封闭图形有效（库内部对图片/连线无效） */
export function setFillColor(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  PropertyTransforms.setFillColor(board, color, { getMemorizeKey: () => "gx" });
}

const MARK_MAP = {
  bold: MarkTypes.bold,
  italic: MarkTypes.italic,
  underlined: MarkTypes.underline,
} as const;

/** 文字 marks：粗体/斜体/下划线。作用于当前选中的可编辑节点（多选全部应用） */
export function toggleTextMark(board: PlaitBoard, mark: keyof typeof MARK_MAP) {
  if (isReadonly(board)) return;
  TextTransforms.setTextMarks(board, MARK_MAP[mark]);
}

/** 段落对齐：left/center/right */
export function setTextAlign(board: PlaitBoard, align: "left" | "center" | "right") {
  if (isReadonly(board)) return;
  TextTransforms.setTextAlign(board, Alignment[align]);
}

/** 文字颜色：null = 恢复默认色 */
export function setTextColor(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  TextTransforms.setTextColor(board, color);
}

/** 箭头连线形态：直线/曲线/折线（折线即"紧凑"的正交路由；直线/曲线为圆滑走向） */
export function setArrowShape(board: PlaitBoard, shape: "straight" | "curve" | "elbow") {
  if (isReadonly(board)) return;
  DrawTransforms.setArrowLineShape(board, { shape: ArrowLineShape[shape] });
}

/**
 * 箭头端点样式。
 * @param end source=起点 / target=终点
 */
export function setArrowMarker(
  board: PlaitBoard,
  end: "source" | "target",
  marker: ArrowLineMarkerType,
) {
  if (isReadonly(board)) return;
  DrawTransforms.setArrowLineMark(board, ArrowLineHandleKey[end], marker);
}

/**
 * F3: 流程图分支线独立样式（颜色/线宽/线型/形态）
 * 复用通用 PropertyTransforms，因为这些字段名与普通连线一致；多选自动逐个应用。
 * 形态仅对 arrow-line 有效，vector-line 跳过形态。
 */
export function setBranchLineStyle(
  board: PlaitBoard,
  opts: {
    stroke?: string | null;
    strokeWidth?: number;
    strokeStyle?: "solid" | "dashed" | "dotted";
    shape?: "straight" | "curve" | "elbow";
  },
) {
  if (isReadonly(board)) return;
  if (opts.stroke !== undefined) setStrokeColor(board, opts.stroke);
  if (opts.strokeWidth !== undefined) setStrokeWidth(board, opts.strokeWidth);
  if (opts.strokeStyle !== undefined) setStrokeStyle(board, opts.strokeStyle);
  if (opts.shape !== undefined) setArrowShape(board, opts.shape);
}

/** F5: 思维导图节点切换形状（圆角矩形 / 下划线）
 * 修复 #4-P0：原占位写入不存在的 gxMindShape 自定义字段，枚举值也错（mind-topic/mind-branch）。
 * 正确做法：通过 PropertyTransforms.setProperty + match 过滤器写入 plait 原生 shape 字段，
 * 枚举值对齐 @plait/mind 0.89.2 MindElementShape ("round-rectangle" | "underline")。
 */
export function setMindMapShape(
  board: PlaitBoard,
  shape: "round-rectangle" | "underline",
) {
  if (isReadonly(board)) return;
  PropertyTransforms.setProperty(
    board,
    { shape } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-shape" },
  );
}

/** F5: 思维导图节点填充色 — 走 plait 原生 fill */
export function setMindMapNodeFill(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  setFillColor(board, color);
}

/** F5: 思维导图节点文字色 — 走 plait 原生 text marks */
export function setMindMapTextColor(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  setTextColor(board, color);
}

/** F5: 思维导图节点描边色（仅作用于 mind 节点） */
export function setMindMapStrokeColor(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  PropertyTransforms.setProperty(
    board,
    { strokeColor: color } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-stroke-color" },
  );
}

/** F5: 思维导图节点描边宽度 */
export function setMindMapStrokeWidth(board: PlaitBoard, width: number) {
  if (isReadonly(board)) return;
  const w = Math.min(12, Math.max(1, Math.round(width)));
  PropertyTransforms.setProperty(
    board,
    { strokeWidth: w } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-stroke-width" },
  );
}

/** F5: 思维导图节点描边线型 */
export function setMindMapStrokeStyle(board: PlaitBoard, style: "solid" | "dashed" | "dotted") {
  if (isReadonly(board)) return;
  PropertyTransforms.setProperty(
    board,
    { strokeStyle: style } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-stroke-style" },
  );
}

/** F5: 思维导图分支线颜色（挂在节点自身 branchColor 字段） */
export function setMindMapBranchColor(board: PlaitBoard, color: string | null) {
  if (isReadonly(board)) return;
  PropertyTransforms.setProperty(
    board,
    { branchColor: color } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-branch-color" },
  );
}

/** F5: 思维导图分支线宽度 */
export function setMindMapBranchWidth(board: PlaitBoard, width: number) {
  if (isReadonly(board)) return;
  const w = Math.min(12, Math.max(1, Math.round(width)));
  PropertyTransforms.setProperty(
    board,
    { branchWidth: w } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-branch-width" },
  );
}

/** F5: 思维导图分支线形态（贝塞尔/折线） */
export function setMindMapBranchShape(
  board: PlaitBoard,
  shape: "bight" | "polyline",
) {
  if (isReadonly(board)) return;
  PropertyTransforms.setProperty(
    board,
    { branchShape: shape } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-branch-shape" },
  );
}

/** F5: 思维导图布局方向（右/左/上下/双侧） */
export function setMindMapLayout(
  board: PlaitBoard,
  layout: "right" | "left" | "upward" | "downward" | "standard",
) {
  if (isReadonly(board)) return;
  PropertyTransforms.setProperty(
    board,
    { layout } as unknown as Record<string, unknown>,
    { match: isMindMapNode, getMemorizeKey: () => "gx-mind-layout" },
  );
}

/** 读当前选中元素的汇总样式（用于面板初始高亮；多选取首个元素的状态）
 * 修复 #4-P0：原代码仅认 draw 元素（geometry/arrow-line/vector-line），mind 节点被过滤后整个返回 null，
 * 导致 NodeStyleBar.tsx:107 早返回 → 思维导图样式条根本不渲染。改为三类都认。
 */
export function readSelectionStyle(board: PlaitBoard): CanvasSelectionStyle | null {
  const els = getSelectedElements(board);
  const shape = els.find((e) => PlaitDrawElement.isGeometry(e)) as GxShapeElement | undefined;
  const line = els.find((e) => PlaitDrawElement.isArrowLine(e) || PlaitDrawElement.isVectorLine(e)) as
    | (PlaitElement & { shape?: string; source?: { marker?: string }; target?: { marker?: string } })
    | undefined;
  const mind = els.find(isMindMapNode) as
    | (PlaitElement & {
        fill?: string;
        strokeColor?: string;
        strokeWidth?: number;
        strokeStyle?: string;
        shape?: "round-rectangle" | "underline";
        branchColor?: string;
        branchWidth?: number;
        branchShape?: "bight" | "polyline";
        layout?: "right" | "left" | "upward" | "downward" | "standard";
      })
    | undefined;
  if (!shape && !line && !mind) return null;
  const fill = (shape?.fill as string) ?? (mind?.fill as string) ?? null;
  const strokeColor =
    (shape?.strokeColor as string) ?? (line?.strokeColor as string) ?? (mind?.strokeColor as string) ?? null;
  const strokeWidth =
    (shape?.strokeWidth as number) ?? (line?.strokeWidth as number) ?? (mind?.strokeWidth as number) ?? 2;
  const strokeStyle =
    (shape?.strokeStyle as string) ?? (line?.strokeStyle as string) ?? (mind?.strokeStyle as string) ?? "solid";
  return {
    strokeColor,
    strokeWidth,
    strokeStyle,
    fill,
    lineShape: line?.shape ?? null,
    sourceMarker: line?.source?.marker ?? ArrowLineMarkerType.none,
    targetMarker: line?.target?.marker ?? ArrowLineMarkerType.arrow,
    // 思维导图专属字段（兼容 line 不存在场景）
    mindShape: mind?.shape ?? null,
    mindBranchColor: mind?.branchColor ?? null,
    mindBranchWidth: mind?.branchWidth ?? null,
    mindBranchShape: mind?.branchShape ?? null,
    mindLayout: mind?.layout ?? null,
  };
}

export interface CanvasSelectionStyle {
  strokeColor: string | null;
  strokeWidth: number;
  strokeStyle: string;
  fill: string | null;
  lineShape: string | null;
  sourceMarker: string;
  targetMarker: string;
  // 思维导图专属字段（readSelectionStyle 在仅 mind 选中时填充）
  mindShape: "round-rectangle" | "underline" | null;
  mindBranchColor: string | null;
  mindBranchWidth: number | null;
  mindBranchShape: "bight" | "polyline" | null;
  mindLayout: "right" | "left" | "upward" | "downward" | "standard" | null;
}

// ---------- 自定义字段：注释 / 关联文档（走标准 set_node，进撤销栈） ----------

export function setElementNote(board: PlaitBoard, element: PlaitElement, note: string) {
  if (isReadonly(board)) return;
  const path = PlaitBoard.findPath(board, element);
  const value = note.trim();
  Transforms.setNode(board, value ? { gxNote: value } : { gxNote: null }, path);
}

export function setElementDocRef(board: PlaitBoard, element: PlaitElement, ref: GxDocRef | null) {
  if (isReadonly(board)) return;
  const path = PlaitBoard.findPath(board, element);
  // null 显式写入以便 normalize 清字段；读取时按空值处理
  Transforms.setNode(board, { gxDocRef: ref }, path);
}

export function readElementNote(element: PlaitElement): string {
  return typeof element.gxNote === "string" ? element.gxNote : "";
}

export function readElementDocRef(element: PlaitElement): GxDocRef | null {
  const v = element.gxDocRef;
  if (v && typeof v === "object" && typeof v.docId === "string") return v as GxDocRef;
  return null;
}

/**
 * 在指定几何节点内部中心插入一张图片（#117：与全局插图同一 DrawTransforms.insertImage 落点，
 * 但位置取被选中节点的包围盒中心，视觉等同"贴在节点上"）。
 * 图片是 plait 原生 image 元素（独立节点、可再拖拽/缩放/删除），与全局插图数据完全一致，
 * 因此撤销重做、保存、导出行为零差异。
 */
export function insertImageIntoShape(
  board: PlaitBoard,
  shape: GxShapeElement,
  image: { url: string; width: number; height: number },
) {
  if (isReadonly(board)) return;
  const rect = board.getRectangle(shape);
  if (!rect) {
    DrawTransforms.insertImage(board, image);
    return;
  }
  // 图片不超过节点 80% 尺寸，保持比例
  const maxW = rect.width * 0.8;
  const ratio = image.width > maxW ? maxW / image.width : 1;
  const w = image.width * ratio;
  const h = image.height * ratio;
  const startPoint: [number, number] = [rect.x + (rect.width - w) / 2, rect.y + (rect.height - h) / 2];
  DrawTransforms.insertImage(board, image, startPoint);
}

/* ============ F4: 直接插入式关联块 ============
 * 用 plait 原生 geometry rectangle 承载——plait 的 GeometryComponent 会渲染矩形 + 自带选中/拖拽/缩放手柄。
 * 视觉由 GxLinkBlockView overlay 覆盖；filter 通过 gxLinkRef 字段识别。
 */

/** F4: 在画布插入一个关联块（实际是 geometry rectangle + gxLinkRef 字段）
 * 选项：
 *   - x/y：显式坐标；提供时按坐标插入（不影响级联）
 *   - cascade=true 且未提供坐标：按当前 link-block 数量 * 24 偏移，自动落在视图原点附近
 */
export function insertLinkBlock(
  board: PlaitBoard,
  ref: GxDocRef,
  options?: { x?: number; y?: number; cascade?: boolean },
): string {
  if (isReadonly(board)) return "";
  const w = 280;
  const h = 160;
  const linkCount = board.children.filter(isLinkBlock).length;
  // 计算坐标
  let x = options?.x;
  let y = options?.y;
  if ((x === undefined || y === undefined) && options?.cascade) {
    // 2026-09-12 统一网格定位（含空画布首张卡）：
    // 历史问题——
    //   1) 旧级联每插一个 +(n%8)*40 无上限，连插数张后卡全叠在一起（偏移 30-40px
    //      远小于卡高 160px），用户只看到一张"空白卡"；
    //   2) 空画布首张走 vp.origination+400/300 猜测，plait 自动平移后 origination
    //      指向任意位置，首张卡常飘到视口右下边缘被裁切（实测屏幕 1240,774）。
    // 现方案：不区分首张/后续，所有卡一律直接排进【可见区域】内的 3 列 × 2 行
    // 网格（间距 40px），按当前已有 link-block 数量取格；超过 6 张后每轮整体
    // 偏移 60px（露出约 100px 卡身，第 7 张不与第 1 张完全重合）。坐标经
    // screen→viewBox 反算，自动消化缩放/平移。
    const existing = board.children.filter(isLinkBlock);
    const cols = 3;
    const rows = 2;
    const gap = 40;
    const cycleShift = 60;
    const cellsPerCycle = cols * rows;
    const margin = 40;
    const gridW = cols * w + (cols - 1) * gap; // 920
    const gridH = rows * h + (rows - 1) * gap; // 360
    let placed = false;
    try {
      const hostRect = PlaitBoard.getHost(board)?.getBoundingClientRect?.();
      const visL = Math.max(hostRect?.left ?? 0, 0);
      const visT = Math.max(hostRect?.top ?? 0, 0);
      const visR = Math.min(hostRect?.right ?? window.innerWidth, window.innerWidth);
      const visB = Math.min(hostRect?.bottom ?? window.innerHeight, window.innerHeight);
      // 可见区放得下整张网格 → 网格水平/垂直居中；放不下（窗口过窄）→ 从可见区
      // 左上角留 margin 起排，至少保证首张卡完整可见。
      const hasRoom = visR - visL >= gridW + margin * 2 && visB - visT >= gridH + margin * 2;
      const gridLeft = hasRoom ? (visL + visR) / 2 - gridW / 2 : visL + margin;
      const gridTop = hasRoom ? (visT + visB) / 2 - gridH / 2 : visT + margin;
      const cycleCount = Math.floor(existing.length / cellsPerCycle);
      const cellIndex = existing.length % cellsPerCycle;
      const col = cellIndex % cols;
      const row = Math.floor(cellIndex / cols);
      const cx = gridLeft + col * (w + gap) + cycleCount * cycleShift;
      const cy = gridTop + row * (h + gap) + cycleCount * cycleShift;
      const [vx, vy] = toViewBoxPoint(board, toHostPoint(board, cx, cy));
      x = vx;
      y = vy;
      placed = true;
    } catch {
      // 坐标换算失败，下方兜底
    }
    if (!placed) {
      // 兜底：viewport 中心（screen→viewBox），不再使用不可靠的 vp.origination
      try {
        const [vx, vy] = toViewBoxPoint(
          board,
          toHostPoint(board, window.innerWidth / 2, window.innerHeight / 2),
        );
        x = vx - w / 2;
        y = vy - h / 2;
      } catch {
        x = 0;
        y = 0;
      }
    }
  }
  if (x === undefined || y === undefined) return "";
  // ref 上自动写 order 字段（便于后续排序/审计）
  const refWithOrder: GxDocRef = { ...ref, order: ref.order ?? linkCount };
  const element: GxLinkBlock = {
    id: idCreator(),
    type: "geometry",
    shape: "rectangle",
    points: [
      [x, y],
      [x + w, y + h],
    ],
    gxLinkRef: refWithOrder,
    fill: "transparent",
    strokeColor: "transparent",
    updatedAt: new Date().toISOString(),
  };
  // 路径 = [children.length] 表示末尾追加
  Transforms.insertNode(board, element, [board.children.length]);
  return element.id;
}

/** F4: 更新关联块的 ref（换关联目标） */
export function updateLinkBlockRef(board: PlaitBoard, element: GxLinkBlock, ref: GxDocRef) {
  if (isReadonly(board)) return;
  const path = PlaitBoard.findPath(board, element);
  Transforms.setNode(board, { gxLinkRef: ref, updatedAt: new Date().toISOString() } as unknown as Partial<GxLinkBlock>, path);
}

/** F4: 调整关联块尺寸（直接改 points，与 plait geometry 一致） */
export function resizeLinkBlock(board: PlaitBoard, element: GxLinkBlock, width: number, height: number) {
  if (isReadonly(board)) return;
  // 最小 200×120，最大 600×400
  const w = Math.min(600, Math.max(200, width));
  const h = Math.min(400, Math.max(120, height));
  const path = PlaitBoard.findPath(board, element);
  const [p1] = element.points;
  const newPoints: [Point, Point] = [
    p1,
    [p1[0] + w, p1[1] + h],
  ];
  Transforms.setNode(board, { points: newPoints } as unknown as Partial<GxLinkBlock>, path);
}

/**
 * 屏幕像素增量 → viewBox 坐标增量（用于 overlay 拖拽）。
 * plait 链路：screen(client) --toHostPoint--> host(宿主像素) --toViewBoxPoint--> viewBox。
 * 对同一起点取位移差，自动消化当前缩放与平移；平移时 host→viewBox 为线性，结果精确。
 */
export function screenDeltaToViewBox(
  board: PlaitBoard,
  fromScreen: { x: number; y: number },
  toScreen: { x: number; y: number },
): { dx: number; dy: number } {
  const a = toViewBoxPoint(board, toHostPoint(board, fromScreen.x, fromScreen.y));
  const b = toViewBoxPoint(board, toHostPoint(board, toScreen.x, toScreen.y));
  return { dx: b[0] - a[0], dy: b[1] - a[1] };
}

/**
 * F4: 移动关联块（header 拖拽）。按 viewBox 位移平移两点，保持宽高。
 * 走标准 set_node op，进 plait 撤销栈、触发 onValueChange 自动上云。
 */
export function moveLinkBlock(board: PlaitBoard, element: GxLinkBlock, dx: number, dy: number) {
  if (isReadonly(board)) return;
  if (!dx && !dy) return;
  const path = PlaitBoard.findPath(board, element);
  const [p1, p2] = element.points;
  const newPoints: [Point, Point] = [
    [p1[0] + dx, p1[1] + dy],
    [p2[0] + dx, p2[1] + dy],
  ];
  Transforms.setNode(board, { points: newPoints, updatedAt: new Date().toISOString() } as unknown as Partial<GxLinkBlock>, path);
}

/** F4: 删除关联块 */
export function removeLinkBlock(board: PlaitBoard, element: GxLinkBlock) {
  if (isReadonly(board)) return;
  const path = PlaitBoard.findPath(board, element);
  Transforms.removeNode(board, path);
}

/** F4: 设置关联块本地重命名（覆盖源标题，画布块标题旁 edit 图标触发） */
export function setLinkBlockDisplayTitle(
  board: PlaitBoard,
  element: GxLinkBlock,
  displayTitle: string | null,
) {
  if (isReadonly(board)) return;
  const path = PlaitBoard.findPath(board, element);
  const next = displayTitle && displayTitle.trim() ? displayTitle.trim() : null;
  Transforms.setNode(
    board,
    { gxLinkRef: { ...element.gxLinkRef, displayTitle: next ?? undefined } } as unknown as Partial<GxLinkBlock>,
    path,
  );
}

/** F4: 切换关联块预览密度（完整/极简） */
export function setLinkBlockPreviewType(
  board: PlaitBoard,
  element: GxLinkBlock,
  previewType: "full" | "minimal",
) {
  if (isReadonly(board)) return;
  const path = PlaitBoard.findPath(board, element);
  Transforms.setNode(
    board,
    { gxLinkRef: { ...element.gxLinkRef, previewType } } as unknown as Partial<GxLinkBlock>,
    path,
  );
}

/** 供面板 key 复用：plait 节点 id 生成器 */
export { idCreator };

// ==================== 图层（z-order）管理 ====================
// 画布内所有顶层对象（基础几何、思维导图整体、嵌入的关联文档/画布块、文字、箭头/线条、图片）
// 在 board.children 中是兄弟节点，渲染顺序即数组顺序。四种重排统一走 plait 内置
// ZIndexTransforms（Transforms.moveUp/moveDown/moveToTop/moveToBottom）——直接重排 board.children，
// 自动进入撤销栈（⌘Z 可撤销）、触发 onValueChange 自动上云，且不区分元素类型（无类型白名单），
// 因此对我们自定义的 gxLinkRef 关联块同样生效。
// 注意：思维导图子节点嵌在根 mind 元素的 children 里（非顶层），不允许单独调层级——选中根脑图
// 调整的是整张脑图，这与 drawnix/plait canSetZIndex 的语义一致。

export type ZOrderAction = "forward" | "backward" | "front" | "back";

/** 选中元素中，可参与重排的顶层元素（board.canSetZIndex 默认恒 true）。 */
function reorderableSelection(board: PlaitBoard): PlaitElement[] {
  return getSelectedElements(board).filter((el) => {
    try {
      return typeof board.canSetZIndex === "function" ? board.canSetZIndex(el) : true;
    } catch {
      return false;
    }
  });
}

/** 当前选区是否存在可调整图层的对象（用于禁用菜单项/按钮）。 */
export function canApplyZOrder(board: PlaitBoard | null): boolean {
  if (!board || isReadonly(board)) return false;
  try {
    return reorderableSelection(board).length > 0;
  } catch {
    return false;
  }
}

/**
 * 执行四选一重排。返回是否真正发生了位置变化（已到顶/底时为 false，供 toast 反馈）。
 * 多选时整体移动，行为对齐 drawnix 原生命令。
 */
export function applyZOrder(board: PlaitBoard, action: ZOrderAction): boolean {
  if (isReadonly(board)) return false;
  const before = reorderableSelection(board)
    .map((el) => board.children.indexOf(el))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (before.length === 0) return false;

  switch (action) {
    case "forward":
      Transforms.moveUp(board);
      break;
    case "backward":
      Transforms.moveDown(board);
      break;
    case "front":
      Transforms.moveToTop(board);
      break;
    case "back":
      Transforms.moveToBottom(board);
      break;
  }

  const after = reorderableSelection(board)
    .map((el) => board.children.indexOf(el))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  return before.join(",") !== after.join(",");
}

/**
 * 单个【顶层】元素在给定 viewBox 点是否命中。与元素类型无关、可扩展：
 *  - draw 元素（几何/图片/箭头/矢量线/text）走库的非严格 isHitDrawElement：
 *    空心/透明封闭框【内部】也算命中（非严格关掉了"空文本且未填充直接 false"），
 *    线走精确距离判定；
 *  - 思维导图根（mind）及任何未被 draw 判定覆盖的元素：退回包围盒包含判定。
 * 注意：这里只回答"该顶层元素是否覆盖此点"，不做"多个命中者里选谁"的裁决——
 * 叠序裁决统一在 hitTopElementAtPoint 内按 board.children 顺序处理。
 */
function isTopElementHitAt(board: PlaitBoard, el: PlaitElement, vb: Point): boolean {
  // draw 家族（geometry/image/arrow-line/vector-line/text）
  try {
    if (
      PlaitDrawElement.isGeometry(el) ||
      PlaitDrawElement.isImage(el) ||
      PlaitDrawElement.isArrowLine(el) ||
      PlaitDrawElement.isVectorLine(el) ||
      PlaitDrawElement.isText(el)
    ) {
      const r = isHitDrawElement(board, el, vb, false);
      if (r === true) return true;
      // null/undefined = draw 不认识该类型 → 落到包围盒兜底；false = draw 明确判否
      if (r === false) return false;
    }
  } catch {
    /* 判定异常 → 走包围盒兜底 */
  }
  // 脑图根 / 自定义 / draw 未覆盖：用整体包围盒命中
  try {
    const rect = board.getRectangle(el);
    if (rect) return RectangleClient.isPointInRectangle(rect, vb);
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 纯图层叠序命中：从【最上层】（board.children 末尾）向前找第一个覆盖该点的顶层元素。
 *
 * 为什么不用库的 getHitElementByPoint / board.getOneHitElement：
 * @plait/draw 的 getHitDrawElement 裁决偏向【类型】而非【叠序】——它先截到"第一个
 * 已填充封闭元素"，再在其之前挑 text/line/image，最后按面积排序。于是当一个空心/透明
 * 描边框或关联卡（承载几何 fill/stroke=transparent，视觉却是不透明 HTML 卡）压在一个
 * 有填充的框之上时，在二者重叠内部右键，库会选到下层的填充框，导致用户对"看得见但没被
 * 选中"的上层框置顶时作用到错误对象（toast 误报"已在最顶层"）。
 *
 * 这里改为符合 Photoshop 图层心智的唯一真源：board.children 数组顺序即叠放顺序，
 * 在所有覆盖该点的顶层兄弟中取索引最大者。对几何/文字/图片/箭头/矢量线/思维导图整体/
 * 关联块统一生效；新增顶层元素类型只需让 isTopElementHitAt 能判定即可。
 */
export function hitTopElementAtPoint(board: PlaitBoard, clientX: number, clientY: number): PlaitElement | null {
  const vb = toViewBoxPoint(board, toHostPoint(board, clientX, clientY));
  for (let i = board.children.length - 1; i >= 0; i--) {
    const el = board.children[i];
    if (!el) continue;
    if (isTopElementHitAt(board, el, vb)) return el;
  }
  return null;
}

/**
 * 统一读取 plait【实时选区】（BOARD_TO_SELECTED_ELEMENT WeakMap）——画布右键菜单与样式
 * 面板共用的唯一真源。PropertyTransforms.setProperty / applyZOrder / canApplyZOrder /
 * readSelectionStyle 底层都读它；React 的 rt.selectedIds 只是驱动重渲染的"版本号快照"，
 * 不得作为样式面板元素集或可操作对象的判定依据（否则右键只改 WeakMap、不发 op/onChange 时，
 * 快照滞后会让面板"看着操作 A、实际写到 B"）。
 */
export function currentSelectedElements(board: PlaitBoard | null): PlaitElement[] {
  if (!board) return [];
  try {
    return getSelectedElements(board);
  } catch {
    return [];
  }
}

/**
 * 右键命中测试：把浏览器视口坐标换算到 viewBox，命中【视觉最上层】的一个顶层对象后把它
 * 设为唯一选区，返回命中元素；点空白（无对象）返回 null（选区交由 plait 默认的"清空选区"
 * 逻辑处理）。已在当前多选中的元素不打断原多选（便于右键批量图层操作）。
 */
export function selectElementAtClientPoint(
  board: PlaitBoard,
  clientX: number,
  clientY: number,
): PlaitElement | null {
  if (isReadonly(board)) return null;
  // 关联卡渲染在元素 geom <g> 同层紧随位置的补偿 <g> 内的 foreignObject（统一层级 +
  // WebKit 白卡修复），右键事件目标是卡片 HTML；其承载矩形 fill/stroke 均为 transparent，
  // 几何命中不稳定。因此先按命中点找 [data-gx-link-fo]，用 FO 上记录的 data-gx-element-id
  // 选中该关联块。
  const linked = selectLinkBlockAtPoint(board, clientX, clientY);
  if (linked) return linked;
  const topHit = hitTopElementAtPoint(board, clientX, clientY);
  if (!topHit) return null;
  if (!reorderableSelection(board).includes(topHit)) {
    clearSelectedElement(board);
    addSelectedElement(board, topHit);
  }
  return topHit;
}

/**
 * 命中点若落在关联卡 foreignObject 上，按其宿主元素 <g> 的 plait-data-id 找到
 * board.children 中的关联块并设为唯一选区，返回它；否则返回 null。
 */
export function selectLinkBlockAtPoint(
  board: PlaitBoard,
  clientX: number,
  clientY: number,
): PlaitElement | null {
  if (isReadonly(board)) return null;
  let target: Element | null = null;
  try {
    target = document.elementFromPoint(clientX, clientY);
  } catch {
    target = null;
  }
  const fo = target?.closest?.("[data-gx-link-fo]") as Element | null;
  if (!fo) return null;
  // 优先用 FO 自身记录的元素 id（拖拽期 FO 在 element-top-host，其父 g 无 plait-data-id）
  const id =
    fo.getAttribute?.("data-gx-element-id") ||
    fo.parentElement?.getAttribute?.("plait-data-id");
  if (!id) return null;
  const el = board.children.find((candidate) => candidate.id === id);
  if (!el) return null;
  clearSelectedElement(board);
  addSelectedElement(board, el);
  return el;
}

