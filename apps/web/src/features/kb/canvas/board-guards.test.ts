// P0-②：板级事件守卫（只读预览整体短路 / 编辑态关联卡短路）。
//
// 只读预览（文档内嵌画布、版本快照、卡片内的内嵌子画布）此前完全没有板守卫，
// 落在关联卡里的 pointerdown 会起手 plait 的框选/拖拽/绘制，而预览是非受控组件
// （value 只在挂载时读一次、选区不回灌），这些瞬时状态就永久留在画面上成为"残影"。
import { describe, it, expect } from "vitest";
import { installLinkBoardGuards, installPreviewBoardGuards } from "./board-guards";

/** 造一个带五个板方法的假板，每个方法记录被调用次数与参数 */
function fakeBoard() {
  const calls: { name: string; event: unknown }[] = [];
  const board: Record<string, unknown> = {};
  for (const name of ["pointerDown", "pointerMove", "dblClick", "globalKeyDown", "keyDown"]) {
    board[name] = (event: unknown) => {
      calls.push({ name, event });
      return `orig-${name}`;
    };
  }
  /** 调用某个板方法（Record<string, unknown> 需要一次收窄才能调用） */
  const call = (name: string, arg?: unknown): unknown =>
    (board[name] as (e?: unknown) => unknown)(arg);
  return { board, calls, call };
}

/** 造一个假事件目标：closest(sel) 只在 selector 命中时返回自身 */
function fakeTarget(hitSelector: string | null) {
  const node = { tag: "node" };
  return {
    closest: (sel: string) => (hitSelector && sel === hitSelector ? node : null),
    node,
  };
}

describe("installPreviewBoardGuards：只读预览一律短路板手势", () => {
  it("pointerDown/Move/dblClick/键盘全部不再进入 plait（不给残留态留入口）", () => {
    const { board, calls, call } = fakeBoard();
    installPreviewBoardGuards(board);

    call("pointerDown", { target: fakeTarget(null) });
    call("pointerMove", { target: fakeTarget(null) });
    call("dblClick", { target: fakeTarget("[data-gx-link-fo]") });
    call("keyDown", { target: fakeTarget(null) });
    call("globalKeyDown", { target: fakeTarget(null) });

    expect(calls).toHaveLength(0);
  });

  it("重复安装不会把守卫套两层（幂等）", () => {
    const { board, calls, call } = fakeBoard();
    installPreviewBoardGuards(board);
    installPreviewBoardGuards(board);
    call("pointerDown", { target: fakeTarget(null) });
    expect(calls).toHaveLength(0);
    expect(board.__gxGuardsInstalled).toBe(true);
  });
});

describe("installLinkBoardGuards：编辑态只短路落在关联卡内的手势", () => {
  it("事件落在 [data-gx-link-fo] 内 → 跳过外层板处理", () => {
    const { board, calls, call } = fakeBoard();
    installLinkBoardGuards(board, null);
    call("pointerDown", { target: fakeTarget("[data-gx-link-fo]") });
    expect(calls).toHaveLength(0);
  });

  it("事件落在画布本体 → 照常处理（编辑手势不能丢）", () => {
    const { board, calls, call } = fakeBoard();
    installLinkBoardGuards(board, null);
    const r = call("pointerDown", { target: fakeTarget(null) });
    expect(calls.map((c) => c.name)).toEqual(["pointerDown"]);
    expect(r).toBe("orig-pointerDown");
  });

  it("按 wrap 限定作用域：别的画布实例里的关联卡不误伤", () => {
    const { board, calls, call } = fakeBoard();
    const otherCard = { tag: "card" };
    const wrap = { contains: (n: unknown) => n !== otherCard };
    installLinkBoardGuards(board, wrap as unknown as HTMLElement);
    // 卡片不在本 wrap 内 → 放行
    call("pointerDown", { target: { closest: () => otherCard } });
    expect(calls).toHaveLength(1);
  });

  it("event 没有 target / target 没有 closest（非元素目标）→ 放行，不抛错", () => {
    const { board, calls, call } = fakeBoard();
    installLinkBoardGuards(board, null);
    expect(() => call("pointerDown", {})).not.toThrow();
    expect(() => call("pointerDown", undefined)).not.toThrow();
    expect(calls).toHaveLength(2);
  });
});
