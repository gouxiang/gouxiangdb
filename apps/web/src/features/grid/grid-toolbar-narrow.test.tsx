// 窄屏工具栏回归（node 环境，react-dom/server + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是 P1-A（D-1）三条结论：
//   ① 断行根因已除：工具按钮一律 `shrink-0` + `whitespace-nowrap`（原来两个都没有 →
//      窄屏 flex 子项被压到内容宽度以下，中文逐字断行、每字一行）。
//   ② 窄屏收起的是「入口」不是「功能」：<1440 收起 行高 / 字段 / 行颜色，<768 再收起
//      筛选 / 分组 / 排序；溢出菜单里每个被收起的按钮都有可点等价项（功能优先红线）。
//   ③ 桌面按钮集合与文案一字未动。
//
// 2026-09-21 行合并后的归属（统一外壳 ViewShell 三行结构）：
//   · 外壳第二行（GridToolbar.tsx，六类视图共用）= 新建记录 + 搜索 / 导入 / 导出 / 表级「更多」
//   · 外壳第三行（GridToolbarSettingsRow.tsx，仅 grid）= 六个呈现设置项 + 它自己的溢出菜单
//   两行各有各的「更多」：第二行装表级操作（复制视图 / 清空表），第三行装被收起的设置项。
//   断言因此对**两行分别渲染**，再拼起来看「一份内联按钮 + 一份菜单项」的全貌。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { FieldDTO, ViewConfig } from "@gx/shared-types";
import { GridToolbar } from "./GridToolbar";
import GridToolbarSettingsRow from "./GridToolbarSettingsRow";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;
/**
 * 工具栏的源码断言一律对「GridToolbar + GridToolbarSettingsRow」两个文件生效。
 * 改断言原因：设置项下移成独立一行后，内联按钮（行高/字段/筛选/分组/排序/行颜色）与它们
 * 的「更多」等价项都在 GridToolbarSettingsRow.tsx（单文件 ≤300 行公约要求拆分），
 * 表级操作在 GridToolbar.tsx。断言语义一字未变——拼起来才是工具栏全貌。
 */
const toolbarSrc = () => read("./GridToolbar.tsx") + "\n" + read("./GridToolbarSettingsRow.tsx");

const field = (id: string, name: string): FieldDTO =>
  ({ id, name, type: "text", options: null, order: 0 }) as unknown as FieldDTO;

const config: ViewConfig = {
  hiddenFieldIds: [],
  fieldOrder: [],
  rowHeight: "medium",
  filters: null,
  sorts: [],
  search: "",
  groupByFieldId: null,
  collapsedGroupKeys: [],
  aggregations: {},
  rowColor: { mode: "none", fieldId: null, rules: [] },
  coverFieldId: null,
} as unknown as ViewConfig;

const noop = () => undefined;

/** 外壳第二行（六类视图共用） */
function renderToolbar() {
  return render(
    <GridToolbar
      config={config}
      permissions={{ canEditData: true, canManageSchema: true }}
      onUpdateConfig={noop}
      onNewRecord={noop}
      onImport={noop}
      onExport={noop}
      onCopyView={noop}
      onClearTable={noop}
    />,
  );
}

/** 外壳第三行（仅网格：六个呈现设置项 + 自己的溢出菜单） */
function renderSettingsRow() {
  return render(
    <GridToolbarSettingsRow
      config={config}
      allFields={[field("f1", "名称"), field("f2", "部门")]}
      filteredTotal={2}
      permissions={{ canEditData: true, canManageSchema: true }}
      onUpdateConfig={noop}
      onEditField={noop}
    />,
  );
}

