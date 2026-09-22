// apps/web/src/features/collab/__tests__/block-cursor-locator.test.ts
// 「行内 Markdown 源码 offset → 渲染后可见文本位置」的换算回归。
//
// 为什么这组用例必须写：这是整个协同光标链路里唯一能在本仓自动化覆盖的部分
// （TreeWalker / Range 需要真实 DOM，本仓无 jsdom）。而它恰恰是最容易出错的一环 ——
// 光标停在 `**`、`[url]`、`@[u:x|名]` 这些**格式标记内部**时的退化行为。
// 下面的期望值都是先跑 `inlineMdToHtmlWithOffsets` 实测取得后锁死的，
// 一旦将来有人改了 inlineOffsets 的标注语义，这里会立刻报红。

import { describe, expect, it } from "vitest";
import { inlineMdToHtmlWithOffsets } from "@gx/blocks";
import {
  OFFSET_CACHE_MAX,
  cssEscape,
  htmlPosToTextPos,
  locateInSegments,
  planSrcOffset,
} from "../block-cursor-locator";

describe("htmlPosToTextPos", () => {
  it("无标签时恒等", () => {
    expect(htmlPosToTextPos("abcdef", 0)).toBe(0);
    expect(htmlPosToTextPos("abcdef", 3)).toBe(3);
    expect(htmlPosToTextPos("abcdef", 6)).toBe(6);
  });

  it("跳过标签本身：`<strong>` 之后的第一个内容字符是可见位置 2", () => {
    // html = "ab<strong>cd</strong>"，htmlPos 10 是 'c'，可见文本 "abcd" 的 index 2
    expect(htmlPosToTextPos("ab<strong>cd</strong>", 10)).toBe(2);
    expect(htmlPosToTextPos("ab<strong>cd</strong>", 2)).toBe(2);
  });

  it("实体算 1 个可见字符（浏览器 DOM 里就是一个字符）", () => {
    expect(htmlPosToTextPos("a&amp;b", 1)).toBe(1);
    expect(htmlPosToTextPos("a&amp;b", 6)).toBe(2);
    // "&lt;div&gt;" 的可见文本是 "<div>"（5 个字符），实体各自只占 1 个可见位置
    expect(htmlPosToTextPos("&lt;div&gt;", 10)).toBe(5);
    expect(htmlPosToTextPos("&lt;div&gt;", 3)).toBe(1);
  });

  it("重点：属性值里的 '>' 不会被误当成标签结束", () => {
    const html = '<span class="md-math-inline" data-formula="a>b">x</span>';
    // x 在 htmlPos = html.length - 8 = 可见位置 0
    expect(htmlPosToTextPos(html, html.indexOf("x"))).toBe(0);
    expect(htmlPosToTextPos(html, html.length)).toBe(1);
  });

  it("越界 htmlPos 夹到 [0, 可见长度]", () => {
    expect(htmlPosToTextPos("abc", -5)).toBe(0);
    expect(htmlPosToTextPos("abc", 999)).toBe(3);
  });
});

