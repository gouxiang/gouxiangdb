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

import { FlyoutPanel, PrimaryNav, containerIcon, navKindIcon } from "./PrimaryNav";
import {
  buildFlyoutRows,
  flattenMenuSections,
  navRowHeights,
  NAV_GROUP_ROW_H,
  NAV_ITEM_ROW_H,
  NAV_ROW_GAP,
} from "./lib/menu-sections";
import { virtualWindowByHeights } from "./lib/menu-window";
import { FOOTER_NAV_ITEMS } from "./lib/nav-footer";
import { indexNavNodes } from "./lib/nav-links";

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

const alive = (nodeId: string, kind: NavNodeDTO["kind"], resourceId: string, name: string) => ({
  id: nodeId,
  kind,
  name,
  iconName: null,
  resourceType: kind,
  resourceId,
  state: "alive" as const,
});

function treeNode(id: string, kind: NavNodeDTO["kind"], resourceId: string, parentId: string | null): NavNodeDTO {
  return {
    workspaceId: "ws", id, parentId, resourceType: kind === "group" ? null : kind, resourceId,
    name: id, ord: 0, path: `/${id}/`, depth: parentId ? 2 : 1, isSystem: false, iconName: null,
    createdAt: TS, updatedAt: null, deletedAt: null, kind,
  } as NavNodeDTO;
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
function threeLevelMenu(): MenuItemDTO[] {
  return [
    item({ id: "c_ws", type: "container", nodeId: "nav_base", label: "工作区", ord: 0 }),
    item({ id: "s_dash", type: "shortcut", nodeId: "nav_t1", parentId: "c_ws", ord: 1, node: alive("nav_t1", "table", "t1", "客户表") }),
    item({ id: "c_prod", type: "container", nodeId: null, parentId: "c_ws", label: "产品中心", ord: 2 }),
    item({ id: "s_req", type: "shortcut", nodeId: "nav_t2", parentId: "c_prod", ord: 3, node: alive("nav_t2", "table", "t2", "需求池") }),
  ];
}

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

  it("SSR：分组标题是独立小字行，子项直接可见（不靠展开才能看到）", () => {
    menuItems = [
      item({ id: "c_ws", type: "container", nodeId: "nav_base", label: "工作区", ord: 0 }),
      item({ id: "s_a", type: "shortcut", nodeId: "nav_t1", parentId: "c_ws", ord: 1, node: alive("nav_t1", "table", "t1", "客户表") }),
      item({ id: "s_b", type: "shortcut", nodeId: "nav_t2", parentId: "c_ws", ord: 2, node: alive("nav_t2", "table", "t2", "需求池") }),
    ];
    treeItems = [treeNode("nav_base", "base", "b1", null), treeNode("nav_t1", "table", "t1", "nav_base"), treeNode("nav_t2", "table", "t2", "nav_base")];
    const html = renderNav();
    // 分组标题：11px + hint 色 + 独立行
    expect(html).toContain('data-nav-row="group"');
    expect(html).toContain("text-gx-text-hint");
    // 两个子项都直接渲染出来（不必先展开）
    expect(html).toContain("客户表");
    expect(html).toContain("需求池");
  });
});

