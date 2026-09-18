// 阶段 1 壳层重构回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 锁的是「阶段 1 骨架不回退」：
//   R-N-07/08  L1 两档 224/56 + localStorage 键
//   R-N-09/10  L1/L2 选中态 = 白底卡片（bg-white + text-gx-accent + font-semibold + rounded-gx-lg）
//              **且不再出现左侧 3px 色条**（规范明令的反例）
//   R-N-11/12  行尾竖向三点：20×20 占位常驻 + 四条护栏（默认隐藏 / hover / 触屏 / 键盘 / 打开强制）
//   R-N-17     「规划中」徽标 + 点击有明确反馈（非静默）
//   R-I-16     导入 / 导出 / 分享数据落在 L2 表级操作行
//   R-N-19     主壳内无面包屑
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import type { MenuItemDTO, MenuTreeDTO, NavNodeDTO, NavTreeDTO } from "@gx/shared-types";

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
    tree: { workspaceId: "ws", navVersion: 1, items: treeItems, truncated: false } as NavTreeDTO,
    isLoading: false,
  }),
  usePatchMenu: () => ({ mutate: vi.fn() }),
  useMoveNode: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../api/hooks", () => ({
  useGXMutations: () => ({ csvImport: { mutateAsync: vi.fn(async () => ({ createdRecords: 0 })) } }),
}));

import { PrimaryNav } from "./PrimaryNav";
import { SecondaryNav } from "./SecondaryNav";
import { TableActionRow } from "./TableActionRow";
import { RowMoreMenu, SecondaryRow } from "./SecondaryNavSections";
import type { CollectableEntry } from "./lib/collection";
import {
  L1_WIDTH_COLLAPSED,
  L1_WIDTH_EXPANDED,
  L2_WIDTH,
  L1_COLLAPSED_KEY,
  TOPBAR_H,
  readL1Collapsed,
  writeL1Collapsed,
} from "./lib/l1-collapse";
import { nearestContainerItem, resolveContainerItem, resolveRouteContainer } from "./lib/route-container";
import { indexNavNodes } from "./lib/nav-links";

const TS = "2026-09-16T00:00:00.000Z";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(here(p), "utf8");

// 源码断言行：剥离注释后再判。
// 背景：阶段 1 在源码里留了「为什么不用 useParams / 为什么禁用 window.open」的反例注释
// （见 PrimaryNav.tsx:105-107、TableActionRow.tsx:72），整行与块注释会被 not.toContain
// 误判为违规。注释是规范说明要保留，判的是代码本身，故断言一律走 code() 而非 read()。
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
/** 读源码并去掉注释（只保留代码本体）用于「不该出现 X」类断言。 */
const code = (p: string) => stripComments(read(p));

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

function treeNode(id: string, kind: NavNodeDTO["kind"], resourceId: string, parentId: string | null): NavNodeDTO {
  return {
    workspaceId: "ws", id, parentId, resourceType: kind === "group" ? null : kind, resourceId,
    name: id, ord: 0, path: `/${id}/`, depth: parentId ? 2 : 1, isSystem: false, iconName: null,
    createdAt: TS, updatedAt: null, deletedAt: null, kind,
  } as NavNodeDTO;
}

/** 带路由参数渲染（useParams 在布局壳里取不到参数，必须真实匹配一条 Route）。 */
function renderNavAt(location: string, props: Record<string, unknown> = {}) {
  return renderToString(
    <StaticRouter location={location}>
      <Routes>
        <Route path="/base/:baseId/table/:tableId/*" element={<PrimaryNav {...props} />} />
        <Route path="*" element={<PrimaryNav {...props} />} />
      </Routes>
    </StaticRouter>,
  );
}

const aliveTableShortcut = (): MenuItemDTO =>
  item({
    id: "m_t",
    type: "shortcut",
    nodeId: "nav_t",
    label: "客户表",
    node: {
      id: "nav_t",
      kind: "table",
      name: "客户表",
      iconName: null,
      resourceType: "table",
      resourceId: "tbl_1",
      state: "alive",
    },
  });

beforeEach(() => {
  menuItems = [];
  treeItems = [];
});

