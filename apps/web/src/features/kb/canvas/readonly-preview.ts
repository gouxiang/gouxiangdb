// apps/web/src/features/kb/canvas/readonly-preview.ts
// 只读预览（文档内嵌画布 / 版本快照 / 关联卡里再嵌一层画布）的两件保障，纯逻辑、可单测。
//
// ① isDataMutatingOp —— C-1 只读数据层兜底要拦的是「改内容」的 op。
//    旧实现只放行 set_viewport、其余一律静默吞掉，等于把 selection / interaction 这类
//    视图态 op 也关进黑洞：plait 内部靠它们推进首次布局与绘制，被拦后画面停在
//    origin(0,0)/zoom 1，预览区一片纯白（P0-⑤ 嵌套预览空白）。
//    这里反过来——只拦数据变更类，视图态一律放行，匹配不到的未知 op 也放行（宁可放行，
//    不可再静默吞掉一次绘制所依赖的 op）。
//
// ② fitViewportWhenReady —— 首帧适配。
//    BoardTransforms.fitViewport 读 PlaitBoard.getBoardContainer(board) 的
//    getBoundingClientRect() 当视口大小；小卡片 / 宿主刚挂载时宽高为 0，fit 就成了空操作
//    （旧代码还把异常 catch 成「忽略」，所以永远看不出失败）。这里等尺寸就绪再 fit，
//    fit 失败按 children 包围盒手算 zoom + origination，保证内容一定落在可视区。

import { BoardTransforms, getRectangleByElements, PlaitBoard } from "@plait/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyBoard = any;

/** plait 有记录的数据变更类 op：改节点树 / 改文本 / 改主题，只读预览必须挡住。 */
const DATA_MUTATING_OPS = new Set([
  "insert_node",
  "remove_node",
  "set_node",
  "move_node",
  "merge_node",
  "split_node",
  "insert_text",
  "remove_text",
  "insert_fragment",
  "remove_fragment",
  "set_fragment",
  "set_theme",
  "set_board",
]);

/**
 * 兜底模式：未来版本若新增 op，名字里带这些词根的一律视为改数据（如 update_node）。
 * set_viewport / set_selection / set_interaction 不含这些词根，天然放行。
 */
const DATA_MUTATING_PATTERN = /(node|text|fragment|theme|board)/;

export function isDataMutatingOp(type: string | undefined): boolean {
  if (!type) return false;
  return DATA_MUTATING_OPS.has(type) || DATA_MUTATING_PATTERN.test(type);
}

/** 与 plait 内部 fitViewport 一致的四周留白。 */
const AUTO_FIT_PADDING = 16;
/** 重试帧上限：30 帧 ≈ 500ms，覆盖字体加载 / 抽屉入场动画导致的晚布局。 */
const MAX_FRAMES = 30;
/** 手算兜底的缩放上下界：防止 0 尺寸除出 Infinity，也防止缩到看不见。 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;

export interface FitBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** 纯数学：把内容包围盒塞进视口，返回 plait 坐标系下的 zoom 与 origination。 */
export function computeFit(
  box: FitBox,
  size: ViewportSize,
): { zoom: number; origination: [number, number] } | null {
  const vw = size.width - 2 * AUTO_FIT_PADDING;
  const vh = size.height - 2 * AUTO_FIT_PADDING;
  if (!(vw > 0) || !(vh > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  // 与 plait 同口径：装得下就回到 1 倍，装不下才缩；再夹到上下界。
  const raw = Math.min(vw / box.width, vh / box.height);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(raw, 1)));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    zoom,
    origination: [cx - size.width / 2 / zoom, cy - size.height / 2 / zoom],
  };
}

