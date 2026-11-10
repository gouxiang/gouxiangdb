// 宽布局视图设置的两条口径回归（node 环境，无 jsdom、无新增依赖）。
//
// 戴总反馈点：
//   ② 画廊封面 coverFieldId / 卡片字段 cardFieldIds 是画廊专属概念，只能在 gallery 出现；
//   ③ 字段全部移除/隐藏后，仍可通过「添加字段」搜索找回。
//
// 纯菜单函数做行为断言；组件接线（画廊块只在 gallery 挂、搜索候选集=全部字段）用源码断言锁定。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { viewSettingsTabs } from "../viewSettingsTabs";
import { applyVisibleOrder } from "../viewAdminFields";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("菜单按视图类型收敛", () => {
  it("form 类型有 form 项、无 display 项", () => {
    const keys = viewSettingsTabs("form").map((t) => t.key);
    expect(keys).toContain("form");
    expect(keys).not.toContain("display");
  });

  it("gallery 与其它非 form 类型都没有 form 项，且都含 display", () => {
    for (const type of ["grid", "gallery", "kanban", "calendar", "tree", "gantt", "detail", "chart"] as const) {
      const keys = viewSettingsTabs(type).map((t) => t.key);
      expect(keys).not.toContain("form");
      expect(keys).toContain("display");
    }
  });
});

describe("画廊专属块只在 gallery 视图挂载", () => {
  it("DataDisplaySection 用 view.type === \"gallery\" 门控 GalleryFieldsSection", () => {
    const src = read("../sections/DataDisplaySection.tsx");
    expect(src).toContain('view.type === "gallery"');
    expect(src).toContain("GalleryFieldsSection");
  });

  it("封面/卡片字段只存在于 GalleryFieldsSection（其它 Section 不出现这两项）", () => {
    const gallery = read("../sections/GalleryFieldsSection.tsx");
    expect(gallery).toContain("coverFieldId");
    expect(gallery).toContain("cardFieldIds");
    // 类型专属字段块与详情块不得引用画廊概念。
    const typeSpecific = read("../sections/TypeSpecificFieldsSection.tsx");
    expect(typeSpecific).not.toContain("coverFieldId");
    expect(typeSpecific).not.toContain("cardFieldIds");
    const detail = read("../sections/DetailVisibilitySection.tsx");
    expect(detail).not.toContain("coverFieldId");
    expect(detail).not.toContain("cardFieldIds");
  });
});

describe("隐藏字段可通过完整列序找回", () => {
  it("applyVisibleOrder：可见列重排，隐藏列按原相对顺序保留在末尾（取消隐藏即可找回）", () => {
    const order = ["a", "b", "c", "d"];
    const hidden = ["c"];
    // 用户把可见列 b 移到 a 前。
    const next = applyVisibleOrder(order, hidden, ["b", "a", "d"]);
    expect(next).toEqual(["b", "a", "d", "c"]);
  });

  it("FieldPickList 的候选集是该表全部字段，搜索按字段名过滤（不随隐藏而消失）", () => {
    const src = read("../FieldPickList.tsx");
    // 候选 = fields 中未选字段再按 query 过滤；fields 由调用方传全部可用字段。
    expect(src).toContain("fields.filter");
    expect(src).toContain("f.name.toLowerCase().includes(q)");
  });
});
