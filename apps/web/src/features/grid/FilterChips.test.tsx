// v6 #984 FilterChips SSR 冒烟（node 环境，react-dom/server，无 jsdom）。
// 只锁渲染结构与回调落点的存在性：字段名 + b 操作符 + 值 + 圆 ×；fadd 常驻；
// 无 chips 时不渲 chip 但仍有「+ 添加筛选」（添加入口不丢）。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { FilterChips } from "./FilterChips";
import type { FilterChip } from "./filter-chips";

const condChip = (over: Partial<FilterChip> = {}): FilterChip => ({
  key: "cond-0",
  path: [0],
  kind: "cond",
  label: "状态",
  opLabel: "是",
  valueText: "进行中",
  ...over,
});

describe("FilterChips SSR 冒烟", () => {
  it("有条件 chip：渲染字段名、操作符（b）、值与可点的圆 ×", () => {
    const html = render(
      <FilterChips
        chips={[condChip()]}
        onRemove={() => undefined}
        onClearAll={() => undefined}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("状态");
    expect(html).toContain("<b>是</b>");
    expect(html).toContain("进行中");
    expect(html).toContain('class="gx-fchip"');
    expect(html).toContain('class="gx-fchip-x"');
    expect(html).toContain('aria-label="移除筛选条件：状态 是 进行中"');
  });

  it("无 chips：不渲染 gx-fchip，但「+ 添加筛选」常驻", () => {
    const html = render(
      <FilterChips chips={[]} onRemove={() => undefined} onClearAll={() => undefined} onAdd={() => undefined} />,
    );
    expect(html).not.toContain('class="gx-fchip"');
    expect(html).toContain("gx-fadd");
    expect(html).toContain("+ 添加筛选");
  });

  it("formula chip 的 × 标注为「清除全部筛选条件」", () => {
    const html = render(
      <FilterChips
        chips={[{ key: "formula-0", path: [0], kind: "formula", label: "高级筛选条件", clearAll: true }]}
        onRemove={() => undefined}
        onClearAll={() => undefined}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("高级筛选条件");
    expect(html).toContain('title="清除全部筛选条件"');
  });
});
