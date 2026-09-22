// apps/web/src/features/kb/collab/__tests__/domHotPatch.test.ts
// 热补链路里**能在 node 里测**的部分（仓库无 jsdom，Range/TreeWalker 那段只能靠浏览器人工验收）：
//   ① nextCaretOffset —— 远端补丁到达后的光标位移
//   ② visibleTextOf  —— HTML → 可见文本（编辑器的"DOM 是否已是最新"判定靠它）
// 覆盖不到的部分如实记录：applyPatchesToDom 的删除/插入/光标复位需要真实 DOM。

import { describe, expect, it } from "vitest";
import { nextCaretOffset, visibleTextOf } from "../domHotPatch";

describe("nextCaretOffset：远端补丁后的光标位移", () => {
  it("补丁整体在光标之前 → 按净增量平移", () => {
    // "前甲乙丙丁"，光标在 3（"丙"前），远端在 0 插入 "XYZ"
    expect(nextCaretOffset(3, { index: 0, remove: 0, insertLen: 3 })).toBe(6);
  });

  it("补丁整体在光标之后 → 光标不动", () => {
    expect(nextCaretOffset(2, { index: 5, remove: 0, insertLen: 4 })).toBe(2);
  });

  it("远端删掉光标之前的字符 → 光标跟着后退", () => {
    expect(nextCaretOffset(5, { index: 1, remove: 2, insertLen: 0 })).toBe(3);
  });

  it("远端替换的区间与光标相交 → 夹到插入内容末尾（不产生负位移）", () => {
    expect(nextCaretOffset(3, { index: 1, remove: 5, insertLen: 2 })).toBe(3);
  });

  it("替换后净增量可能为负 → 夹到 0，绝不返回负数", () => {
    expect(nextCaretOffset(1, { index: 0, remove: 4, insertLen: 0 })).toBe(0);
  });
});

describe("visibleTextOf：HTML → 可见文本", () => {
  it("纯文本原样返回", () => {
    expect(visibleTextOf("前甲乙丙丁")).toBe("前甲乙丙丁");
  });

  it("剥掉标签，只留可见字符", () => {
    expect(visibleTextOf("a<strong>b</strong>c")).toBe("abc");
  });

  it("反转义实体（&amp; &lt; &#39; 各算一个可见字符）", () => {
    expect(visibleTextOf("a&amp;b&lt;c&#39;d")).toBe("a&b<c'd");
  });

  it("属性值里含 > 的标签不会被提前截断", () => {
    expect(visibleTextOf('<span data-formula="a>b">x</span>y')).toBe("xy");
  });

  it("未闭合标签不吞掉后续文本", () => {
    expect(visibleTextOf("abc")).toBe("abc");
  });
});
