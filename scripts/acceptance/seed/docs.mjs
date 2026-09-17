// scripts/acceptance/seed/docs.mjs
// 构造 >=10 篇 Markdown 正文的确定性内容（五形态全覆盖）。纯函数：给定 id/rng 返回字符串。
// 形态：表格、任务勾选、align 注释、图片、raw HTML、内链五形态、iframe/嵌入、接近上限长文。
// 升级前后这些 md 必须逐字节一致，且 mdToBlocks->blocksToMd round-trip 0 diff。

/**
 * 10 篇文档的确定性正文。key=docKey，value={title, content}。
 * 所有引用 token/画布 id 由 manifest 注入，保证内容本身在播种期已最终定型。
 * @param {object} refs
 * @param {string} refs.canvasIdDeep  深 3 闭包那块画布的 id（内链用）
 * @param {string} refs.docSiblingId  另一篇文档 id（内链用）
 * @param {string} refs.publicHostBase 公开链接 host 基串（仅写进 md 文本，不要求可达）
 */
export function buildDocs(refs) {
  const docs = [];

  docs.push({
    key: "table",
    title: "形态1-表格",
    content: [
      "# 数据表形态",
      "",
      "下面是一张含中文表头与多字节内容的表格：",
      "",
      "| 编号 | 名称 | 数值 | 备注 |",
      "| --- | --- | ---: | --- |",
      "| 1 | 苹果 | 12.5 | 红富士 |",
      "| 2 | 香蕉 | 8 | 进口 |",
      "| 3 | 荔枝 | 300 | 岭南佳果，Unicode 测试 🍈 |",
      "",
      "表尾段落，确认表格闭合后正文不被吞。",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "tasks",
    title: "形态2-任务勾选",
    content: [
      "# 任务清单",
      "",
      "- [x] 已完成项 A",
      "- [x] 已完成项 B（含缩进子项）",
      "  - [x] 子任务 B1",
      "- [ ] 未完成项 C",
      "- [ ] 未完成项 D",
      "",
      "1. [x] 有序列表中的勾选 1",
      "2. [ ] 有序列表中的勾选 2",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "align",
    title: "形态3-align注释",
    content: [
      "# 对齐注释",
      "",
      "段落前的对齐注释（v1 兼容语法）：",
      "",
      "<!-- align: center -->",
      "这一行应当居中显示",
      "",
      "<!-- align: right -->",
      "右对齐行",
      "",
      "普通段落恢复默认对齐。",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "image",
    title: "形态4-图片",
    content: [
      "# 图片形态",
      "",
      "行内图片：",
      "",
      "![示意图](/uploads/at/drill_img_1.png)",
      "",
      "带标题图片：",
      "",
      '![边界图](/uploads/at/drill_bin_2.bin "2MB 边界附件")',
      "",
      "引用样式图片：",
      "",
      "[fig1]: /uploads/at/drill_img_2.png",
      "",
      "见 ![fig1][fig1]。",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "rawhtml",
    title: "形态5-rawHTML",
    content: [
      "# 原生 HTML",
      "",
      "<div class=\"callout\" data-drill=\"true\">",
      "  <p>这是一段 <strong>raw HTML</strong>，含属性与嵌套。</p>",
      "</div>",
      "",
      "<br>",
      "",
      "<span style=\"font-weight:600\">加粗 span</span> 与 <code>inline code</code>。",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "links",
    title: "形态6-内链五形态",
    content: [
      "# 内链五形态",
      "",
      `1. 文档互链：[兄弟文档](${refs.publicHostBase}/api/kb/docs/${refs.docSiblingId})`,
      `2. 画布链接：[深三画布](/kb/canvas/${refs.canvasIdDeep})`,
      "3. 外部链接：[外部 HTTPS](https://example.com/path?q=1&lang=zh)",
      "4. 页内锚点：[回到顶部](#内链五形态)",
      "5. 缺失链接：[已删除目标](/kb/doc/drill_doc_deleted_target)",
      "",
      "裸链自动识别：https://example.com/bare/link",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "iframe",
    title: "形态7-iframe嵌入",
    content: [
      "# iframe 与嵌入",
      "",
      '<iframe src="https://example.com/embed/1" width="640" height="360"></iframe>',
      "",
      "```html",
      "<iframe src=\"https://example.com/embed/code-block\"></iframe>",
      "```",
      "",
      "> 引用块中的嵌入说明文字。",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "mixed",
    title: "形态8-混合排版",
    content: [
      "# 混合排版",
      "",
      "## 二级标题",
      "",
      "- 列表项含 `代码` 与 **加粗** 与 *斜体* 与 ~~删除线~~",
      "- 数学符号 ≠ ≤ ≥ 中文标点，；：「」",
      "",
      "> 多级引用",
      ">",
      "> > 第二级引用",
      "",
      "```ts",
      "const sum = (a: number, b: number): number => a + b;",
      "```",
      "",
      "| 列A | 列B |",
      "| --- | --- |",
      "| -1 | 长文本单元，含逗号、句号。 |",
      "",
    ].join("\n"),
  });

  docs.push({
    key: "unicode",
    title: "形态9-多字节边界",
    content: [
      "# 多字节与空白边界",
      "",
      "Emoji 序列：👨‍👩‍👧‍👦 🏳️‍🌈 👍🆗🆕",
      "混合：中英混排 ABC 汉字 123，全角字符（）【】《》！？",
      "Tab\t与多个空格    以及 不换行空格。",
      "引号 \"双引\" '单引' \"花引\" 竖线 | 反斜杠 \\ 百分号 %",
      "",
    ].join("\n"),
  });

  return docs;
}

/**
 * 第 10 篇：接近长度上限的长文（确定性填充），单独给出以便控制长度。
 * @param {() => number} rng
 * @param {number} targetChars 目标字符数（保持远小于 10MB 上限，聚焦长文档 round-trip）
 */
export function buildLongDoc(rng, targetChars = 20000) {
  const lines = ["# 形态10-接近上限长文", ""];
  let n = 0;
  let i = 0;
  while (n < targetChars) {
    const para = `段落 ${i}：${deterministicParagraph(rng, 220)}`;
    lines.push(para, "");
    n += para.length + 1;
    i++;
  }
  return { key: "long", title: "形态10-接近上限长文", content: lines.join("\n") };
}

function deterministicParagraph(rng, len) {
  const pool = "九宫格变更需求讨论记录包含字段类型关联公式聚合查阅与权限继承等关键词，确保长文可被搜索索引并在升级后逐字节保留。";
  let out = "";
  for (let i = 0; i < len; i++) out += pool[Math.floor(rng() * pool.length)];
  return out;
}
