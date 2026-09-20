// H-04 回归：合并文档里的同名标题必须拥有唯一锚点（slug 撞车 → 目录跳错 / key 重复 / 过滤残留）。
//
// 现象：点击目录里的第二个「全局搜索」跳到第一个；目录搜索结果里多出「全局搜索」
//      「需补截图清单」等无关项（同名 slug 撞车导致的 React key 重复）。
// 根因：两处 `## 全局搜索` 算出同一个 slug → 同一个 id，第二个章节没有自己的锚点。
// 修法：extractHelpHeadings 对重复 slug 追加 -2 / -3 序号（文本与层级不变）；
//      过滤逻辑抽成 filterHelpHeadings 供目录与单测共用。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildHelpHtml, extractHelpHeadings, filterHelpHeadings } from "../help-html";

/** 真源产物（sync 脚本生成） */
const realHelpMd = () =>
  readFileSync(new URL("../../../../src/features/help/generated/help-center.md", import.meta.url), "utf8");

const MD_DUP = [
  "# 帮助中心",
  "",
  "## 全局搜索",
  "",
  "第一段。",
  "",
  "## 需补截图清单",
  "",
  "中段。",
  "",
  "## 全局搜索",
  "",
  "第二段（同名，另一处分节）。",
].join("\n");

describe("H-04：同名标题的锚点唯一", () => {
  it("重复 slug 追加 -2 序号：id 两两不同，文本与层级不变", () => {
    const headings = extractHelpHeadings(MD_DUP);
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith("h-全局搜索")).sort()).toEqual([
      "h-全局搜索",
      "h-全局搜索-2",
    ]);
    expect(headings.filter((h) => h.text === "全局搜索")).toHaveLength(2);
  });

  it("两个同名章节各自拥有独立 DOM 锚点（点第二个不再跳到第一个）", () => {
    const { html, headings } = buildHelpHtml(MD_DUP, "");
    // 用 `<h2 id="…"` 精确计数：正文里还有 renderMarkdown 自带的 data-heading-id
    // （它仍是旧的同名 slug，正是因为撞车才需要序号去重）
    expect(html.match(/<h2 id="h-全局搜索"/g) ?? []).toHaveLength(1);
    expect(html.match(/<h2 id="h-全局搜索-2"/g) ?? []).toHaveLength(1);
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
    expect(html.indexOf('id="h-全局搜索-2"')).toBeGreaterThan(html.indexOf('id="h-全局搜索"'));
  });

  it("目录过滤只返回命中项，不因 id 撞车残留无关项", () => {
    const headings = extractHelpHeadings(MD_DUP);
    expect(filterHelpHeadings(headings, "全局搜索").map((h) => h.text)).toEqual([
      "全局搜索",
      "全局搜索",
    ]);
    expect(filterHelpHeadings(headings, "清单").map((h) => h.text)).toEqual(["需补截图清单"]);
    expect(filterHelpHeadings(headings, "MCP")).toEqual([]);
    // 空串/纯空格 = 全量，且返回副本（不共享引用）
    expect(filterHelpHeadings(headings, "  ")).toHaveLength(headings.length);
  });

  it("现役真源文档的所有锚点 id 两两不同", () => {
    const { html, headings } = buildHelpHtml(realHelpMd(), "");
    expect(headings.length).toBeGreaterThan(20);
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
  });
});
