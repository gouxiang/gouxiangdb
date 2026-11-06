// S5 第一步：文档块 round-trip golden（**移动 packages/blocks 之前先绿**）
//
// 目的：把 blocks.ts / markdown.ts 从 apps/web 搬到共享包之前，先固化"Markdown ↔ Block 双向转换"
// 的既有行为，移动后重跑本文件必须逐字节一致——否则说明搬运改变了行为。
//
// 判据（不依赖我对"规范形态"的假设）：
//   ① 幂等稳定：md1 = blocksToMd(mdToBlocks(input))；md2 = blocksToMd(mdToBlocks(md1))；md2 === md1
//      —— 只要解析/序列化任意一侧在搬运中被改动，本断言就会红。
//   ② 结构保真：对可判定的特征做显式断言（表格合并 spans、任务勾选、align、代码语言、图片地址等）。

import { describe, expect, it } from "vitest";
import { mdToBlocks, blocksToMd, type Block } from "@gx/blocks";

/** 取 round-trip 的稳定形态与块序列。 */
function rt(input: string): { md1: string; md2: string; blocks: Block[] } {
  const blocks = mdToBlocks(input);
  const md1 = blocksToMd(blocks);
  const md2 = blocksToMd(mdToBlocks(md1));
  return { md1, md2, blocks };
}

const SAMPLES: Array<{ name: string; md: string }> = [
  { name: "① 标题 + 段落 + 行内标记", md: "# 一级标题\n\n正文含 **粗**、*斜*、~~删~~、`code` 与 [链接](https://example.com)。\n" },
  { name: "② 无序/有序列表", md: "- 甲\n- 乙\n  - 乙一\n\n1. 一\n2. 二\n" },
  { name: "③ 任务列表", md: "- [x] 已完成\n- [ ] 未完成\n- [ ] 未完成二\n" },
  { name: "④ 引用块", md: "> 引用第一行\n> 引用第二行\n" },
  { name: "⑤ 代码块", md: "```ts\nconst a: number = 1;\nconsole.log(a);\n```\n" },
  { name: "⑥ 表格（普通）", md: "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |\n| 李四 | 25 |\n" },
  { name: "⑦ 图片", md: "![截图说明](https://example.com/a.png)\n" },
  { name: "⑧ 分隔线 + 多个段落", md: "第一段\n\n第二段\n\n---\n\n第三段\n" },
  { name: "⑨ 混合长文（表格+列表+代码+图片）", md: "# 报告\n\n| 项 | 值 |\n| --- | --- |\n| A | 1 |\n\n- 要点一\n- 要点二\n\n```js\nrun();\n```\n\n![图](https://example.com/b.png)\n" },
  { name: "⑩ 空文档与纯空白", md: "" },
  // 内嵌画布/数据表围栏：协同防丢链路依赖 lang + 体内稳定 id 往返不被规范化破坏，纳入 golden 基线。
  { name: "⑪ 画布内嵌围栏（canvas-embed + docId）", md: "```canvas-embed\ndocAbC123\n```\n" },
  { name: "⑫ 数据表内嵌围栏（table-embed + tableId/viewId）", md: "```table-embed\ntblXy01\nvewZ9\n```\n" },
  { name: "⑬ 数据表内嵌围栏（无 viewId，体内仅 tableId）", md: "```table-embed\ntblOnly7\n```\n" },
];

describe("S5-1 文档块 round-trip golden（搬运前基线）", () => {
  for (const s of SAMPLES) {
    it(`${s.name}：幂等稳定（二次 round-trip 与首次逐字节一致）`, () => {
      const { md1, md2 } = rt(s.md);
      expect(md2, `首次=${JSON.stringify(md1)}`).toBe(md1);
    });
  }

  it("表格合并标记保真（[[RxC]] 锚点 + :: 被覆盖格）", () => {
    const md = "| A | B |\n| --- | --- |\n| [[1x2]] 合并 | :: |\n";
    const { md1, blocks } = rt(md);
    const table = blocks.find((b) => b.type === "table");
    expect(table, "应解析出 table 块").toBeTruthy();
    expect(Object.keys(table?.spans ?? {}).length, `spans=${JSON.stringify(table?.spans)}`).toBeGreaterThan(0);
    expect(md1).toContain("[[1x2]]");
  });

  it("任务勾选态保真", () => {
    const { blocks, md1 } = rt("- [x] 甲\n- [ ] 乙\n");
    const tasks = blocks.filter((b) => b.type === "task");
    expect(tasks.map((t) => t.checked)).toEqual([true, false]);
    expect(md1).toContain("[x]");
  });

  it("代码块语言保真", () => {
    const { blocks } = rt("```python\nprint(1)\n```\n");
    const code = blocks.find((b) => b.type === "code");
    expect(code?.lang).toBe("python");
    expect(code?.code).toContain("print(1)");
  });

  it("图片地址与 alt 保真", () => {
    const { blocks } = rt("![说明文字](https://example.com/x.png)\n");
    const img = blocks.find((b) => b.type === "image");
    expect(img?.src).toBe("https://example.com/x.png");
    expect(img?.alt).toBe("说明文字");
  });

  it("align 注释通道保真（left/center/right）", () => {
    const input = "<!-- align:center -->\n居中段落\n";
    const { blocks } = rt(input);
    const p = blocks.find((b) => b.type === "p" && (b.text ?? "").includes("居中段落"));
    expect(p?.align, `blocks=${JSON.stringify(blocks.map((b) => ({ t: b.type, a: b.align })))}`).toBe("center");
  });

  it("画布内嵌围栏往返保真（lang=canvas-embed，体内 docId 不被规范化）", () => {
    const input = "```canvas-embed\ndocAbC123\n```\n";
    const { blocks, md1, md2 } = rt(input);
    const fence = blocks.filter((b) => b.type === "code");
    expect(fence).toHaveLength(1);
    expect(fence[0]?.lang).toBe("canvas-embed");
    expect(fence[0]?.code).toBe("docAbC123");
    // 稳定形态必须仍能被 mentions.extractCanvasEmbeds 的围栏协议识别（逐字节保留）。
    expect(md1).toBe("```canvas-embed\ndocAbC123\n```\n");
    expect(md2).toBe(md1);
  });

  it("数据表内嵌围栏往返保真（含 viewId：体内两行 tableId/viewId 完整保留）", () => {
    const input = "```table-embed\ntblXy01\nvewZ9\n```\n";
    const { blocks, md1, md2 } = rt(input);
    const fence = blocks.filter((b) => b.type === "code" && b.lang === "table-embed");
    expect(fence).toHaveLength(1);
    expect(fence[0]?.code).toBe("tblXy01\nvewZ9");
    expect(md1).toBe(input);
    expect(md2).toBe(md1);
  });

  it("数据表内嵌围栏往返保真（无 viewId：体内仅 tableId，不被补出空行）", () => {
    const input = "```table-embed\ntblOnly7\n```\n";
    const { blocks, md1, md2 } = rt(input);
    const fence = blocks.filter((b) => b.type === "code" && b.lang === "table-embed");
    expect(fence).toHaveLength(1);
    expect(fence[0]?.code).toBe("tblOnly7");
    expect(md1).toBe(input);
    expect(md2).toBe(md1);
  });
});
