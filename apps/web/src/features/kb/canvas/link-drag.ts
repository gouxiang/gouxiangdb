// apps/web/src/features/kb/canvas/link-drag.ts
// 关联块拖拽的「逐帧写 plait」通道（P0-②：连接线不实时跟随）。
//
// 原行为：拖拽期间只写组件本地 dragVb 驱动 foreignObject（卡片视觉），plait 上的几何
// （连线/锚点矩形）绑在原 element.points 上全程不动，松手才 moveLinkBlock 一次落库 ——
// 于是拖拽过程中连接线与卡片是脱开的，看起来"线不跟着走"。
//
// 新行为：拖拽期间每一帧把「起始点 + 本次总位移」写进 plait，几何与卡片都由同一份
// board.children 驱动，天然同步；整段拖拽合并为**一个撤销批次**（首帧 withNewBatch、
// 后续帧 withMerging），松手时用 pointerup 坐标再写一次收尾（仍并入同一批次）——
// 一次拖拽 = 一个 undo 项，与原先"松手落库一次"的语义等价。
import { PlaitBoard, PlaitHistoryBoard, Transforms } from "@plait/core";
import type { Point } from "@plait/core";
import type { GxLinkBlock } from "./types";

/** 首帧 = 新开一个撤销批次；后续帧 = 并入该批次 */
export type LinkDragPhase = "start" | "move";

/**
 * 取当前仍挂在 board 上的元素对象。
 * Transforms.setNode 经 immer 产出新对象，而 PlaitBoard.findPath 用 NODE_TO_PARENT 这张
 * WeakMap 认**对象身份** —— 拿拖拽开始时捕获的旧 element 去 findPath 会直接抛错，
 * 故每帧按 id 现取现用。
 */
export function liveLinkBlock(board: PlaitBoard, element: GxLinkBlock): GxLinkBlock {
  const kids = (board?.children ?? []) as unknown as { id?: string }[];
  const hit = kids.find((c) => !!c && c.id === element.id);
  return (hit as GxLinkBlock | undefined) ?? element;
}

/** 整体平移一条连线的两个端点（绝对目标 = 起始点 + 总位移，不累积误差）。 */
export function translateLinkPoints(points: Point[], dx: number, dy: number): Point[] {
  const [p1, p2] = points;
  return [
    [p1[0] + dx, p1[1] + dy],
    [p2[0] + dx, p2[1] + dy],
  ];
}

/**
 * 把一组 points 写进 plait（拖拽期逐帧调用）。
 * 只读板直接忽略；找不到路径（元素已被删除/卸载）静默放弃，不让拖拽抛异常。
 */
export function syncLinkDragPoints(
  board: PlaitBoard,
  element: GxLinkBlock,
  points: Point[],
  phase: LinkDragPhase,
): void {
  if (!board || PlaitBoard.isReadonly(board)) return;
  const live = liveLinkBlock(board, element);
  let path: number[];
  try {
    path = PlaitBoard.findPath(board, live);
  } catch {
    return; // 元素已不在板上（被删除/重挂载），本帧放弃
  }
  const write = () => {
    Transforms.setNode(
      board,
      { points, updatedAt: new Date().toISOString() } as unknown as Partial<GxLinkBlock>,
      path,
    );
  };
  if (phase === "start") PlaitHistoryBoard.withNewBatch(board, write);
  else PlaitHistoryBoard.withMerging(board, write);
}
