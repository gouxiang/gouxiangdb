// inlineOffsets 回归：行内 Markdown 源码 ↔ 渲染 HTML 的偏移映射（A14 裁决「做，不降级」）。
//
// 为什么在本文件（apps/web）而不是 packages/blocks/src/__tests__：
// @gx/blocks 目前没有 test 脚本、也没有装 vitest（本次任务禁止新增依赖），测试放在那边会让
// `pnpm --filter @gx/blocks typecheck` 报 "Cannot find module 'vitest'" 而红。这里既有 vitest
// 又早已把 @gx/blocks 作为单测对象（同目录 blocks-roundtrip-golden.test.ts 先例），故放在此处。
// 纯函数断言：不碰 DOM、不发网络请求、不使用 @gx/blocks 之外的任何依赖。
//
// 两条判据：
//   ① gold：inlineMdToHtmlWithOffsets(src).html 与 inlineMdToHtml(src) **逐字节相同**
//      —— 映射层一旦漏掉或改写了任何一个 Pass（逃逸顺序 / hold 占位符栈 / style 白名单 /
//      URL scheme 白名单），rendering 就会漂移，这里必然红。
//   ② 语义：srcToHtml 的基本不变量 + 若干代表性落点（粗体标记内部/边上、链接文字内、
//      代码 INNER、块尾），以及反向查询 htmlToSrcAt 的回合性质。
//
// 全部为纯函数断言：不碰 DOM、不发网络请求。

import { describe, expect, it } from "vitest";
import { inlineMdToHtml, htmlToSrcAt, inlineMdToHtmlWithOffsets } from "@gx/blocks";

/** 覆盖全部语法分支的样本（含恶意协议、data: 白名单外、嵌套 span、公式、提及、图片、混合粗斜） */
const SAMPLES: Array<{ name: string; src: string }> = [
  { name: "① 纯文本与中文", src: "前不久，张先生在会上提到了李四。" },
  { name: "② 粗体两种写法", src: "前**粗**后 __另一种__ 尾" },
  { name: "③ 斜体与混合粗斜", src: "*斜* **粗** *外 **内** 外* 尾" },
  { name: "④ 删除线", src: "前~~删~~后" },
  { name: "⑤ 上下标", src: "H~2~O 与 x^2^ 收尾" },
  { name: "⑥ 高亮", src: "前==高亮==后" },
  { name: "⑦ 行内代码", src: "前`代码`后" },
  { name: "⑧ 行内公式", src: "前 $E=mc^2$ 后" },
  { name: "⑨ 成员提及", src: "请 @[u:u-9527|张三] 看一下" },
  { name: "⑩ 外链", src: "见 [文档](https://example.com/a?b=1) 说明" },
  { name: "⑪ 内链（/kb /base）", src: "见 [笔记](/kb/doc/42) 与 [表](/base/t/7) 说明" },
  { name: "⑫ 恶意 javascript: 链接", src: "点 [这里](javascript:alert(1)) 试试" },
  { name: "⑬ vbscript: 链接", src: "点 [这里](vbscript:msgbox(1)) 试试" },
  { name: "⑭ data:text/html（scheme 白名单外）", src: "点 [这里](data:text/html;base64,PHNjcmlwdD4=) 试试" },
  { name: "⑮ data:image 图片（白名单内）", src: "图 ![头像](data:image/png;base64,AAA) 尾" },
  { name: "⑯ data:image svg+xml 图片", src: "图 ![矢量](data:image/svg+xml;base64,PHN2Zz4=) 尾" },
  { name: "⑰ 安全图片", src: "图 ![雪山](https://example.com/a.png) 尾" },
  { name: "⑱ 恶意图片（javascript:）", src: "图 ![迷](javascript:alert(1)) 尾" },
  { name: "⑲ 单个 <span style>", src: '前<span style="color: #FF4568">红字</span>后' },
  { name: "⑳ 嵌套 <span style>", src: '前<span style="color:#00F">底<span style="background-color:#FF0">混合</span>尾</span>后' },
  { name: "㉑ 非法 style（CSS 注入）", src: '前<span style="position:absolute;left:-9999px">偷</span>后' },
  { name: "㉒ 落单的 </span>", src: "前</span>后" },
  { name: "㉓ HTML 逃逸字符", src: 'a & b < c > d " e \' f' },
  { name: "㉔ 软换行", src: "第一行\n第二行\n第三行" },
  { name: "㉕ 链接文字内含粗体与代码（inlineRich 分支）", src: "见 [**粗标题** 与 `code`](https://example.com) 尾" },
  { name: "㉖ 链接文字内含图片（占位符嵌套，既有行为：NUL 字面残留）", src: "见 [![图](https://example.com/i.png) 说明](https://example.com) 尾" },
  { name: "㉗ 源码自带 \\u0000n\\u0000 形态文本", src: "前\u00000\u0000后" },
  { name: "㉘ 空串", src: "" },
  { name: "㉙ 只有语法标记", src: "**粗**" },
  { name: "㉚ 混合长句", src: '综合 **粗**、*斜*、~~删~~、`码 ==x== \n`、$x^2^$、@[u:1|甲]、[链](https://e.com) 与 <span style="color:#0F0">绿</span> 收尾。' },
];

