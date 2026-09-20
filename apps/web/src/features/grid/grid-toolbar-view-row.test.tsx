// 视图切换器「独占整行」回归（node 环境，react-dom/server + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是本轮唯一的布局改动：
//   ① 宿主经 leading 传入的视图切换器渲染在**独立的一行**（data-gx-toolbar-view-row），
//      不再与搜索框 / 导入 / 导出 / 更多共用同一条工具栏 —— 视图变多时选项卡有整行横向空间。
//   ② 这一行排在搜索行**之前**，且自身横向可伸展（min-w-0），不被右侧按钮挤压。
//   ③ 不传 leading 时这一行整体不渲染（其它没有视图切换器的宿主不留下空行）。
//
// 断言口径与同目录既有测试一致：能 SSR 的一律真渲染后断言 DOM 顺序，不做源码字符串猜测。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { FieldDTO, ViewConfig } from "@gx/shared-types";
import { GridToolbar } from "./GridToolbar";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

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

function renderToolbar(leading?: React.ReactNode) {
  return render(
    <GridToolbar
      config={config}
      leading={leading}
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

describe("① 视图切换器独占一行", () => {
  it("leading 落在独立的视图行容器内（data-gx-toolbar-view-row）", () => {
    const html = renderToolbar(<span>__VIEW_SWITCHER__</span>);
    expect(html).toContain("data-gx-toolbar-view-row");
    const rowStart = html.indexOf("data-gx-toolbar-view-row");
    const marker = html.indexOf("__VIEW_SWITCHER__");
    expect(rowStart).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(rowStart);
    // 视图行的闭合早于搜索框出现 → 两者不在同一个 flex 行里
    expect(html.indexOf("</div>", marker)).toBeLessThan(html.indexOf("搜索此视图"));
  });

  it("视图行排在搜索 / 导入 / 导出 / 更多之前，且自身可横向伸展（min-w-0）", () => {
    const html = renderToolbar(<span>__VIEW_SWITCHER__</span>);
    const rowStart = html.indexOf("data-gx-toolbar-view-row");
    expect(rowStart).toBeLessThan(html.indexOf("搜索此视图"));
    expect(rowStart).toBeLessThan(html.indexOf("导入"));

    // 行容器带 min-w-0：选项卡区（overflow-x-auto）才能真正吃满剩余宽度而不撑破布局
    const rowSeg = html.slice(rowStart, html.indexOf("搜索此视图"));
    expect(rowSeg).toContain("min-w-0");
  });
});

describe("② 不传 leading 时不留空行", () => {
  it("未装配视图切换器 → 视图行整体不渲染", () => {
    const html = renderToolbar();
    expect(html).not.toContain("data-gx-toolbar-view-row");
    // 其余三行照旧
    expect(html).toContain("搜索此视图");
    expect(html).toContain("新建记录");
  });
});

describe("③ 源码护栏：视图行不回退到与搜索框同排", () => {
  it("GridToolbar 里 leading 只在视图行渲染一次（不再出现在工具按钮行）", () => {
    const src = read("./GridToolbar.tsx");
    // 唯一的渲染点是视图行容器；旧实现里 {leading} + 竖分隔线同排的写法已移除
    expect(src).toContain("data-gx-toolbar-view-row");
    expect(src).not.toContain("{leading && <div className=\"h-5 w-px shrink-0 bg-gx-separator\" />}");
    // 搜索行不再靠 ml-auto 顶到右侧（leading 出列后左聚，与第二行的新建记录同侧）
    expect(src).not.toContain("ml-auto flex min-w-0 flex-1 md:flex-none");
  });
});
