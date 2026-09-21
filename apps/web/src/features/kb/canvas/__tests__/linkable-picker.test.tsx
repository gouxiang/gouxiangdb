// 关联插入选择器的数据源回归（GET /api/linkable）。
//
// 锁的是不变式：**选择器只渲染后端返回的 items**——
// 后端已按库权限过滤，前端不得自行增减候选（既不能凭空造，也不能各自再过滤一遍）。
// 因此这里给 3 条伪造结果，断言页面只出现这 3 条。

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { LinkableItem } from "../../../../api/client";

const ITEMS: LinkableItem[] = [
  {
    id: "d1",
    type: "doc",
    title: "季度复盘",
    libraryId: "kb1",
    libraryName: "产品知识库",
    libraryKind: "kb",
    icon: null,
    iconColor: null,
    path: ["会议", "2026"],
    updatedAt: null,
  },
  {
    id: "c1",
    type: "canvas",
    title: "架构草图",
    libraryId: "kb1",
    libraryName: "产品知识库",
    libraryKind: "kb",
    icon: null,
    iconColor: null,
    path: [],
    updatedAt: null,
  },
  {
    id: "t1",
    type: "table",
    title: "客户台账",
    libraryId: "base1",
    libraryName: "销售库",
    libraryKind: "base",
    icon: null,
    iconColor: null,
    path: [],
    updatedAt: null,
  },
];

vi.mock("../canvas-context", () => ({
  useCanvasBoard: () => ({ ctx: { kbId: "kb1", canEdit: true } }),
}));

vi.mock("../linkable-hooks", () => ({
  LINKABLE_PICKABLE_TYPES: ["doc", "canvas", "table"],
  useLinkable: () => ({
    data: { items: ITEMS, truncated: false },
    isLoading: false,
    isError: false,
  }),
  useTableViews: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { CanvasLinkPicker } from "../CanvasLinkPicker";

function render() {
  return renderToString(
    <CanvasLinkPicker mode="standalone" anchor={{ x: 0, y: 0 }} onClose={() => {}} showPreviewType />,
  );
}

describe("CanvasLinkPicker 只渲染 /api/linkable 返回的 items", () => {
  it("三条结果全部出现，且没有任何额外候选", () => {
    const html = render();
    expect(html).toContain("季度复盘");
    expect(html).toContain("架构草图");
    expect(html).toContain("客户台账");
    // 未在响应里的对象一律不出现（前端不得自行补数据源）
    expect(html).not.toContain("未命名");
  });

  it("每条结果都带所属库名；path 非空时渲染面包屑", () => {
    const html = render();
    expect(html).toContain("产品知识库");
    expect(html).toContain("销售库");
    // path=["会议","2026"] → 面包屑
    expect(html).toContain("会议 / 2026");
  });

  it("truncated=false 时不出现「已截断」提示", () => {
    expect(render()).not.toContain("结果已截断");
  });
});
