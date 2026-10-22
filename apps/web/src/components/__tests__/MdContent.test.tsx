// apps/web/src/components/__tests__/MdContent.test.tsx
// 长文本两种历史输入的渲染归一：
//   1) 含真实换行 \n   → 多行（<br>）
//   2) 含字面 <br/>   → normalizeBreaks 时同样显示为多行，不泄漏可见的 "<br/>" 文本
//   行内代码里的 <br/> 必须作为示例文本保留（被转义），不被替换。
// node 环境（apps/web 无 jsdom）：StaticRouter + react-dom/server 渲染真实 MdContent。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { createElement } from "react";
import { StaticRouter } from "react-router-dom/server";
import { MdContent } from "../MdContent";

const shot = (props: { md: string; variant?: "inline" | "block"; normalizeBreaks?: boolean }) =>
  render(createElement(StaticRouter, { location: "/" }, createElement(MdContent, props)));

describe("MdContent 长文本换行归一", () => {
  it("真实换行渲染为多行 <br>（inline）", () => {
    const html = shot({ md: "第一行\n第二行", variant: "inline" });
    expect(html).toContain("第一行<br");
    expect(html).toContain("第二行");
  });

  it("字面 <br/> 在 normalizeBreaks 下显示为多行，不泄漏可见标签文本", () => {
    const html = shot({ md: "第一行<br/>第二行", variant: "inline", normalizeBreaks: true });
    expect(html).toContain("第一行<br");
    expect(html).toContain("第二行");
    // 关键：不应出现被转义后可见的字面标签
    expect(html).not.toContain("&lt;br");
  });

  it("未开启 normalizeBreaks 时，字面 <br/> 被转义为可见文本（证明开关确实改变行为，默认不动）", () => {
    const html = shot({ md: "第一行<br/>第二行", variant: "inline" });
    expect(html).toContain("&lt;br");
  });

  it("block 变体下字面 <br/> 同样归一为真实换行（pre-wrap 折成多行）", () => {
    const html = shot({ md: "第一段第一行<br/>第一段第二行", variant: "block", normalizeBreaks: true });
    // 渲染器把连接标记/字面 br 都转义成 &lt;br/&gt;，web 侧精准还原成段落里的真实换行符
    expect(html).toContain("第一段第一行\n第一段第二行");
    expect(html).not.toContain("&lt;br");
  });

  it("block 变体下真实换行同样多行显示（修渲染器把续行 <br/> 转义的缺陷）", () => {
    const html = shot({ md: "第一行\n第二行", variant: "block", normalizeBreaks: true });
    expect(html).toContain("第一行\n第二行");
    expect(html).not.toContain("&lt;br");
  });

  it("行内代码中的 <br/> 作为示例保留（转义可见），代码之外的才归一", () => {
    const html = shot({ md: "调用 `<br/>` 标签<br/>正文第二行", variant: "inline", normalizeBreaks: true });
    expect(html).toContain("md-code-inline");
    expect(html).toContain("正文第二行");
    // 代码段内字面 <br/> 被转义展示
    expect(html).toContain("&lt;br");
    // 代码外的换行已变 <br>（存在真实 br 元素，且“正文第二行”紧跟在其后）
    expect(html).toMatch(/<br\/?>正文第二行/);
  });

  it("block 变体保护代码块与行内代码里的 <br/> 示例，只还原段落里的", () => {
    const md = "```html\n<div><br/></div>\n```\n正文一行<br/>正文二行\n代码 `<br>` 示例";
    const html = shot({ md, variant: "block", normalizeBreaks: true });
    // 代码块内容原样保留
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;br/&gt;");
    // 段落里的字面 br 被还原成真实换行
    expect(html).toContain("正文一行\n正文二行");
  });
});