describe("阶段 1 骨架常量（UI-SPEC A.3）", () => {
  it("L1 展开 224 / 折叠 56；L2 常驻 240；顶栏 56；折叠键走 gx 前缀约定", () => {
    expect(L1_WIDTH_EXPANDED).toBe(224);
    expect(L1_WIDTH_COLLAPSED).toBe(56);
    expect(L2_WIDTH).toBe(240);
    expect(TOPBAR_H).toBe(56);
    expect(L1_COLLAPSED_KEY.startsWith("gx")).toBe(true);
  });

  it("SSR 场景（无 window）读折叠态一律为展开，写入不抛", () => {
    expect(readL1Collapsed()).toBe(false);
    expect(() => writeL1Collapsed(true)).not.toThrow();
  });
});

describe("L2 容器反推（R-N-02 刷新还原）", () => {
  it("container 直接引用库节点 → 命中该 container", () => {
    const items = [
      item({ id: "g", type: "container", nodeId: "nav_g" }),
      item({ id: "c_base", type: "container", nodeId: "nav_base", label: "默认分组" }),
    ];
    expect(resolveContainerItem(items, "nav_base")?.id).toBe("c_base");
  });

  it("只有 shortcut 引用（表/文档）→ 上溯到最近的 container", () => {
    const items = [
      item({ id: "c_base", type: "container", nodeId: "nav_base" }),
      item({ id: "s_t", type: "shortcut", nodeId: "nav_t", parentId: "c_base" }),
    ];
    expect(resolveContainerItem(items, "nav_t")?.id).toBe("c_base");
  });

  it("父链成环不死循环；无归属返回 null（调用方据此把 L2 宽度归零）", () => {
    const items = [
      item({ id: "a", type: "shortcut", parentId: "b" }),
      item({ id: "b", type: "shortcut", parentId: "a" }),
    ];
    expect(nearestContainerItem(items, "a")).toBeNull();
    expect(resolveContainerItem(items, "nope")).toBeNull();
    expect(resolveContainerItem(items, null)).toBeNull();
  });

  it("由 base/kb 路由反推容器；索引里没有该资源时返回 null", () => {
    const items = [item({ id: "c_base", type: "container", nodeId: "nav_base", label: "默认分组" })];
    const index = indexNavNodes([treeNode("nav_base", "base", "base_1", null)]);
    expect(resolveRouteContainer(items, index, { kind: "base", id: "base_1" })?.id).toBe("c_base");
    expect(resolveRouteContainer(items, index, { kind: "base", id: "base_x" })).toBeNull();
    expect(resolveRouteContainer(items, index, null)).toBeNull();
  });
});

describe("R-N-09 选中态：白底卡片，无左侧色条", () => {
  it("命中当前表的 shortcut 渲染为白底 + accent 字 + 600 + 圆角 8", () => {
    menuItems = [aliveTableShortcut()];
    treeItems = [treeNode("nav_t", "table", "tbl_1", "nav_b"), treeNode("nav_b", "base", "base_1", null)];
    const html = renderNavAt("/base/base_1/table/tbl_1");
    expect(html).toContain("客户表");
    expect(html).toContain("bg-white");
    expect(html).toContain("font-semibold");
    expect(html).toContain("text-gx-accent");
    expect(html).toContain("rounded-gx-lg");
  });

  it("一级导航源码里不再出现 3px 左侧色条（规范明令反例）", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).not.toContain("w-[3px]");
    expect(src).not.toContain("bg-gx-accent-bg");
  });

  it("未命中时是 hover 态而非选中态", () => {
    menuItems = [aliveTableShortcut()];
    treeItems = [treeNode("nav_t", "table", "tbl_1", "nav_b"), treeNode("nav_b", "base", "base_1", null)];
    const html = renderNavAt("/base/base_1/table/tbl_9");
    expect(html).toContain("客户表");
    expect(html).toContain("hover:bg-gx-row-hover");
  });

  it("当前资源走 useMatch 而非 useParams（布局壳里 useParams 恒为 {}，选中态会永远不亮）", () => {
    const src = code("./PrimaryNav.tsx");
    expect(src).toContain("useMatch(");
    expect(src).not.toContain("useParams");
  });
});