describe("R-N-21 深层侧方浮出", () => {
  it("关闭态：不渲染浮出面板，只留触发行", () => {
    menuItems = threeLevelMenu();
    treeItems = [treeNode("nav_base", "base", "b1", null), treeNode("nav_t1", "table", "t1", "nav_base"), treeNode("nav_t2", "table", "t2", "nav_base")];
    const html = renderNav();
    expect(html).toContain('data-flyout="closed"');
    expect(html).not.toContain('data-flyout="open"');
    expect(html).not.toContain("data-flyout-panel");
    // 触发行仍带 popup 语义与折叠态无关的可点性
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("打开态：面板是 role=menu 的独立浮层，标题与子项用字重/字号/缩进区分", () => {
    const rows = buildFlyoutRows([
      {
        item: item({ id: "c_sub", type: "container", label: "产品中心" }),
        children: [{ item: item({ id: "s_req", type: "shortcut", node: alive("nav_t2", "table", "t2", "需求池"), nodeId: "nav_t2" }), children: [] }],
      },
    ]);
    expect(rows.map((r) => [r.kind, r.depth])).toEqual([
      ["title", 0],
      ["item", 1],
    ]);
    const html = renderToString(
      <FlyoutPanel
        label="产品中心"
        rows={rows}
        side="right"
        pos={{ top: 40, left: 232 }}
        nodeIndex={indexNavNodes([treeNode("nav_t2", "table", "t2", "nav_base")])}
      />,
    );
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="产品中心 子菜单"');
    expect(html).toContain('role="menuitem"');
    // 面板头 + 一级标题（13/600）+ 二级子项（12/400，缩进档 pl-6）
    expect(html).toContain("text-gx-11");
    expect(html).toContain("font-semibold");
    expect(html).toContain("pl-6");
    expect(html).toContain("需求池");
    // 定位与层级：fixed 逃出 L1 滚动容器裁剪 + token 层级 + 阴影 + 圆角 8
    expect(html).toContain('class="fixed gx-z-popover');
    expect(html).toContain("gx-z-popover");
    expect(html).toContain("shadow-gx-lg");
    expect(html).toContain("rounded-gx-lg");
    // 入场动画类名按方向给出（150ms ease-out，见 index.css）
    expect(html).toContain("gx-flyout-in-right");
  });

  it("浮出面板的入场动画落在 index.css：150ms ease-out + reduced-motion 兜底", () => {
    const css = read("../../index.css");
    expect(css).toContain("gx-flyout-in-right");
    expect(css).toContain("gx-flyout-in-left");
    expect(css).toContain("gx-flyout-in-right 150ms ease-out");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("翻转与键盘：源码里有贴右翻左判定、Esc 关闭、focus/blur 打开关闭", () => {
    const src = code("./PrimaryNav.tsx");
    expect(src).toContain("window.innerWidth");
    expect(src).toContain('setSide(toRight ? "right" : "left")');
    expect(src).toContain('e.key !== "Escape"');
    expect(src).toContain("onFocus={openNow}");
    expect(src).toContain("onBlur");
    expect(src).toContain("FLYOUT_CLOSE_DELAY_MS");
  });

  it("移出后延时 150ms 关闭（防误关），且浮层用 fixed 逃出 L1 滚动容器的裁剪", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).toContain("FLYOUT_CLOSE_DELAY_MS = 150");
    expect(src).toContain('className={`fixed gx-z-popover');
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

  it("菜单行规格同一真源：图标 14 / 文字 13 / 圆角 8 / padding 8 / gap 8 / 150ms ease-out", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).toContain('flex h-8 w-full items-center gap-2 rounded-gx-lg px-2 text-gx-13');
    expect(src).toContain("size={14}");
    expect(src).toContain('NAV_ROW_TRANSITION = "transition-colors duration-150 ease-out"');
    // 底部固定区复用同一真源，不另起一套
    const shell = code("./WorkspaceShell.tsx");
    expect(shell).toContain("NAV_ROW_TRANSITION");
    expect(shell).toContain("L1_ROW_SELECTED");
    expect(shell).toContain("L1_ROW_IDLE");
  });

  it("分组标题与菜单项左内边距同一档（都 px-2，不缩进）", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).toContain('"flex w-full items-center rounded-gx-lg px-2 text-gx-11 font-medium"');
  });
});

