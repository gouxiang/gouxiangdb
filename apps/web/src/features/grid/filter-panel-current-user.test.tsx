// FilterPanel「当前用户」值类型切换（node 环境：react-dom/server SSR + 纯渲染断言，无 jsdom、无新增依赖）。
//
// 锁的是本次交互的三条纯逻辑：
//   ① 人名字段（createdBy / lastModifiedBy）出现「当前用户」档，且选中后值区是不可编辑的
//      「当前登录用户」提示（不再是文本输入框）；
//   ② 非人物字段（文本等）不出现「当前用户」档（不能给无关字段选动态用户）；
//   ③ 切回「自定义」档后恢复普通值输入框。
// onChange 在 SSR 下不触发，故档位【可见性/选中态】通过初始 value 直接刻画 —— 这正是
// 「值类型切换」渲染分支的真证据，不是源码字符串猜测。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { FieldDTO, FilterNode } from "@gx/shared-types";
import { FilterPanel } from "./FilterPanel";

const field = (id: string, name: string, type: string): FieldDTO =>
  ({ id, name, type }) as unknown as FieldDTO;

const condition = (fieldId: string, over: Record<string, unknown> = {}): FilterNode =>
  ({ kind: "condition", fieldId, op: "is", value: "", ...over }) as FilterNode;

/** 面板根是 and 组：把单条件包进一层 AND。 */
const groupWith = (c: FilterNode): FilterNode => ({ kind: "and", children: [c] });

function renderPanel(fields: FieldDTO[], filters: FilterNode | null): string {
  return render(
    <FilterPanel fields={fields} value={filters} filteredTotal={0} onChange={() => {}} />,
  );
}

describe("FilterPanel 当前用户档（人名字段）", () => {
  it("createdBy：出现「当前用户」档", () => {
    const html = renderPanel([field("c", "创建人", "createdBy")], groupWith(condition("c")));
    expect(html).toContain("当前用户");
  });

  it("lastModifiedBy：出现「当前用户」档", () => {
    const html = renderPanel([field("e", "修改人", "lastModifiedBy")], groupWith(condition("e")));
    expect(html).toContain("当前用户");
  });

  it("选中 dynamic/currentUser：值区是「当前登录用户」提示", () => {
    const html = renderPanel(
      [field("c", "创建人", "createdBy")],
      groupWith(condition("c", { valueType: "dynamic", dynamicValue: "currentUser" })),
    );
    expect(html).toContain("当前登录用户");
  });

  it("非人物字段（singleLineText）不出现「当前用户」档", () => {
    const html = renderPanel([field("n", "名称", "singleLineText")], groupWith(condition("n")));
    expect(html).not.toContain("当前用户");
  });

  it("非人物字段即便 valueType=dynamic 也不渲染「当前登录用户」提示（不支持组合）", () => {
    const html = renderPanel(
      [field("n", "名称", "singleLineText")],
      groupWith(condition("n", { valueType: "dynamic", dynamicValue: "currentUser" })),
    );
    expect(html).not.toContain("当前登录用户");
  });

  it("切回「自定义」（literal）：恢复普通值输入，不显示当前用户提示", () => {
    const html = renderPanel(
      [field("c", "创建人", "createdBy")],
      groupWith(condition("c", { valueType: "literal", value: "张三" })),
    );
    expect(html).not.toContain("当前登录用户");
    // 仍保留档位入口，可再次切换
    expect(html).toContain("当前用户");
  });
});
