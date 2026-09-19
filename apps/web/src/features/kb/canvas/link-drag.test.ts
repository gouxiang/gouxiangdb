// P0-②：关联块拖拽必须逐帧写 plait（连接线实时跟随），且一次拖拽只产出一个撤销批次。
//
// 原行为（缺陷）：拖拽期只写组件本地 dragVb 驱动 foreignObject，plait 几何绑在原
// element.points 上全程不动，松手才 moveLinkBlock 落库 —— 拖的时候连线与卡片是脱开的。
import { describe, it, expect, vi, beforeEach } from "vitest";

const writes: { props: Record<string, unknown>; path: number[] }[] = [];
const batches: string[] = [];

vi.mock("@plait/core", () => ({
  PlaitBoard: {
    // 假板：readonly 由数据位决定，findPath 用 children 里的下标
    isReadonly: (b: { readonly?: boolean }) => b?.readonly === true,
    findPath: (b: { children: unknown[] }, el: unknown) => {
      const i = b.children.indexOf(el);
      if (i < 0) throw new Error("Unable to find the path");
      return [i];
    },
  },
  PlaitHistoryBoard: {
    withNewBatch: (_b: unknown, fn: () => void) => {
      batches.push("newBatch");
      fn();
    },
    withMerging: (_b: unknown, fn: () => void) => {
      batches.push("merging");
      fn();
    },
  },
  Transforms: {
    setNode: (_b: unknown, props: Record<string, unknown>, path: number[]) => {
      writes.push({ props, path });
    },
  },
}));

import type { Point } from "@plait/core";
import type { GxLinkBlock } from "./types";
import { liveLinkBlock, syncLinkDragPoints, translateLinkPoints } from "./link-drag";

const el = {
  id: "lb-1",
  points: [
    [10, 20],
    [110, 120],
  ] as Point[],
} as unknown as GxLinkBlock;

beforeEach(() => {
  writes.length = 0;
  batches.length = 0;
});

describe("translateLinkPoints：绝对目标 = 起始点 + 总位移（不累积误差）", () => {
  it("同一段总位移重复计算仍得到同一结果", () => {
    const start = [
      [0, 0],
      [100, 50],
    ] as Point[];
    const a = translateLinkPoints(start, 30, 40);
    const b = translateLinkPoints(start, 30, 40);
    expect(a).toEqual([[30, 40], [130, 90]]);
    expect(b).toEqual(a);
  });
});

describe("liveLinkBlock：按 id 取当前挂在 board 上的元素", () => {
  it("setNode 后旧对象失效，仍能取到新对象", () => {
    const fresh = { id: "lb-1", points: [[11, 21], [111, 121]] } as never;
    const board = { children: [fresh] } as never;
    expect(liveLinkBlock(board, el)).toBe(fresh);
  });

  it("board 上已经没有该元素时退回传入对象（由 findPath 兜底放弃）", () => {
    const board = { children: [] } as never;
    expect(liveLinkBlock(board, el)).toBe(el);
  });
});

describe("syncLinkDragPoints：拖拽期写 plait + 单撤销批次", () => {
  it("首帧开新批次，后续帧并入同一批次（一次拖拽 = 一个 undo 项）", () => {
    const board = { children: [el] } as never;
    syncLinkDragPoints(board, el, translateLinkPoints(el.points, 5, 6), "start");
    syncLinkDragPoints(board, el, translateLinkPoints(el.points, 9, 12), "move");
    syncLinkDragPoints(board, el, translateLinkPoints(el.points, 20, 24), "move");

    expect(batches).toEqual(["newBatch", "merging", "merging"]);
    expect(writes).toHaveLength(3);
    // 关键：每一帧都真的写进了 plait（连线才会跟着动）
    expect(writes[0]!.props.points).toEqual([[15, 26], [115, 126]]);
    expect(writes[2]!.props.points).toEqual([[30, 44], [130, 144]]);
    expect(writes[0]!.path).toEqual([0]);
  });

  it("只读板不写（预览里拖卡片不应改动源数据）", () => {
    const board = { children: [el], readonly: true } as never;
    syncLinkDragPoints(board, el, translateLinkPoints(el.points, 5, 5), "start");
    expect(writes).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it("元素已被删除（findPath 抛错）时静默放弃，不让拖拽炸掉", () => {
    const board = { children: [] } as never;
    expect(() => syncLinkDragPoints(board, el, translateLinkPoints(el.points, 1, 1), "start")).not.toThrow();
    expect(writes).toHaveLength(0);
  });
});
