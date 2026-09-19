// 第三批导航重构后，L1 的行序列唯一真源是 buildLibraryRows（数据源 = bases + knowledge_bases）。
// 这里锁定它的四条口径：
//   ① 空分组不渲染标题行（空标题是噪音）；
//   ② 顺序固定「数据库 → 知识库」，组内保持服务端顺序；
//   ③ 未自定义图标时原样回落 database / book（保证既有默认渲染零变化）；
//   ④ 自定义色只在自定义了图标时才连带（EntityIconPicker 的保守着色口径）。

import { describe, expect, it } from "vitest";
import {
  L1_GROUP_BASES,
  L1_GROUP_KBS,
  buildLibraryRows,
  libraryRowHeights,
  NAV_GROUP_ROW_H,
  NAV_ITEM_ROW_H,
  NAV_ROW_GAP,
} from "./menu-sections";

const base = (id: string, name: string, icon: string | null = null, iconColor: string | null = null) => ({
  id,
  name,
  icon,
  iconColor,
});

describe("buildLibraryRows（L1 行序列）", () => {
  it("空分组不渲染它的标题行", () => {
    const rows = buildLibraryRows([base("b1", "客户库")], []);
    expect(rows.filter((r) => r.kind === "group").map((r) => r.label)).toEqual([L1_GROUP_BASES]);
    expect(rows.some((r) => r.kind === "group" && r.label === L1_GROUP_KBS)).toBe(false);
  });

  it("两个都空 → 一行都不出（不渲染空 L1 骨架）", () => {
    expect(buildLibraryRows([], [])).toEqual([]);
  });

  it("顺序：先数据库后知识库，组内保持传入顺序（不自作主张排序）", () => {
    const rows = buildLibraryRows(
      [base("b2", "第二库"), base("b1", "第一库")],
      [base("k1", "产品知识库")],
    );
    expect(rows.map((r) => (r.kind === "group" ? `g:${r.label}` : `i:${r.label}`))).toEqual([
      `g:${L1_GROUP_BASES}`,
      "i:第二库",
      "i:第一库",
      `g:${L1_GROUP_KBS}`,
      "i:产品知识库",
    ]);
  });

  it("未自定义图标：base → database、kb → book，且不带色（零视觉变化红线）", () => {
    const rows = buildLibraryRows([base("b1", "客户库")], [base("k1", "知识库", null, "#0F6E56")]);
    const b = rows.find((r) => r.kind === "item" && r.entityId === "b1");
    const k = rows.find((r) => r.kind === "item" && r.entityId === "k1");
    expect(b).toMatchObject({ icon: "database", iconColor: undefined, entityKind: "base" });
    // 知识库建库时 iconColor 列就有历史底色，未换图标不得连带着色（保守口径）。
    expect(k).toMatchObject({ icon: "book", iconColor: undefined, entityKind: "kb" });
  });

  it("自定义图标生效；自定义色只在自定义了图标时才连带", () => {
    const rows = buildLibraryRows(
      [base("b1", "客户库", "star", "#AABBCC")],
      [base("k1", "知识库", "layers")],
    );
    expect(rows.find((r) => r.kind === "item" && r.entityId === "b1")).toMatchObject({
      icon: "star",
      iconColor: "#AABBCC",
    });
    // 换了图标但没给色 → 回落 undefined，由调用方决定默认前景色。
    expect(rows.find((r) => r.kind === "item" && r.entityId === "k1")).toMatchObject({
      icon: "layers",
      iconColor: undefined,
    });
  });

  it("非法 / 不在白名单的图标值一律回落默认，不许污染渲染", () => {
    const rows = buildLibraryRows([base("b1", "客户库", "notAnIcon", "#ABC")], []);
    expect(rows.find((r) => r.kind === "item" && r.entityId === "b1")).toMatchObject({
      icon: "database",
      iconColor: undefined,
    });
  });
});

describe("libraryRowHeights（变高虚拟化用）", () => {
  it("分组标题 24、菜单项 32，各自带 2px 行距 —— 定高虚拟化会漂移，必须逐行给", () => {
    const rows = buildLibraryRows([base("b1", "客户库")], [base("k1", "知识库")]);
    expect(rows).toHaveLength(4);
    expect(libraryRowHeights(rows)).toEqual([
      NAV_GROUP_ROW_H + NAV_ROW_GAP,
      NAV_ITEM_ROW_H + NAV_ROW_GAP,
      NAV_GROUP_ROW_H + NAV_ROW_GAP,
      NAV_ITEM_ROW_H + NAV_ROW_GAP,
    ]);
  });
});
