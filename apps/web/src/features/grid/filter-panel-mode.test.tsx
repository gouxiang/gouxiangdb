// FilterPanel「简易 / 高级」双模式（node 环境：react-dom/server SSR + 纯渲染断言，无 jsdom）。
//
// 锁的是本次重构的纯渲染分支：
//   ① 顶部始终有「简易模式 / 高级模式」分段；模式由根节点推导（不额外存 mode）；
//   ② 根为空 or 条件组 → 简易模式：空态「暂无筛选条件」，不出现布尔提示；
//   ③ 根为 {kind:"formula"} → 高级模式：显著「公式必须返回布尔值」提示、FormulaBuilder
//      字段插入区、「打开完整公式编辑器」按钮、currentUser 如实告知；
//   ④ 空公式显示「未填写公式时不施加筛选」；非空公式把表达式渲染进输入区。
//
// 交互（切换确认弹窗、400ms 防抖、modal 打开）依赖事件/portal，SSR 下不触发，
// 故这里只断言【初始 value 直接刻画的可见性分支】，不做行为模拟。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { FieldDTO, FilterNode } from "@gx/shared-types";
import { FilterPanel } from "./FilterPanel";

const field = (id: string, name: string, type: string): FieldDTO =>
  ({ id, name, type }) as unknown as FieldDTO;

const formula = (expression: string): FilterNode => ({ kind: "formula", expression });
const group = (): FilterNode => ({ kind: "and", children: [] });

function renderPanel(fields: FieldDTO[], filters: FilterNode | null): string {
  return render(
    <FilterPanel fields={fields} value={filters} filteredTotal={0} onChange={() => {}} />,
  );
}

const fields = [field("s", "状态", "singleSelect"), field("n", "数量", "number")];

describe("FilterPanel 简易/高级分段", () => {
  it("顶部同时渲染两个分段标签", () => {
    const html = renderPanel(fields, null);
    expect(html).toContain("简易模式");
    expect(html).toContain("高级模式");
  });

  it("根为 null：推导为简易模式，显示空态，无布尔提示", () => {
    const html = renderPanel(fields, null);
    expect(html).toContain("暂无筛选条件");
    expect(html).not.toContain("公式必须返回布尔值");
    expect(html).not.toContain("打开完整公式编辑器");
  });

  it("根为条件组：推导为简易模式，不渲染高级公式部件", () => {
    const html = renderPanel(fields, group());
    expect(html).toContain("暂无筛选条件");
    expect(html).not.toContain("公式必须返回布尔值");
  });
});

describe("FilterPanel 高级模式（formula 根节点）", () => {
  it("根为空 formula：推导为高级模式并渲染布尔提示/构建器/完整编辑器入口", () => {
    const html = renderPanel(fields, formula(""));
    expect(html).toContain("公式必须返回布尔值");
    expect(html).toContain("插入字段");
    expect(html).toContain("打开完整公式编辑器");
    // 简易模式空态不应出现
    expect(html).not.toContain("暂无筛选条件");
  });

  it("空公式显示「未填写公式时不施加筛选」", () => {
    const html = renderPanel(fields, formula("   "));
    expect(html).toContain("未填写公式时不施加筛选");
  });

  it("非空公式：表达式渲染进输入区，字段名作为可插入项出现", () => {
    const expr = '{状态} = "已完成" && {数量} > 0';
    const html = renderPanel(fields, formula(expr));
    expect(html).toContain("已完成");
    expect(html).toContain("状态");
    expect(html).toContain("数量");
    // 非空不再显示空白放行提示
    expect(html).not.toContain("未填写公式时不施加筛选");
  });

  it("如实告知公式没有内置 currentUser", () => {
    const html = renderPanel(fields, formula(""));
    expect(html).toContain("公式没有内置");
  });
});
