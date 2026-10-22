// apps/web/src/lib/__tests__/text-breaks.test.ts
// normalizeLiteralLineBreaks：把字面 <br> 系列标签归一为真实换行，
// 但必须跳过围栏代码块与行内代码（其中的 <br> 是要展示的示例）。

import { describe, it, expect } from "vitest";
import { normalizeLiteralLineBreaks as norm, restoreBlockLineBreaks as restore } from "../text-breaks";

describe("normalizeLiteralLineBreaks", () => {
  it("把三种字面 br 标签（含空格/大写）都换成真实换行", () => {
    expect(norm("a<br>b")).toBe("a\nb");
    expect(norm("a<br/>b")).toBe("a\nb");
    expect(norm("a<br />b")).toBe("a\nb");
    expect(norm("a<BR/>b")).toBe("a\nb");
    expect(norm("a<br />b<br>c")).toBe("a\nb\nc");
  });

  it("真实换行输入保持不变（幂等）", () => {
    expect(norm("a\nb\nc")).toBe("a\nb\nc");
    // 归一后再跑一次，不再变化
    expect(norm(norm("a<br/>b<br>c"))).toBe("a\nb\nc");
  });

  it("CRLF / CR 归一为 \\n 后再替换", () => {
    expect(norm("a\r\n<br/>\r\nb")).toBe("a\n\nb");
  });

  it("不替换围栏代码块（``` 与 ~~~，含未闭合）里的字面 br", () => {
    const fence = "```html\n<div><br/></div>\n```\nafter<br/>b";
    expect(norm(fence)).toBe("```html\n<div><br/></div>\n```\nafter\nb");

    const tilde = "~~~\nx<br>\n~~~";
    expect(norm(tilde)).toBe("~~~\nx<br>\n~~~");

    // 未闭合围栏：后续全部当代码原样保留，不吞用户示例
    expect(norm("```\nx<br>\nstill code<br/>")).toBe("```\nx<br>\nstill code<br/>");
  });

  it("不替换行内代码里的字面 br，只替换其外的", () => {
    expect(norm("use `<br/>` here<br/>done")).toBe("use `<br/>` here\ndone");
    // 双反引号行内代码同样保护
    expect(norm("``a<br/>b``<br>z")).toBe("``a<br/>b``\nz");
  });

  it("无字面 br 时原样返回（引用同一字符串，零成本）", () => {
    const s = "plain text without tags";
    expect(norm(s)).toBe(s);
  });

  it("空串安全", () => {
    expect(norm("")).toBe("");
  });
});

describe("restoreBlockLineBreaks（块级渲染后还原）", () => {
  it("把段落里转义的 <br>/<br/> 标记还原成真实换行", () => {
    expect(restore('<p class="md-p">a&lt;br/&gt;b</p>')).toBe('<p class="md-p">a\nb</p>');
    expect(restore('<p class="md-p">a&lt;br&gt;b</p>')).toBe('<p class="md-p">a\nb</p>');
    expect(restore('<p class="md-p">a&lt;BR /&gt;b</p>')).toBe('<p class="md-p">a\nb</p>');
    expect(restore('<p class="md-p">a&lt;br/&gt;b&lt;br/&gt;c</p>')).toBe('<p class="md-p">a\nb\nc</p>');
  });

  it("保护 <pre><code> 代码块里的转义 br（示例文本）", () => {
    const html = '<pre class="md-pre"><code>&lt;br/&gt;</code></pre><p class="md-p">a&lt;br/&gt;b</p>';
    expect(restore(html)).toBe('<pre class="md-pre"><code>&lt;br/&gt;</code></pre><p class="md-p">a\nb</p>');
  });

  it("保护段落内行内代码 <code> 里的转义 br，只还原其外", () => {
    const html =
      '<p class="md-p"><code class="md-code-inline">&lt;br/&gt;</code> c&lt;br/&gt;d</p>';
    expect(restore(html)).toBe(
      '<p class="md-p"><code class="md-code-inline">&lt;br/&gt;</code> c\nd</p>',
    );
  });

  it("不误伤普通小于号文本（&lt; 后非 br）", () => {
    expect(restore('<p class="md-p">a &lt; b 且 b &gt; 0</p>')).toBe('<p class="md-p">a &lt; b 且 b &gt; 0</p>');
  });

  it("无转义 br 时原样返回", () => {
    const html = '<p class="md-p">普通段落</p>';
    expect(restore(html)).toBe(html);
  });
});
