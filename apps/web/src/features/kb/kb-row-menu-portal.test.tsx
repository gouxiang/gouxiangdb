// 知识库列表行尾菜单裁剪回归（node 环境，纯源码断言，无 jsdom、无新增依赖）。
//
// 锁的是：行尾「…」菜单的四项（重命名 / 图标与颜色 / 独立权限 / 删除）必须可点。
// 裁剪来自两层祖先：列表卡片 overflow-hidden（:210）+ 外层滚动容器 overflow-y-auto（:195），
// 只去掉卡片的 overflow-hidden 不够（滚动容器照样裁），还会让行 hover 背景把圆角切成直角，
// 因此改走 Popover 的 fixed 模式（portal 到 body），卡片 DOM/CSS 一行不动。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("KB 首页行尾菜单不被列表裁剪", () => {
  const src = read("./KbHomePage.tsx");

  it("行菜单走 fixed（portal）模式并绑定触发按钮锚点", () => {
    expect(src).toContain("fixed\n");
    expect(src).toContain("anchorEl={rowMenuRefs.current[d.id] ?? null}");
  });

  it("触发按钮有 per-row 锚点 ref，关闭有抑制窗口（避免点了关不掉）", () => {
    expect(src).toContain("rowMenuRefs.current[d.id] = el;");
    expect(src).toContain("menuClosedAtRef.current");
  });

  it("卡片圆角/overflow 结构保持原样（不走「圆角下沉到首末行」那条路）", () => {
    // v6 #985：卡片对齐底板 .card（rounded-gx-2xl/hairline/shadow-gx-card），
    // 但守护的本质仍是「列表卡 overflow-hidden 不拆」——圆角档随底板升级，结构契约不变。
    expect(src).toContain(
      "overflow-hidden rounded-gx-2xl border border-gx-hairline bg-gx-surface shadow-gx-card",
    );
  });
});

describe("同类列表（回收站）无此问题", () => {
  // 两处回收站列表同样有 overflow-hidden 卡片 + overflow-y-auto 滚动容器，
  // 但行内只有「找回 / 彻底删除」这类 Button，没有会被裁的浮层菜单。
  for (const [name, file] of [
    ["知识库回收站", "../kb/KbTrashPage.tsx"],
    ["Base 回收站", "../settings/TrashPage.tsx"],
  ] as const) {
    it(`${name} 行内无 Popover 浮层（不需要改）`, () => {
      expect(read(file)).not.toContain("<Popover");
    });
  }
});