describe("planSrcOffset", () => {
  it("空串 → 0", () => {
    expect(planSrcOffset("", 0)).toBe(0);
    expect(planSrcOffset("", 5)).toBe(0);
  });

  it("负 offset 夹到 0，超大 offset 夹到可见长度", () => {
    expect(planSrcOffset("abcdef", -3)).toBe(0);
    expect(planSrcOffset("abcdef", 999)).toBe(6);
  });

  it("无格式标记时与源码位置一致", () => {
    for (let i = 0; i <= 6; i += 1) expect(planSrcOffset("abcdef", i)).toBe(i);
  });

  it("重点：单调不减 —— offset 递增时结果不倒退，且永不越界", () => {
    for (const src of ["ab**cd**ef", "x[lit](https://a.b)y", "a`code`b", "A ~~s~~ B"]) {
      const limit = htmlPosToTextPos(inlineMdToHtmlWithOffsets(src).html, Number.MAX_SAFE_INTEGER);
      let prev = -1;
      for (let i = 0; i <= src.length; i += 1) {
        const v = planSrcOffset(src, i);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(v).toBeLessThanOrEqual(limit);
        prev = v;
      }
    }
  });

  it("重点：加粗 —— offset 停在标记边上时不跑到另一侧、不越界（实测锁死）", () => {
    // src = "ab**cd**ef" → 可见文本 "abcdef"
    expect(inlineMdToHtmlWithOffsets("ab**cd**ef").html).toBe("ab<strong>cd</strong>ef");
    expect(planSrcOffset("ab**cd**ef", 0)).toBe(0); // 'a' 之前
    expect(planSrcOffset("ab**cd**ef", 2)).toBe(2); // 开标记前的最后一个可见位置
    expect(planSrcOffset("ab**cd**ef", 3)).toBe(2); // 落在开标记**内部**：仍在 cd 之前
    expect(planSrcOffset("ab**cd**ef", 4)).toBe(2); // 'c' 之前
    expect(planSrcOffset("ab**cd**ef", 5)).toBe(3); // 'd' 之前
    expect(planSrcOffset("ab**cd**ef", 7)).toBe(4); // 落在闭标记内部：跳到 e 之前
    expect(planSrcOffset("ab**cd**ef", 8)).toBe(4); // 'e' 之前
    expect(planSrcOffset("ab**cd**ef", 10)).toBe(6); // 文末
  });

  it("重点：链接 —— offset 落在 URL 内部时不越界，且钉住不漂移", () => {
    const src = "see [ lit ](https://x) end";
    const limit = planSrcOffset(src, src.length);
    expect(limit).toBe(13); // 可见文本 "see  lit  end"
    expect(planSrcOffset(src, 4)).toBe(4); // 进入 '<a ...>' 之前（可见位置 = 'see ' 末尾）
    expect(planSrcOffset(src, 6)).toBe(5); // 链接文字第一个字符 'l'
    expect(planSrcOffset(src, 10)).toBe(9); // ']' 处：链接文字刚结束
    for (let i = 11; i <= 22; i += 1) {
      // URL 与右括号占据的每一个源码位置都钉在「链接文本结束」处：不漂移也不越界
      expect(planSrcOffset(src, i)).toBe(9);
    }
    expect(planSrcOffset(src, 23)).toBe(10);
    expect(planSrcOffset(src, 26)).toBe(13);
  });

  it("重点：提及 chip 是原子对象：落在对象内部一律指向对象之前，越过末尾才到之后", () => {
    const src = "hi @[u:abc|张三] ok";
    expect(planSrcOffset(src, 3)).toBe(3); // chip 之前
    for (let i = 4; i <= 13; i += 1) {
      expect(planSrcOffset(src, i)).toBe(3); // chip 内部：钉在之前
    }
    expect(planSrcOffset(src, 14)).toBe(6); // 越过 chip：可见 "hi @张三 ok" 的第 6 位
    expect(planSrcOffset(src, 17)).toBe(9); // 文末
  });

  it("含换行（渲染成 <br/>）不崩且单调", () => {
    const src = "abc\ndef";
    expect(planSrcOffset(src, 0)).toBe(0);
    expect(planSrcOffset(src, 3)).toBe(3);
    expect(planSrcOffset(src, 4)).toBe(3);
    expect(planSrcOffset(src, 7)).toBe(6);
  });

  it("非有限数 offset 退化为 0，不产生 NaN 坐标", () => {
    expect(planSrcOffset("abc", Number.NaN)).toBe(0);
    expect(planSrcOffset("abc", Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("locateInSegments", () => {
  const segments = [{ text: "hello" }, { text: " " }, { text: "world" }];

  it("落在中间段的中间", () => {
    const three = [{ text: "ab" }, { text: "cdef" }, { text: "g" }];
    expect(locateInSegments(three, 4)).toEqual({ index: 1, innerOffset: 2 });
    expect(locateInSegments(three, 2)).toEqual({ index: 1, innerOffset: 0 });
  });

  it("落在最后一段中间", () => {
    expect(locateInSegments(segments, 9)).toEqual({ index: 2, innerOffset: 3 });
  });

  it("段边界上取后一段的开头（插入符属性属于它右侧）", () => {
    expect(locateInSegments(segments, 5)).toEqual({ index: 1, innerOffset: 0 });
    expect(locateInSegments(segments, 6)).toEqual({ index: 2, innerOffset: 0 });
  });

  it("文末（textPos === 总长度）落在最后一段末尾", () => {
    expect(locateInSegments(segments, 11)).toEqual({ index: 2, innerOffset: 5 });
  });

  it("超过总长度夹到末段末尾，不返回 null", () => {
    expect(locateInSegments(segments, 999)).toEqual({ index: 2, innerOffset: 5 });
  });

  it("没有任何文本段 → null（调用方据此跳过该光标）", () => {
    expect(locateInSegments([], 0)).toBeNull();
  });

  it("空段落被自然跳过（Range.setStart 永远指向真实文本节点）", () => {
    expect(locateInSegments([{ text: "" }, { text: "ab" }], 0)).toEqual({ index: 1, innerOffset: 0 });
    expect(locateInSegments([{ text: "" }, { text: "ab" }], 1)).toEqual({ index: 1, innerOffset: 1 });
  });

  it("重点：与 planSrcOffset 自洽：加粗块的可见文本按单段喂进去能落到正确位置", () => {
    const src = "ab**cd**ef";
    const html = inlineMdToHtmlWithOffsets(src).html;
    const visibleLen = htmlPosToTextPos(html, html.length);
    expect(visibleLen).toBe(6); // "abcdef"
    const segs = [{ text: "abcdef" }];
    expect(locateInSegments(segs, planSrcOffset(src, 4))).toEqual({ index: 0, innerOffset: 2 });
    expect(locateInSegments(segs, planSrcOffset(src, 10))).toEqual({ index: 0, innerOffset: 6 });
  });
});

describe("cssEscape", () => {
  it("SSR（无 CSS 对象）下也能转义引号与反斜杠", () => {
    expect(cssEscape('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe("OFFSET_CACHE_MAX", () => {
  it("memo 有上限，避免长会话里无限增长", () => {
    expect(OFFSET_CACHE_MAX).toBeGreaterThan(0);
    expect(OFFSET_CACHE_MAX).toBeLessThanOrEqual(1024);
  });
});
