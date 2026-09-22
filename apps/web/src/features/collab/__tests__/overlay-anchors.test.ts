// apps/web/src/features/collab/__tests__/overlay-anchors.test.ts
// 浮层坐标换算与人名标签贴边翻转的回归。

import { describe, expect, it } from "vitest";
import {
  LABEL_GAP_PX,
  LABEL_INSET_PX,
  placeLabel,
  toLocalRect,
} from "../overlay-anchors";

const container = { width: 800, height: 600 };
const label = { width: 72, height: 18 };

describe("toLocalRect", () => {
  it("容器在原点时恒等", () => {
    expect(toLocalRect({ left: 0, top: 0, width: 800, height: 600 }, { left: 10, top: 20, width: 2, height: 3 })).toEqual({
      left: 10,
      top: 20,
      width: 2,
      height: 3,
    });
  });

  it("容器本身有偏移时正确扣除", () => {
    expect(
      toLocalRect({ left: 100, top: 50, width: 800, height: 600 }, { left: 130, top: 90, width: 2, height: 30 }),
    ).toEqual({ left: 30, top: 40, width: 2, height: 30 });
  });
});

describe("placeLabel", () => {
  it("默认贴在光标上方、与光标左对齐", () => {
    const r = placeLabel({ x: 100, y: 200, height: 20 }, label, container);
    expect(r.below).toBe(false);
    expect(r.flipped).toBe(false);
    expect(r.left).toBe(100);
    expect(r.top).toBe(200 - 18 - LABEL_GAP_PX);
  });

  it("重点：贴容器顶 → 翻到光标下方", () => {
    const r = placeLabel({ x: 100, y: 4, height: 20 }, label, container);
    expect(r.below).toBe(true);
    expect(r.top).toBe(4 + 20 + LABEL_GAP_PX);
  });

  it("重点：贴容器右 → 整块翻到光标左侧", () => {
    const r = placeLabel({ x: 780, y: 200, height: 20 }, label, container);
    expect(r.flipped).toBe(true);
    expect(r.left).toBe(780 - 72);
    expect(r.left + label.width).toBeLessThanOrEqual(container.width - LABEL_INSET_PX);
  });

  it("重点：右上角 —— 两个条件同时成立", () => {
    const r = placeLabel({ x: 795, y: 2, height: 20 }, label, container);
    expect(r.below).toBe(true);
    expect(r.flipped).toBe(true);
    expect(r.left).toBeGreaterThan(0);
  });

  it("容器比标签还窄时不许出负坐标", () => {
    const r = placeLabel({ x: 5, y: 100, height: 20 }, label, { width: 10, height: 200 });
    expect(r.left).toBe(LABEL_INSET_PX);
    expect(r.left).toBeGreaterThanOrEqual(0);
  });

  it("标签正好铺满容器宽度时夹到最小留白", () => {
    const wide = { width: 80, height: 18 };
    const r = placeLabel({ x: 4, y: 100, height: 20 }, wide, { width: 80, height: 200 });
    expect(r.left).toBe(LABEL_INSET_PX);
  });

  it("左边界也被兜住（光标在负坐标的极端情况）", () => {
    const r = placeLabel({ x: -50, y: 100, height: 20 }, label, container);
    expect(r.left).toBe(LABEL_INSET_PX);
  });
});
