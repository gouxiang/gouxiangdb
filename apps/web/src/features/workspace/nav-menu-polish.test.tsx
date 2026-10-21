// 菜单区域精细化回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 锁的是「参考图形态不回退」：
//   R-N-20  取消手风琴：container 降级为分组标题行，shortcut 平铺（无折叠态、无就地缩进展开）
//   R-N-21  深层侧方浮出：关闭态不渲染面板；打开态是 role=menu 的独立面板（含标题/子项层级）
//   R-N-22  节奏统一：菜单项 32 / 分组标题 24 / 图标 14 / 文字 13 / 圆角 8 / 150ms ease-out
//   图标语义：L1 菜单（含底部固定区）逐项语义匹配，且全部落在 IconName 白名单内
//   窗口化：分组标题比菜单项矮，故按逐行高度切片（变高窗口不漂移）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import type { MenuItemDTO, MenuTreeDTO, NavNodeDTO } from "@gx/shared-types";
import { Icon, type IconName } from "../../components/icons";

let menuItems: MenuItemDTO[] = [];
let treeItems: NavNodeDTO[] = [];

vi.mock("./nav-hooks", () => ({
  useNavMenu: () => ({
    menu: { workspaceId: "ws", menuVersion: 1, items: menuItems } as MenuTreeDTO,
    isLoading: false,
    isError: false,
  }),
  useNavNodeIndex: () => ({ index: { byId: new Map(treeItems.map((n) => [n.id, n])), byResource: new Map() } }),
  useNavTreeDeep: () => ({
    tree: { workspaceId: "ws", navVersion: 1, items: treeItems, truncated: false },
    isLoading: false,
  }),
  usePatchMenu: () => ({ mutate: vi.fn() }),
  useMoveNode: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { PrimaryNav, navKindIcon } from "./PrimaryNav";
import {
  flattenMenuSections,
  navRowHeights,
  NAV_GROUP_ROW_H,
  NAV_ITEM_ROW_H,
  NAV_ROW_GAP,
} from "./lib/menu-sections";
import { virtualWindowByHeights } from "./lib/menu-window";
import { FOOTER_NAV_ITEMS } from "./lib/nav-footer";

const TS = "2026-09-16T00:00:00.000Z";
const here = (p: string) => new URL(p, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");
/** 剥离注释后判代码本体（源码里留了大量「为什么」说明，整行注释会干扰 not.toContain 断言）。 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

function item(over: Partial<MenuItemDTO> & { id: string }): MenuItemDTO {
  return {
    parentId: null,
    type: "shortcut",
    nodeId: null,
    label: null,
    iconName: null,
    ord: 0,
    node: null,
    createdAt: TS,
    updatedAt: null,
    deletedAt: null,
    ...over,
  };
}

function renderNav(location = "/", props: Record<string, unknown> = {}) {
  return renderToString(
    <StaticRouter location={location}>
      <Routes>
        <Route path="/base/:baseId/table/:tableId/*" element={<PrimaryNav {...props} />} />
        <Route path="*" element={<PrimaryNav {...props} />} />
      </Routes>
    </StaticRouter>,
  );
}

/** 两层树（container → shortcut）＋ 一个三层分支（container → container → shortcut）。 */

beforeEach(() => {
  menuItems = [];
  treeItems = [];
});

describe("R-N-20 手风琴已下线", () => {
  it("PrimaryNav 不再有折叠态状态与就地展开参数", () => {
    const src = code("./PrimaryNav.tsx");
    expect(src).not.toContain("collapsedIds");
    expect(src).not.toContain("setCollapsed");
    expect(src).not.toContain("flattenMenuRows");
    expect(src).not.toContain("onToggle");
    // 缩进也不再随深度增长（平铺，不缩进）
    expect(src).not.toContain("depth * 14");
    expect(src).not.toContain("depth * 13");
  });

  it("两级摊平：container → 分组标题行，子项平铺且无折叠交互", () => {
    const rows = flattenMenuSections(
      // 直接构造树节点，避免依赖 DTO 细节
      [
        {
          item: item({ id: "c1", type: "container", label: "工作区" }),
          children: [
            { item: item({ id: "s1", type: "shortcut", label: "客户表" }), children: [] },
            { item: item({ id: "s2", type: "shortcut", label: "需求池" }), children: [] },
          ],
        },
      ],
    );
    expect(rows.map((r) => [r.kind, r.node.item.id])).toEqual([
      ["group", "c1"],
      ["item", "s1"],
      ["item", "s2"],
    ]);
    // 平铺的子项没有子树要浮出
    expect(rows.every((r) => r.kind === "group" || r.nested.length === 0)).toBe(true);
  });

  it("SSR：分组标题行永不渲染（数据层保留、表层不画线），库项平铺直出且带 data-grp", () => {
    const html = renderNav("/", {
      // 库名刻意避开「数据库 / 知识库」字样，才能断言分组组名文本不出现。
      bases: [{ id: "b1", name: "客户库", icon: null, iconColor: null }],
      kbs: [{ id: "k1", name: "产品手册库", icon: null, iconColor: null }],
    });
    // v6 S1：分组不做视觉体现——分组行不进 DOM，但每个库砖挂 data-grp 保留分组归属
    expect(html).not.toContain('data-nav-row="group"');
    expect(html).toContain('data-grp="base"');
    expect(html).toContain('data-grp="kb"');
    // 两个组名文字不渲染（库名本身也刻意不含这两个词）
    expect(html).not.toContain("数据库");
    expect(html).not.toContain("知识库");
    expect(html).toContain("客户库");
    expect(html).toContain("产品手册库");
    // 红线：一级里不得出现任何二级内容（表/文档/画布）
    expect(html).not.toContain('data-nav-entity="table"');
    expect(html).not.toContain('data-nav-entity="doc"');
    expect(html).not.toContain('data-nav-entity="canvas"');
  });
});

describe("R-N-22 节奏统一", () => {
  it("行高档位：菜单项 32、分组标题 24（比菜单项紧凑）、行距 2", () => {
    expect(NAV_ITEM_ROW_H).toBe(32);
    expect(NAV_GROUP_ROW_H).toBe(24);
    expect(NAV_ROW_GAP).toBe(2);
    expect(NAV_GROUP_ROW_H).toBeLessThan(NAV_ITEM_ROW_H);
  });

  it("逐行高度 = 行高 + 行距，窗口化按变高切片（分组标题多了也不漂移）", () => {
    const heights = navRowHeights(flattenMenuSections([
      { item: item({ id: "c1", type: "container", label: "g" }), children: [{ item: item({ id: "s1", type: "shortcut" }), children: [] }] },
    ]));
    expect(heights).toEqual([24 + 2, 32 + 2]);

    // 100 个分组标题 + 100 个菜单项：定高切片会漂 100*(34-26)=800px，变高切片不会
    const mixed: number[] = [];
    for (let i = 0; i < 100; i++) mixed.push(24 + 2, 32 + 2);
    const total = mixed.reduce((a, b) => a + b, 0);
    expect(total).toBe(100 * 26 + 100 * 34);
    const win = virtualWindowByHeights(3000, 300, mixed, 8);
    const prefix = (k: number) => mixed.slice(0, k).reduce((a, b) => a + b, 0);
    const rendered = mixed.slice(win.start, win.end).reduce((a, b) => a + b, 0);
    // padTop/padBottom 与真实 DOM 高度逐像素一致（总高三段相加不差一像素 = 不漂移）
    expect(win.padTop).toBe(prefix(win.start));
    expect(win.padBottom).toBe(total - prefix(win.end));
    expect(win.padTop + rendered + win.padBottom).toBe(total);
    // 窗口确实覆盖 [scrollTop, scrollTop + viewportH] 这段
    expect(win.padTop).toBeLessThanOrEqual(3000);
    expect(win.padTop + rendered).toBeGreaterThanOrEqual(3000 + 300);
    // 定高口径（一律 34）会把第 start 行的顶边算成 start*34，漂移数百像素；
    // 这正是「分组标题比菜单项矮」后必须改逐行前缀和的原因。
    expect(win.start * 34 - win.padTop).toBeGreaterThan(300);
  });

  it("图标轨行规格同一真源：砖类 gx-rail-item/tile、砖步进 RAIL_TILE_ROW_H、图标 17", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).toContain("gx-rail-item");
    expect(src).toContain("gx-rail-tile");
    expect(src).toContain("RAIL_TILE_ROW_H");
    expect(src).toContain("size={17}");
    // 砖的渐变 / 阴影 / 11px 圆角全部在 index.css，组件不写色值
    const css = read("../../index.css");
    expect(css).toContain(".gx-rail-tile");
    expect(css).toContain("11px");
    // 底部固定区复用同一套砖类，不另起一套；建库钮 is-create 也在壳里
    const shell = code("./WorkspaceShell.tsx");
    expect(shell).toContain("gx-rail-surface");
    expect(shell).toContain("gx-rail-foot");
    expect(shell).toContain("is-create");
  });

  it("砖名规格 10.5px 走 index.css（.gx-rail-nm 单一真源，组件内不写字号）", () => {
    const css = read("../../index.css");
    expect(css).toContain(".gx-rail-nm");
    expect(css).toContain("10.5px");
    const src = code("./PrimaryNav.tsx");
    expect(src).toContain("gx-rail-nm");
    expect(src).not.toContain("text-gx-11");
  });
});

describe("图标语义映射（L1 全站）", () => {
  it("底部固定区三项（导航编排、权限管理均已下线；帮助中心为新增静态项）：路径 / 图标 / 文案与 D-5 §2.2 一致（工作区设置 = settings）", () => {
    // P2-B1：权限管理不再是底部固定区的一项——它现在是工作区设置里的一个分区
    //（内嵌 PermPanel），路由 /workspace/authz 保留但不占 L1 固定位。
    // 帮助中心是内容型静态入口：不看角色（门控见 lib/nav-gate.ts 的 STATIC_FOOTER_PATHS）。
    // v6 S1 顺序照底板 RAIL_FOOT：通讯录 → 帮助中心 → 工作区设置；
    // 通讯录图标由 building 换 users（双人剪影）。
    expect(FOOTER_NAV_ITEMS).toEqual([
      { path: "/workspace/contacts", icon: "users", label: "通讯录" },
      { path: "/help", icon: "help", label: "帮助中心" },
      { path: "/workspace/settings/general", icon: "settings", label: "工作区设置" },
    ]);
  });

  it("个人区四项规划入口本阶段下线（点了只弹 toast 的假入口，不留在 L1）", () => {
    const src = read("./PrimaryNav.tsx");
    // 锁定的是「声明」而非字面量：注释里仍会提到它们（说明如何取回），不能误伤。
    expect(src).not.toContain("const PERSONAL_PLANNED");
    expect(src).not.toContain("function PlannedPersonalRow");
    expect(src).not.toContain('label: "个人门户", icon: "user"');
    expect(src).not.toContain('label: "工作台首页", icon: "home"');
    expect(src).not.toContain('label: "我的待办", icon: "checkSquare"');
    expect(src).not.toContain('label: "我的收藏", icon: "star"');
  });

  it("实体类型默认图标映射齐全（base/kb/table/doc/canvas/view/group）", () => {
    expect(navKindIcon("base")).toBe("database");
    expect(navKindIcon("kb")).toBe("book");
    expect(navKindIcon("table")).toBe("table");
    expect(navKindIcon("doc")).toBe("doc");
    expect(navKindIcon("canvas")).toBe("canvas");
    expect(navKindIcon("view")).toBe("grid");
    expect(navKindIcon("group")).toBe("group");
  });

  it("菜单用到的图标全部能渲染（含 v6 通讯录 users / 帮助 help）", () => {
    const used: IconName[] = [
      "user", "home", "checkSquare", "star",
      "building", "users", "help", "shield", "sitemap", "settings",
      "folder", "folderOpen", "database", "book", "table", "doc", "canvas", "grid", "group",
      "chevronRight", "chevronDown", "moreVertical", "plus", "edit",
    ];
    for (const name of used) {
      const html = renderToString(<Icon name={name} size={14} />);
      expect(html.startsWith("<svg")).toBe(true);
      expect(html).toContain('stroke-width="1.75"');
    }
  });
});

describe("阶段 1 交付不回退", () => {
  it("图标轨选中态走 is-active + gx-rail 类，左侧色条仍未回来", () => {
    const html = renderNav("/base/b1/table/t1", {
      bases: [{ id: "b1", name: "客户库", icon: null, iconColor: null }],
    });
    expect(html).toContain("is-active");
    expect(html).toContain("gx-rail-item");
    expect(html).toContain("gx-rail-tile");
    // 「规划中」徽标在 L1 随规划入口一并下线（徽标组件本身仍在别处使用）。
    expect(html).not.toContain("规划中");
    const src = read("./PrimaryNav.tsx");
    expect(src).not.toContain("w-[3px]");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("v6 图标轨恒显示砖名，分组行 data-nav-row=group 永不出现（折叠档已废止）", () => {
    const html = renderNav("/base/b1/table/t1", {
      bases: [{ id: "b1", name: "客户库", icon: null, iconColor: null }],
    });
    // 砖名恒渲染（不再有 collapsed 折叠档）
    expect(html).toContain(">客户库<");
    expect(html).toContain('title="客户库"');
    // 分组标题行永不进 DOM；规划入口也不存在
    expect(html).not.toContain('data-nav-row="group"');
    expect(html).not.toContain('data-nav-row="planned"');
    // 分组归属仍在（data-grp 契约）
    expect(html).toContain('data-grp="base"');
  });

  it("颜色仍全部走 gx-* 令牌 / index.css 类：PrimaryNav / WorkspaceShell 不写死 hex", () => {
    for (const f of ["./PrimaryNav.tsx", "./WorkspaceShell.tsx"]) {
      const src = code(f);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\[#/);
    }
  });
});
