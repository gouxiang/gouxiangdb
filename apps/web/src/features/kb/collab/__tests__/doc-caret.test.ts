// 阶段 2 · 本地光标坐标换算回归（纯函数，node 环境跑，无 jsdom）。
//
// 锁两件事：
//   ① 可见文本位置 → 块内源码偏移 必须与渲染侧 planSrcOffset **互为逆运算**，否则别人看到的
//      光标位置与我自己敲的位置对不上（这类偏差只在带格式标记的块里出现，最难肉眼发现）。
//   ② 整篇偏移 → 块 id + 块内偏移 的四个边界：文首 / 文末 / 块与块交界 / 空块。
import { describe, expect, it } from "vitest";
import { planSrcOffset } from "../../../collab/block-cursor-locator";
import {
  CLEARED_PAYLOAD,
  LEASE_MS,
  docBlockSpans,
  leasePayload,
  locateDocOffset,
  selectionPayload,
  srcOffsetOfVisiblePos,
} from "../doc-caret";

describe("可见文本位置 → 块内源码偏移", () => {
  it("纯文本：两者是恒等映射", () => {
    expect(srcOffsetOfVisiblePos("abcdef", 0)).toBe(0);
    expect(srcOffsetOfVisiblePos("abcdef", 3)).toBe(3);
    expect(srcOffsetOfVisiblePos("abcdef", 6)).toBe(6);
  });

  it("与渲染侧 planSrcOffset 互为逆运算（带格式标记的块）", () => {
    for (const src of ["**粗**", "**粗**尾", "前*a*后", "**A** *B* `C`", "[链接](https://x.y)"]) {
      const visible = planSrcOffset(src, src.length);
      for (let pos = 0; pos <= visible; pos += 1) {
        // 发布侧算出的源码偏移，回到渲染侧必须还原成同一个可见位置
        expect(planSrcOffset(src, srcOffsetOfVisiblePos(src, pos))).toBe(pos);
      }
    }
  });

  it("光标停在闭合标记前而不是越过它（`**粗|**` → 紧跟「粗」）", () => {
    const src = "**粗**";
    const at = srcOffsetOfVisiblePos(src, 1);
    expect(at).toBe(3); // 0:'*' 1:'*' 2:'粗' → 3 是「粗之后、闭合标记之前」
    expect(src.slice(0, at)).toBe("**粗");
  });

  it("越界与空块都夹住，不返回越界下标", () => {
    expect(srcOffsetOfVisiblePos("", 0)).toBe(0);
    expect(srcOffsetOfVisiblePos("", 5)).toBe(0);
    expect(srcOffsetOfVisiblePos("abc", -3)).toBe(0);
    expect(srcOffsetOfVisiblePos("abc", 99)).toBe(3);
    expect(srcOffsetOfVisiblePos("abc", Number.NaN)).toBe(0);
  });
});

describe("整篇偏移 → 块 id + 块内偏移", () => {
  const MD = "# 标题\n\n正文一段\n\n- 列表项\n";
  const IDS = ["b-head", "b-para", "b-list"];
  const spans = docBlockSpans(MD, IDS);

  it("块正文按序对齐（不另写一份解析器，块数对不上就整体放弃）", () => {
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.blockId)).toEqual(IDS);
    // 每块的区间都必须正好框住它自己的正文
    expect(MD.slice(spans[0]!.start, spans[0]!.end)).toBe("标题");
    expect(MD.slice(spans[1]!.start, spans[1]!.end)).toBe("正文一段");
    expect(MD.slice(spans[2]!.start, spans[2]!.end)).toBe("列表项");
    // 块 id 与正文数量不一致 → 宁可不上报，也不广播错位的块
    expect(docBlockSpans(MD, ["b-head"])).toEqual([]);
  });

  it("文首：落在首块块首", () => {
    expect(locateDocOffset(spans, 0)).toEqual({ blockId: "b-head", offset: 0 });
  });

  it("文末：落在末块块尾（不是整篇末尾，否则远端会画到块外）", () => {
    expect(locateDocOffset(spans, MD.length)).toEqual({ blockId: "b-list", offset: 3 });
    expect(locateDocOffset(spans, 9_999)).toEqual({ blockId: "b-list", offset: 3 });
  });

  it("块与块交界：交界处归**前一块**的块尾，紧随其后才是后一块的块首", () => {
    const tailOfHead = spans[0]!.end; // 「标题」的最后一个字之后
    expect(locateDocOffset(spans, tailOfHead)).toEqual({ blockId: "b-head", offset: 2 });
    // 越过交界（空行）→ 下一块的块首
    expect(locateDocOffset(spans, tailOfHead + 1)).toEqual({ blockId: "b-para", offset: 0 });
    expect(locateDocOffset(spans, spans[1]!.end)).toEqual({ blockId: "b-para", offset: 4 });
  });

  it("空块：零长区间，块内恒为 0", () => {
    const empty = docBlockSpans("", ["b-only"]);
    expect(empty).toEqual([{ blockId: "b-only", start: 0, end: 0 }]);
    expect(locateDocOffset(empty, 0)).toEqual({ blockId: "b-only", offset: 0 });
    expect(locateDocOffset(empty, 7)).toEqual({ blockId: "b-only", offset: 0 });
  });

  it("无区间（块 id 与正文对不上）→ null，调用方跳过本次上报", () => {
    expect(locateDocOffset([], 3)).toBeNull();
  });
});

describe("发布载荷", () => {
  it("选区载荷是源码坐标的 doc 形状", () => {
    expect(selectionPayload("b1", 4, 2)).toEqual({
      selection: { kind: "doc", blockId: "b1", offset: 4, length: 2 },
    });
    expect(selectionPayload("b1", -1, -5)).toEqual({
      selection: { kind: "doc", blockId: "b1", offset: 0, length: 0 },
    });
  });

  it("租约只占当前块，LEASE_MS 后到期且**不续期**", () => {
    const now = 1_000_000;
    expect(leasePayload("b1", now)).toEqual({
      leases: [{ unit: "b1", since: now, expiresAt: now + LEASE_MS }],
    });
    expect(LEASE_MS).toBe(15_000);
  });

  it("清空载荷同时撤掉光标与占用", () => {
    expect(CLEARED_PAYLOAD).toEqual({ selection: null, leases: [] });
  });
});
