// 窄屏工具栏回归（node 环境，react-dom/server + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是 P1-A（D-1）三条结论：
//   ① 断行根因已除：工具按钮一律 `shrink-0` + `whitespace-nowrap`（原来两个都没有 →
//      窄屏 flex 子项被压到内容宽度以下，中文逐字断行、每字一行）。
//   ② 窄屏收起的是「入口」不是「功能」：<1024 收起 行高 / 字段 / 行颜色，<768 再收起
//      筛选 / 分组 / 排序；溢出菜单里每个被收起的按钮都有可点等价项（功能优先红线）。
//   ③ 桌面（≥1024）按钮集合与文案一字未动。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { FieldDTO, ViewConfig } from "@gx/shared-types";
import { GridToolbar } from "./GridToolbar";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

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

function renderToolbar() {
  return render(
    <GridToolbar
      config={config}
      allFields={[field("f1", "名称"), field("f2", "部门")]}
      filteredTotal={2}
      permissions={{ canEditData: true, canManageSchema: true }}
      selectionCount={0}
      onUpdateConfig={noop}
      onNewRecord={noop}
      onBulkDelete={noop}
      onBulkEdit={noop}
      onSelectAllPage={noop}
      onClearSelection={noop}
      onImport={noop}
      onExport={noop}
      onCopyView={noop}
      onClearTable={noop}
      onEditField={noop}
    />,
  );
}

describe("P1-A 根因：按钮不再被压到内容宽度以下", () => {
  it("每个工具按钮都带 shrink-0 + whitespace-nowrap（7 个：行高/字段/筛选/分组/排序/行颜色/更多）", () => {
    const html = renderToolbar();
    expect(countOf(html, "whitespace-nowrap rounded-gx-lg")).toBe(7);
    expect(countOf(html, "inline-flex h-8 shrink-0 items-center")).toBe(7);
  });
});

describe("P1-A 收起入口：窄屏只收按钮，不删功能", () => {
  it("<1024 收起 行高 / 字段 / 行颜色（容器 hidden lg:block）", () => {
    const html = renderToolbar();
    // 3 个被收起的按钮容器 + 1 条随字段一起收起的竖分隔线
    expect(countOf(html, "relative hidden lg:block")).toBe(3);
    expect(countOf(html, "hidden shrink-0 bg-gx-separator lg:block")).toBe(1);
  });

  it("<768 再收起 筛选 / 分组 / 排序（容器 hidden md:block，768–1023 仍常驻）", () => {
    const html = renderToolbar();
    expect(countOf(html, "relative hidden md:block")).toBe(3);
  });

  it("桌面（≥1024）按钮一个不少：新建记录 / 行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色 / 更多", () => {
    const html = renderToolbar();
    for (const label of ["新建记录", "行高", "字段", "筛选", "分组", "排序", "行颜色", "更多"]) {
      expect(html).toContain(label);
    }
  });

  it("被收起的 6 个按钮在溢出菜单里都有可点等价项（同一 icon + 同一文案）", () => {
    const src = read("./GridToolbar.tsx");
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
    const src = read("./GridToolbar.tsx");
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
});
