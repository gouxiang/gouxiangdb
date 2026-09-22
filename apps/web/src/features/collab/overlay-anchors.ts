// apps/web/src/features/collab/overlay-anchors.ts
// 浮层的坐标与摆位数学。
//
// 为什么单独抽出来：协同光标浮层和块占用遮罩都挂在**编辑器容器外层**（D6：绝不能写进编辑器
// 内部 DOM），两者都需要「视口坐标 → 容器本地坐标」换算和「贴边翻转」判定。这些判定全是纯数学，
// 抽出来就能在本仓（无 jsdom）里单测；留在组件里就只能靠肉眼看。

import { useEffect, useState } from "react";

export interface SizeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 人名标签与光标之间的距离。 */
export const LABEL_GAP_PX = 2;
/** 标签距容器边缘的最小留白：贴边既不美观也容易压住内容，更重要是会溢出容器被裁掉。 */
export const LABEL_INSET_PX = 4;

/** 视口坐标 → 容器本地坐标。浮层是 absolute 定位到容器上的，不换算就会整体偏移。 */
export function toLocalRect(container: SizeRect, viewport: SizeRect): SizeRect {
  return {
    left: viewport.left - container.left,
    top: viewport.top - container.top,
    width: viewport.width,
    height: viewport.height,
  };
}

export interface PlacedLabel {
  left: number;
  top: number;
  /** 上方放不下，翻到了光标下方。 */
  below: boolean;
  /** 右侧放不下，翻到了光标左侧。 */
  flipped: boolean;
}

/**
 * 人名标签摆位（入参均为**容器本地坐标**）。
 *
 * 默认：贴在光标正上方、与光标左对齐。两条贴边规则：
 *   - 贴容器顶 → 翻到光标下方（否则标签上半截被父层 overflow-hidden 裁掉）；
 *   - 贴容器右 → 整块翻到光标左侧（否则名字右边一半看不见）。
 * 最后无论如何都把 left 夹进容器可视范围，容器比标签还窄时也不许出负坐标。
 */
export function placeLabel(
  caret: { x: number; y: number; height: number },
  label: { width: number; height: number },
  container: { width: number; height: number },
): PlacedLabel {
  let below = false;
  let top = caret.y - label.height - LABEL_GAP_PX;
  if (top < LABEL_INSET_PX) {
    below = true;
    top = caret.y + caret.height + LABEL_GAP_PX;
  }

  let flipped = false;
  let left = caret.x;
  if (left + label.width > container.width - LABEL_INSET_PX) {
    flipped = true;
    left = caret.x - label.width;
  }

  const maxLeft = Math.max(LABEL_INSET_PX, container.width - label.width - LABEL_INSET_PX);
  left = Math.min(Math.max(left, LABEL_INSET_PX), maxLeft);

  return { left, top, below, flipped };
}

/**
 * 浮层重算节拍器：让上层重新量测一次 DOM 位置。
 *
 * 触发源有三类：
 *   1. 容器滚动 / 窗口 resize —— 位置变了；
 *   2. 容器尺寸变化（ResizeObserver）—— 侧栏收起、大纲展开都会改变可用宽度；
 *   3. 每 250ms 轮询 —— 远端敲字会改变行高与换行位置，这类 reflow **不产生任何事件**，
 *      只靠监听器会漏。轮询频率取 250ms 是「肉眼感知延迟」与「测量开销」的折中。
 *
 * `active` 为 false 时不注册任何监听器、不跑定时器 —— D6 要求无人协同时页面行为与引入前完全一致，
 * 一个空转的定时器也是行为差异。
 *
 * `signal` 是上层的变更信号（如 peers 的 id/offset 摘要），变化时也会触发一次重算。
 */
export function useDomTicker(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  signal: string,
): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const bump = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((t) => t + 1);
      });
    };
    const target = containerRef.current;
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    const observer = target && typeof ResizeObserver !== "undefined" ? new ResizeObserver(bump) : null;
    if (target && observer) observer.observe(target);
    const timer = setInterval(bump, 250);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearInterval(timer);
      observer?.disconnect();
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, [active, containerRef, signal]);

  return tick;
}