describe("P1-A 根因：按钮不再被压到内容宽度以下", () => {
  it("第二行 3 个工具按钮（导入 / 导出 / 更多）仍带 shrink-0 + whitespace-nowrap", () => {
    // 改断言原因：行合并后「新建记录」升到第二行左端（它是 Button 不是 ToolButton），
    // 六个设置项留在第三行；本行只剩导入 / 导出 / 更多三个 ToolButton。
    const html = renderToolbar();
    expect(countOf(html, "whitespace-nowrap rounded-gx-lg")).toBe(3);
    expect(countOf(html, "inline-flex h-8 shrink-0 items-center")).toBe(3);
  });

  it("第三行 6 个设置按钮同样带 shrink-0 + whitespace-nowrap", () => {
    const html = renderSettingsRow();
    expect(countOf(html, "whitespace-nowrap rounded-gx-lg")).toBe(6);
    expect(countOf(html, "inline-flex h-8 shrink-0 items-center")).toBe(6);
  });

  it("导入 / 导出是常驻按钮且落在搜索框右侧（入口收敛后唯一入口）", () => {
    const html = renderToolbar();
    expect(html).toContain("导入");
    expect(html).toContain("导出");
    // 位置：两个按钮都排在搜索框（placeholder 搜索此视图…）之后
    expect(html.indexOf("导入")).toBeGreaterThan(html.indexOf("搜索此视图"));
    expect(html.indexOf("导出")).toBeGreaterThan(html.indexOf("搜索此视图"));
    // 「更多」菜单里不再重复挂这两项（同一能力不留两处入口）
    const src = toolbarSrc();
    expect(src).not.toContain('label="CSV 导入"');
    expect(src).not.toContain('label="CSV 导出"');
  });

  it("新建记录与搜索 / 导入 / 导出 / 更多同一行：新建记录在左，其余 ml-auto 靠右", () => {
    const html = renderToolbar();
    expect(html.indexOf("新建记录")).toBeLessThan(html.indexOf("搜索此视图"));
    // 右端组用 ml-auto 顶到最右，而不是靠 flex-1 平摊
    const src = read("./GridToolbar.tsx");
    expect(src).toContain("ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 md:flex-none");
  });
});

describe("P1-A 收起入口：窄屏只收按钮，不删功能", () => {
  it("<1024 收起 行高 / 字段 / 行颜色（容器 hidden lg:block）", () => {
    const html = renderSettingsRow();
    // 3 个被收起的按钮容器 + 1 条随字段一起收起的竖分隔线
    expect(countOf(html, "relative hidden lg:block")).toBe(3);
    expect(countOf(html, "hidden shrink-0 bg-gx-separator lg:block")).toBe(1);
  });

  it("<768 再收起 筛选 / 分组 / 排序（容器 hidden md:block，768–1023 仍常驻）", () => {
    const html = renderSettingsRow();
    expect(countOf(html, "relative hidden md:block")).toBe(3);
  });

  it("桌面按钮一个不少：新建记录 / 行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色 / 更多", () => {
    const html = renderToolbar() + renderSettingsRow();
    for (const label of ["新建记录", "行高", "字段", "筛选", "分组", "排序", "行颜色", "更多"]) {
      expect(html).toContain(label);
    }
  });

  it("被收起的 6 个按钮在溢出菜单里都有可点等价项（同一 icon + 同一文案）", () => {
    // 改断言原因：被收起的设置项不再挂到第二行的表级「更多」，而是第三行自己的溢出菜单，
    // 于是内联按钮与菜单项同在 GridToolbarSettingsRow.tsx 一个文件里（各一份）。
    const src = read("./GridToolbarSettingsRow.tsx");
    for (const [icon, label] of [
      ["rowHeight", "行高"],
      ["eye", "字段"],
      ["filter", "筛选"],
      ["group", "分组"],
      ["sortAsc", "排序"],
      ["palette", "行颜色"],
    ] as const) {
      // 内联按钮一份 + 菜单项一份（计数 ≥2：缺一份就说明功能被收没了）
      expect(countOf(src, `icon="${icon}"`)).toBeGreaterThanOrEqual(2);
      expect(countOf(src, `label="${label}"`)).toBeGreaterThanOrEqual(1);
    }
  });

  it("溢出菜单六个二级视图都能落到与内联按钮同一份面板（drill-down 不是空壳）", () => {
    const src = read("./GridToolbarSettingsRow.tsx");
    for (const view of ["rh", "fields", "filter", "group", "sort", "color"] as const) {
      expect(src).toContain(`setMoreView("${view}")`);
      expect(src).toContain(`moreView === "${view}" &&`);
    }
    // 面板变量内联/菜单共用一份，不出现两套实现
    expect(src).toContain("{rowHeightPanel}");
    expect(src).toContain("{fieldsPanel}");
  });

  it("搜索框 <768 随主轴伸缩、≥768 严格回到 170（R-I-03 不被窄屏改坏）", () => {
    const html = renderToolbar();
    expect(html).toContain("w-full md:w-[170px]");
    expect(html).not.toContain("width:170px");
  });

  it("第三行不做 overflow-x-auto（会把 Popover 的绝对定位浮层裁掉）", () => {
    expect(renderSettingsRow()).not.toContain("overflow-x-auto");
  });
});