describe("inlineOffsets gold：html 与 inlineMdToHtml 逐字节相同", () => {
  for (const s of SAMPLES) {
    it(`${s.name}`, () => {
      const { html } = inlineMdToHtmlWithOffsets(s.src);
      expect(html, `mine=${JSON.stringify(html)}`).toBe(inlineMdToHtml(s.src));
    });
  }
});

describe("inlineOffsets 不变量（长度 / 单调 / 端点闭合）", () => {
  for (const s of SAMPLES) {
    it(`${s.name}`, () => {
      const { html, srcToHtml } = inlineMdToHtmlWithOffsets(s.src);
      expect(srcToHtml.length, "长度恒为 src.length + 1").toBe(s.src.length + 1);
      expect(srcToHtml[0], "起点落在 0").toBe(0);
      expect(srcToHtml[s.src.length], "终点落在 html 末尾").toBe(html.length);
      for (let i = 1; i < srcToHtml.length; i++) {
        expect(srcToHtml[i]!, `位置 ${i} 必须单调不减`).toBeGreaterThanOrEqual(srcToHtml[i - 1]!);
      }
      for (let i = 0; i < srcToHtml.length; i++) {
        const p = srcToHtml[i]!;
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(html.length);
      }
    });
  }
});

/** 取映射结果 */
function mapOf(src: string) {
  return inlineMdToHtmlWithOffsets(src);
}

/** html 里第 pos 个位置的「切点」描述：左右各取 12 字符，便于定位失败原因 */
function cut(html: string, pos: number): string {
  return `${JSON.stringify(html.slice(0, pos))} | ${JSON.stringify(html.slice(pos))}`;
}

describe("srcToHtml 落点：语法标记内部 / 边上", () => {
  // 前(0) *(1) *(2) 粗(3) *(4) *(5) 后(6)；html = 前<strong>粗</strong>后
  // 规则：开标记内的源码位置 → 仍指向 <strong> 之前；正文起点 → 落在 <strong> 之后（带格式）；
  //      闭标记内的源码位置 → 仍在 </strong> 之前（续打仍是粗体）；越过整个闭标记才出来。
  it("粗体：标记内部俯向之前，正文起点落在 <strong> 之后，越过闭标记才出来", () => {
    const src = "前**粗**后";
    const { html, srcToHtml } = mapOf(src);
    expect(html).toBe("前<strong>粗</strong>后");
    const strongEnd = 1 + "<strong>".length; // 开标签结束 = 「粗」之前
    const closeEnd = strongEnd + 1 + "</strong>".length; // 闭标签结束 = 「后」之前
    expect(srcToHtml[0]).toBe(0);
    expect(srcToHtml[1], "越过「前」").toBe(1);
    expect(srcToHtml[2], "开标记内部（第二个 * 之前）仍在 <strong> 之前").toBe(1);
    expect(srcToHtml[3], cut(html, srcToHtml[3]!)).toBe(strongEnd);
    expect(srcToHtml[4], cut(html, srcToHtml[4]!)).toBe(strongEnd + 1);
    expect(srcToHtml[5], "闭标记内部（两星之间）仍在 </strong> 之前").toBe(strongEnd + 1);
    expect(srcToHtml[6], cut(html, srcToHtml[6]!)).toBe(closeEnd); // 越过整个闭标记
    expect(srcToHtml[src.length], "＝ 越过「后」").toBe(html.length);
  });

  it("块尾：最后一个源码字符之后必定落在 html 末尾", () => {
    for (const src of ["abcdef", "**粗**", "a`码`b", "前\n后"]) {
      const { html, srcToHtml } = mapOf(src);
      expect(srcToHtml[src.length], JSON.stringify(src)).toBe(html.length);
    }
  });
});