describe("R-N-07 L1 折叠档（56px 只留图标）", () => {
  it("折叠态不渲染文字标签，但保留 title tooltip 与可点按钮", () => {
    menuItems = [aliveTableShortcut()];
    treeItems = [treeNode("nav_t", "table", "tbl_1", "nav_b"), treeNode("nav_b", "base", "base_1", null)];
    const html = renderNavAt("/base/base_1/table/tbl_1", { collapsed: true });
    // 折叠档只留图标：标签文本节点不渲染（title 里的同名 tooltip 不算渲染文字）
    expect(html).not.toMatch(/>客户表</);
    expect(html).not.toContain('class="flex-1 truncate"');
    expect(html).toContain('title="客户表"');
    expect(html).toContain("justify-center");
  });

  it("展开态正常渲染文字标签", () => {
    menuItems = [aliveTableShortcut()];
    treeItems = [treeNode("nav_t", "table", "tbl_1", "nav_b"), treeNode("nav_b", "base", "base_1", null)];
    expect(renderNavAt("/base/base_1/table/tbl_1", { collapsed: false })).toContain("客户表");
  });
});

describe("R-N-17 规划入口：保留位置 + 「规划中」徽标 + 点击不静默", () => {
  it("L1 上区「个人门户」渲染徽标与 title，点击走 toast 反馈", () => {
    const html = renderNavAt("/base/base_1/table/tbl_1");
    expect(html).toContain("个人门户");
    expect(html).toContain("规划中");
    expect(html).toContain("个人门户 · 规划中，尚未开放");
    const src = read("./PrimaryNav.tsx");
    expect(src).toContain("plannedHint(\"个人门户\")");
  });

  it("徽标只用 gx-* 类，不写死 hex、不用任意值色（圆角 4 / 字色 hint）", () => {
    const src = read("../../components/PlannedBadge.tsx");
    expect(src).toContain("bg-gx-row-hover");
    expect(src).toContain("text-gx-text-hint");
    expect(src).toContain("rounded-gx-sm");
    // 业务代码禁写死 hex：注释里可以出现色值说明，但不得有 bg-[...] 任意值或内联 style
    expect(src).not.toContain("bg-[");
    expect(src).not.toContain("style={{");
  });
});