describe("图标语义映射（L1 全站）", () => {
  it("底部固定区四项：路径 / 图标 / 文案与 D-5 §2.2 一致（工作区设置 = settings）", () => {
    expect(FOOTER_NAV_ITEMS).toEqual([
      { path: "/workspace/contacts", icon: "building", label: "通讯录" },
      { path: "/workspace/authz", icon: "shield", label: "权限管理" },
      { path: "/workspace/settings/nav", icon: "sitemap", label: "导航编排" },
      { path: "/workspace/settings/assets", icon: "settings", label: "工作区设置" },
    ]);
  });

  it("个人区四项图标语义：门户=user / 首页=home / 待办=checkSquare / 收藏=star", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).toContain('label: "个人门户", icon: "user"');
    expect(src).toContain('label: "工作台首页", icon: "home"');
    expect(src).toContain('label: "我的待办", icon: "checkSquare"');
    expect(src).toContain('label: "我的收藏", icon: "star"');
  });

  it("容器图标不再一律 folder：挂 base/kb 的容器按实体类型取图标", () => {
    const index = indexNavNodes([treeNode("nav_base", "base", "b1", null), treeNode("nav_kb", "kb", "k1", null)]);
    expect(containerIcon(item({ id: "c1", type: "container", nodeId: "nav_base" }), index)).toBe("database");
    expect(containerIcon(item({ id: "c2", type: "container", nodeId: "nav_kb" }), index)).toBe("book");
    // 无指向的容器才回退 folder；显式 iconName 优先
    expect(containerIcon(item({ id: "c3", type: "container" }), index)).toBe("folder");
    expect(containerIcon(item({ id: "c4", type: "container", nodeId: "nav_base", iconName: "star" }), index)).toBe("star");
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

  it("菜单用到的图标全部能渲染（含新增的 home / checkSquare）", () => {
    const used: IconName[] = [
      "user", "home", "checkSquare", "star",
      "building", "shield", "sitemap", "settings",
      "folder", "folderOpen", "database", "book", "table", "doc", "canvas", "grid", "group",
      "chevronRight", "chevronDown", "moreVertical",
    ];
    for (const name of used) {
      const html = renderToString(<Icon name={name} size={14} />);
      expect(html.startsWith("<svg")).toBe(true);
      expect(html).toContain('stroke-width="1.75"');
    }
  });
});

describe("阶段 1 交付不回退", () => {
  it("白底卡片选中态与「规划中」徽标仍在，左侧色条仍未回来", () => {
    menuItems = [
      item({ id: "s_a", type: "shortcut", nodeId: "nav_t1", node: alive("nav_t1", "table", "t1", "客户表") }),
    ];
    treeItems = [treeNode("nav_t1", "table", "t1", "nav_base"), treeNode("nav_base", "base", "b1", null)];
    const html = renderNav("/base/b1/table/t1");
    expect(html).toContain("bg-white");
    expect(html).toContain("font-semibold");
    expect(html).toContain("text-gx-accent");
    expect(html).toContain("rounded-gx-lg");
    expect(html).toContain("规划中");
    const src = read("./PrimaryNav.tsx");
    expect(src).not.toContain("w-[3px]");
    expect(src).not.toContain("bg-gx-accent-bg");
  });

  it("折叠档（56px）只留图标：不渲染文字节点，保留 title 与可点按钮", () => {
    menuItems = [
      item({ id: "s_a", type: "shortcut", nodeId: "nav_t1", node: alive("nav_t1", "table", "t1", "客户表") }),
    ];
    treeItems = [treeNode("nav_t1", "table", "t1", "nav_base"), treeNode("nav_base", "base", "b1", null)];
    const html = renderNav("/base/b1/table/t1", { collapsed: true });
    expect(html).not.toMatch(/>客户表</);
    expect(html).toContain('title="客户表"');
    expect(html).toContain("justify-center");
    // 折叠档下分组标题行不渲染（只留图标行），但菜单项一个不少
    expect(html).not.toContain('data-nav-row="group"');
    expect(html).toContain('data-nav-row="planned"');
  });

  it("颜色仍全部走 gx-* 令牌：PrimaryNav / WorkspaceShell 不写死 hex", () => {
    for (const f of ["./PrimaryNav.tsx", "./WorkspaceShell.tsx"]) {
      const src = code(f);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\[#/);
    }
  });
});