/** 画板容器尺寸；尚未布局（宽或高为 0）时返回 null，交给调用方重试。 */
export function getContainerSize(board: AnyBoard): ViewportSize | null {
  try {
    const rect = PlaitBoard.getBoardContainer(board)?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return { width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

/** children 包围盒；无子元素或尚未测量出尺寸时返回 null。 */
function getContentBox(board: AnyBoard): FitBox | null {
  try {
    const children = board?.children;
    if (!Array.isArray(children) || children.length === 0) return null;
    const box = getRectangleByElements(board, children, true);
    if (!box || !(box.width > 0) || !(box.height > 0)) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return null;
  }
}

/**
 * 适配一次。返回 done=false 表示「条件还不成立，下一帧再试」，
 * done=true 表示已适配（或确认无需适配），调用方可以收工。
 */
export function fitOnce(board: AnyBoard): { done: boolean; zoom: number } {
  const size = getContainerSize(board);
  if (!size) return { done: false, zoom: 0 };

  const children = board?.children;
  const hasChildren = Array.isArray(children) && children.length > 0;
  const box = getContentBox(board);
  if (!box) {
    // 空画布没有可适配对象，直接收工；有元素但包围盒还是 0 → 元素尚未测量，继续重试。
    return hasChildren
      ? { done: false, zoom: 0 }
      : { done: true, zoom: board?.viewport?.zoom ?? 1 };
  }

  try {
    BoardTransforms.fitViewport(board);
    const zoom = board?.viewport?.zoom;
    if (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0) return { done: true, zoom };
    // 没抛错但 zoom 没变（容器内测量被短路等），继续走下面的手算兜底。
  } catch (e) {
    console.warn("[gx] fitViewport 失败，改用 children 包围盒兜底:", e);
  }

  const fit = computeFit(box, size);
  if (!fit) return { done: false, zoom: 0 };
  try {
    BoardTransforms.updateViewport(board, fit.origination, fit.zoom);
    return { done: true, zoom: fit.zoom };
  } catch (e) {
    console.warn("[gx] 兜底适配失败（视口保持原值）:", e);
    return { done: false, zoom: 0 };
  }
}

export interface FitWhenReadyOptions {
  /** 尺寸为 0 时的重试帧上限 */
  maxFrames?: number;
  /** 适配完成回调（拿到最终 zoom，供外层同步缩放显示） */
  onDone?: (zoom: number) => void;
}

/**
 * 等容器尺寸就绪后再适配：rAF 轮询（上限 maxFrames 帧）；
 * 帧数用尽仍未就绪（宿主布局晚于动画稳定）时，退回一次性 ResizeObserver 补一次。
 * 返回取消函数，卸载时调用即可，不留悬挂的帧/监听。
 */
export function fitViewportWhenReady(
  board: AnyBoard,
  options: FitWhenReadyOptions = {},
): () => void {
  const maxFrames = options.maxFrames ?? MAX_FRAMES;
  let raf = 0;
  let frames = 0;
  let done = false;
  let observer: ResizeObserver | null = null;

  const cleanup = () => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    observer?.disconnect();
    observer = null;
  };

  const finish = (zoom: number) => {
    if (done) return;
    cleanup();
    options.onDone?.(zoom);
  };

  const attempt = () => {
    if (done) return;
    const result = fitOnce(board);
    if (result.done) {
      finish(result.zoom);
      return;
    }
    if (++frames < maxFrames) {
      raf = requestAnimationFrame(attempt);
      return;
    }
    // 帧数用尽：装一次性尺寸监听，等宿主真正布局完再补一次；失败就保持现状并告警，
    // 不再像旧实现那样静默 swallow（预览空白却查不到任何线索）。
    let container: Element | null = null;
    try {
      container = PlaitBoard.getBoardContainer(board) ?? null;
    } catch {
      container = null;
    }
    if (typeof ResizeObserver !== "undefined" && container) {
      observer = new ResizeObserver(() => {
        const retry = fitOnce(board);
        if (retry.done) finish(retry.zoom);
      });
      observer.observe(container);
      return;
    }
    console.warn("[gx] 只读预览适配放弃：容器尺寸始终为 0，预览可能显示空白");
  };

  raf = requestAnimationFrame(attempt);
  return cleanup;
}