describe("srcToHtml 落点：链接文字内 / 代码内 / 提及外围", () => {
  // 见(0) [(1) 标(2) 题(3) ](4) ((5) …URL… )(19) 尾(20)
  it("链接：文字内的源码位置落在 <a> 之内，越过闭标记才落到其后", () => {
    const src = "见[标题](https://e.com)尾";
    const { html, srcToHtml } = mapOf(src);
    expect(html).toBe('见<a href="https://e.com" target="_blank" rel="noopener noreferrer" class="md-link" data-href="https://e.com">标题</a>尾');
    const openAt = html.indexOf("<a ");
    const innerAt = html.indexOf("标题");
    const tailAt = html.indexOf("尾");
    expect(srcToHtml[0]).toBe(0);
    expect(srcToHtml[1], cut(html, srcToHtml[1]!)).toBe(openAt); // 「见」之后、<a> 之前
    expect(srcToHtml[2], cut(html, srcToHtml[2]!)).toBe(innerAt); // 「标」之前 = 链接文字起点
    expect(srcToHtml[3], cut(html, srcToHtml[3]!)).toBe(innerAt + 1); // 「题」之前
    // 链接文字末尾到闭标记之前的每一处（]、(、整段 URL、)）都仍落在 </a> 之前
    for (let i = 4; i < src.length - 1; i++) {
      expect(srcToHtml[i], `源码 ${i} ${cut(html, srcToHtml[i]!)}`).toBe(innerAt + 2);
    }
    expect(srcToHtml[src.length - 1], cut(html, srcToHtml[src.length - 1]!)).toBe(tailAt); // 「尾」之前 = </a> 之后
    expect(srcToHtml[src.length]).toBe(html.length);
  });

  it("行内代码：代码内容逐字符可定位（一个源码字符步 = 一个 html 字符步）", () => {
    const src = "前`ab`后";
    const { html, srcToHtml } = mapOf(src);
    const openEnd = html.indexOf("ab"); // <code ...> 结束处 = 'a' 之前
    expect(srcToHtml[2], cut(html, srcToHtml[2]!)).toBe(openEnd); // 源码 'a' 之前
    expect(srcToHtml[3], cut(html, srcToHtml[3]!)).toBe(openEnd + 1); // 'a' 之后 'b' 之前
    expect(srcToHtml[4], cut(html, srcToHtml[4]!)).toBe(openEnd + 2); // 'b' 之后、</code> 之前
    expect(srcToHtml[5], cut(html, srcToHtml[5]!)).toBe(html.length - 1); // 「后」之前 = </code> 之后
    expect(srcToHtml[src.length]).toBe(html.length);
  });

  it("提及 chip 是原子对象：内部一律指向 chip 之前，越过末尾才落到其后", () => {
    const src = "请@[u:u-9527|张三]看";
    const { html, srcToHtml } = mapOf(src);
    const chipAt = html.indexOf("<span class=\"md-mention\"");
    expect(chipAt).toBeGreaterThan(0);
    for (let i = 1; i < src.length - 1; i++) {
      expect(srcToHtml[i], `源码 ${i} ${cut(html, srcToHtml[i]!)}`).toBe(chipAt);
    }
    expect(srcToHtml[src.length - 1], cut(html, srcToHtml[src.length - 1]!)).toBe(html.length - 1);
  });
});

describe("htmlToSrcAt：反向查询的回合性质", () => {
  for (const s of SAMPLES) {
    it(`${s.name}`, () => {
      const o = mapOf(s.src);
      for (let i = 0; i <= s.src.length; i++) {
        const pos = o.srcToHtml[i]!;
        const back = htmlToSrcAt(o, pos);
        // 反向回来可能落在同一 html 位置的「最右」源码下标（标记区内的多个源码位置共享一个 html 位置），
        // 但绝不能偏到别的 html 位置上去。
        expect(back).toBeGreaterThanOrEqual(i);
        expect(o.srcToHtml[back]!, `源码 ${i} → html ${pos} → 源码 ${back}`).toBe(pos);
      }
      // 越界夹取：html 端点两侧都夹到合法源码下标
      expect(htmlToSrcAt(o, -1)).toBe(0);
      expect(htmlToSrcAt(o, o.html.length + 99)).toBe(s.src.length);
    });
  }
});