describe("R-N-11/12 行尾竖向三点：四条护栏", () => {
  it("行尾三点容器恒为 20×20 占位，且挂 gx-row-more 护栏类", () => {
    const entry: CollectableEntry = {
      node: treeNode("nav_t", "table", "tbl_1", "nav_b"),
      kind: "table",
      shortcuts: [],
      kbResourceId: null,
      baseResourceId: "base_1",
      isRootDoc: false,
    };
    const html = renderOneRow(entry);
    expect(html).toContain("gx-row-more");
    expect(html).toContain("h-5 w-5");
    // P3-a11y 收尾：行尾三点必须有具体作用名（table 行 → 「表操作菜单」），不再是泛泛的「行操作」
    expect(html).toContain('aria-label="表操作菜单"');
    expect(html).toContain('data-open="false"');
    // 图标名不出现在 DOM 里（Icon 只吐 path），故对源码断言用的是竖向三点而非横向 more
    expect(read("./SecondaryNavSections.tsx")).toContain('name="moreVertical"');
  });

  it("行尾三点的可访问名称按行类型区分，且未指定时回落「行操作」", () => {
    const entry: CollectableEntry = {
      node: treeNode("nav_t", "table", "tbl_1", "nav_b"),
      kind: "table",
      shortcuts: [],
      kbResourceId: null,
      baseResourceId: "base_1",
      isRootDoc: false,
    };
    expect(renderOneRow(entry, null, "doc")).toContain('aria-label="文档操作菜单"');
    expect(renderOneRow(entry, null, "canvas")).toContain('aria-label="画布操作菜单"');
    // 默认回落：不传 label 时仍念「行操作」，老调用点不被打断
    const fallback = renderToString(<RowMoreMenu items={[{ label: "移动到分组…", icon: "folderOpen", onClick: vi.fn() }]} />);
    expect(fallback).toContain('aria-label="行操作"');
  });

  it("护栏四条全部落在 index.css 里（触屏常驻 / hover / focus / 打开强制 / reduced-motion）", () => {
    const css = read("../../index.css");
    expect(css).toContain(".gx-row-more");
    expect(css).toContain("@media (hover: none)");
    expect(css).toContain('.gx-row-more[data-open="true"]');
    expect(css).toContain(".gx-row-more:focus-within");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("二级行选中态为白底卡片，且不再有 3px 色条", () => {
    const src = read("./SecondaryNavSections.tsx");
    expect(src).not.toContain("w-[3px]");
    expect(src).toContain('"bg-white font-semibold text-gx-accent"');
  });
});

describe("R-I-16 导入 / 导出 / 分享数据落在 L2 表级操作行", () => {
  it("有表上下文时渲染三格（分享数据挂「规划中」，点击 toast 非静默）", () => {
    const html = renderToString(
      <StaticRouter location="/base/b1/table/t1">
        <TableActionRow tableId="t1" viewId="v1" />
      </StaticRouter>,
    );
    expect(html).toContain("导入");
    expect(html).toContain("导出");
    expect(html).toContain("分享数据");
    expect(html).toContain("规划中");
    expect(html).toContain("text-gx-accent");
  });

  it("无表上下文（库首页 / 知识库 / 工作区）→ 整行不渲染、不占位", () => {
    const html = renderToString(
      <StaticRouter location="/kb/k1">
        <TableActionRow tableId={null} />
      </StaticRouter>,
    );
    expect(html).toBe("");
  });

  it("L2 装配了表级操作行；导入导出走 client.ts 不裸 fetch、不带凭据的 window.open 已禁用", () => {
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain("<TableActionRow");
    const row = code("./TableActionRow.tsx");
    expect(row).toContain('from "../../api/client"');
    expect(row).not.toContain("fetch(");
    // 服务端只认 Authorization / X-GX-Token 请求头，window.open(exportUrl) 无头 → 401
    expect(row).not.toContain("window.open");
    expect(row).toContain("Tables.exportCsvText");
    expect(read("../../api/client.ts")).toContain("exportCsvText");
  });
});

describe("骨架 S-1：L2 常驻 240 / nav2 底；主壳无面包屑", () => {
  it("L2 面板宽 240、底为 gx-nav2、发丝线分隔", () => {
    treeItems = [treeNode("nav_base", "base", "b1", null)];
    menuItems = [item({ id: "c_base", type: "container", nodeId: "nav_base", label: "默认分组" })];
    const html = renderToString(
      <StaticRouter location="/">
        <SecondaryNav containerMenuId="c_base" containerName="默认分组" onClose={vi.fn()} />
      </StaticRouter>,
    );
    expect(html).toContain("width:240px");
    expect(html).toContain("bg-gx-nav2");
    expect(html).toContain("border-gx-hairline");
  });

  it("主壳不引入面包屑组件；旧顶栏的面包屑链已整段下线", () => {
    for (const f of ["./WorkspaceShell.tsx", "./PrimaryNav.tsx", "./SecondaryNav.tsx"]) {
      const src = read(f);
      expect(src).not.toContain("Breadcrumb");
      expect(src).not.toContain("NodeBreadcrumb");
    }
    // 旧壳 TopBar：原「库名 › 表名」链移除后，这条只服务于面包屑的旧形不再存在
    const topbar = read("../shell/TopBar.tsx");
    expect(topbar).not.toContain("navigate(`/base/${baseId}/table/${tableId}`)");
  });

  it("L1 底为 gx-nav1、宽度为 224/56 两档，L2 随容器有无收起（无容器不占位）", () => {
    const src = read("./WorkspaceShell.tsx");
    expect(src).toContain("bg-gx-nav1");
    expect(src).toContain("L1_WIDTH_COLLAPSED : L1_WIDTH_EXPANDED");
    expect(src).toContain("showL2");
  });
});

/** 只渲染单行二级行（绕过 SecondaryNav 的数据层），用于断言行尾三点与选中态。 */
function renderOneRow(
  entry: CollectableEntry,
  currentResource: string | null = null,
  kind: "table" | "doc" | "canvas" = "table",
): string {
  return renderToString(
    <StaticRouter location="/">
      <SecondaryRow
        kind={kind}
        entry={entry}
        depth={0}
        hasDocKids={false}
        expanded={false}
        currentResource={currentResource}
        index={{ byId: new Map(), byResource: new Map() }}
        tab="all"
        onToggleDoc={vi.fn()}
        onNavigate={vi.fn()}
        onCollect={vi.fn()}
        onMove={vi.fn()}
      />
    </StaticRouter>,
  );
}
