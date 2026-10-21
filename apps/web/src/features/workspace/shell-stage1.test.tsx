// 阶段 1 壳层重构回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 锁的是「阶段 1 骨架不回退」：
//   R-N-07/08  L1 两档 224/56 + localStorage 键
//   R-N-09/10  L1/L2 选中态 = 白底卡片（bg-white + text-gx-accent + font-semibold + rounded-gx-lg）
//              **且不再出现左侧 3px 色条**（规范明令的反例）
//   R-N-11/12  行尾竖向三点：20×20 占位常驻 + 四条护栏（默认隐藏 / hover / 触屏 / 键盘 / 打开强制）
//   R-N-17     「规划中」徽标 + 点击有明确反馈（非静默）
//   R-I-16     导入 / 导出落在 L2 表级操作行（「分享数据」规划占位已下线）
//   R-N-19     主壳内无面包屑
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";

vi.mock("../../api/hooks", () => ({
  useGXMutations: () => ({
    csvImport: { mutateAsync: vi.fn(async () => ({ createdRecords: 0 })) },
    // 第四批：L2 回挂了表操作（新建 / 重命名 / 复制 / 清空 / 删除），SSR 直接给桩。
    createTable: { mutateAsync: vi.fn() },
    updateTable: { mutateAsync: vi.fn() },
    duplicateTable: { mutateAsync: vi.fn() },
    clearTable: { mutateAsync: vi.fn() },
    deleteTable: { mutateAsync: vi.fn() },
    restoreTrash: { mutateAsync: vi.fn() },
  }),
  // 二级面板的数据源（第三批）：SSR 回归不跑 QueryClientProvider，直接给数据。
  useTables: () => ({ data: [], isLoading: false, isError: false }),
  // 第四批：取 canManageSchema 判定表操作入口是否渲染
  useBase: () => ({ data: { permissions: { canManageSchema: true } } }),
}));

vi.mock("../kb/kb-hooks", () => ({
  useKbDocs: () => ({ data: [], isLoading: false, isError: false }),
  // 第四批：L2 回挂了 KB 新建文档/画布与文档拖拽改层级
  useKb: () => ({ data: { role: "owner" } }),
  useCreateDoc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMoveDoc: () => ({ mutateAsync: vi.fn() }),
}));

import { PrimaryNav } from "./PrimaryNav";
import { SecondaryNav } from "./SecondaryNav";
import { TableActionRow } from "./TableActionRow";
import { RowMoreMenu, SecondaryRow } from "./SecondaryNavSections";
import type { SecondaryEntry } from "./SecondaryNavSections";
import {
  L1_WIDTH,
  L2_WIDTH,
  TOPBAR_H,
} from "./lib/l1-collapse";
import { deriveScopeContainer } from "./lib/route-container";

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


describe("阶段 1 骨架常量（UI-SPEC A.3；v6：L1 恒 76 图标轨、L2 恒 236）", () => {
  it("L1 恒 76、L2 恒 236（v6 S2 起不分档）、顶栏 56", () => {
    expect(L1_WIDTH).toBe(76);
    expect(L2_WIDTH).toBe(236);
    expect(TOPBAR_H).toBe(56);
  });

  it("l1-collapse 只导几何常量：源码不再有折叠态读写（L1 折叠档永久废止）", () => {
    const src = code("./lib/l1-collapse.ts");
    expect(src).not.toContain("readL1Collapsed");
    expect(src).not.toContain("writeL1Collapsed");
    expect(src).not.toContain("L1_COLLAPSED_KEY");
    expect(src).not.toContain("localStorage");
    expect(src).toContain("L1_WIDTH = 76");
  });
});

describe("L2 容器派生（R-N-02 刷新还原：改由 URL + 实体列表直接得出）", () => {
  const BASES = [{ id: "base_1", name: "客户主库" }];
  const KBS = [{ id: "kb_1", name: "产品知识库" }];

  it("停在 /base/:id（含子路由）→ 容器就是该库，且名字取自同一份列表", () => {
    expect(deriveScopeContainer(BASES, KBS, { kind: "base", id: "base_1" })).toEqual({
      kind: "base", id: "base_1", name: "客户主库",
    });
    // 子资源（表 / 视图）同样落在同一个容器上——这正是「刷新后二级仍停在原库」的根因保障
    expect(deriveScopeContainer(BASES, KBS, { kind: "base", id: "base_1" })?.id).toBe("base_1");
  });

  it("停在 /kb/:id → 容器就是该知识库", () => {
    expect(deriveScopeContainer(BASES, KBS, { kind: "kb", id: "kb_1" })).toEqual({
      kind: "kb", id: "kb_1", name: "产品知识库",
    });
  });

  it("三种 null 情形：不在库路由 / 列表未就绪 / id 不在列表里 → 容器为 null（L2 收起不占位）", () => {
    expect(deriveScopeContainer(BASES, KBS, null)).toBeNull();
    expect(deriveScopeContainer(null, KBS, { kind: "base", id: "base_1" })).toBeNull();
    expect(deriveScopeContainer([], [], { kind: "base", id: "base_x" })).toBeNull();
  });

  it("base / kb 各查各的列表，不串味", () => {
    expect(deriveScopeContainer(BASES, KBS, { kind: "kb", id: "base_1" })).toBeNull();
    expect(deriveScopeContainer(BASES, KBS, { kind: "base", id: "kb_1" })).toBeNull();
  });

  it("壳层源码：L2 容器走 deriveScopeContainer 单一真源，已不再读 menu_items", () => {
    const src = code("./WorkspaceShell.tsx");
    expect(src).toContain("deriveScopeContainer(");
    expect(src).not.toContain("resolveRouteContainer(");
    expect(src).not.toContain("useNavMenu");
  });
});

describe("R-N-09 选中态：图标轨 is-active 凹槽砖，无左侧色条", () => {
  it("停在库的任意子资源上 → 该一级砖行挂 is-active + gx-rail 类", () => {
    const html = renderNavAt("/base/base_1/table/tbl_1", {
      bases: [{ id: "base_1", name: "客户表", icon: null, iconColor: null }],
    });
    expect(html).toContain("客户表");
    expect(html).toContain("gx-rail-item");
    expect(html).toContain("gx-rail-tile");
    expect(html).toContain("is-active");
    expect(html).toContain('data-grp="base"');
  });

  it("一级导航源码里不再出现 3px 左侧色条（规范明令反例），选中态走 is-active", () => {
    const src = read("./PrimaryNav.tsx");
    expect(src).not.toContain("w-[3px]");
    expect(src).toContain('"is-active"');
    // 砖的选中底色在 index.css（.gx-rail-item.is-active），组件源码不写任何色值
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("未命中当前库时不是选中态（不挂 is-active）", () => {
    const html = renderNavAt("/base/other_base/table/tbl_9", {
      bases: [{ id: "base_1", name: "客户表", icon: null, iconColor: null }],
    });
    expect(html).toContain("客户表");
    expect(html).toContain("gx-rail-item");
    expect(html).not.toContain("is-active");
  });

  it("当前资源走 useMatch 而非 useParams（布局壳里 useParams 恒为 {}，选中态会永远不亮）", () => {
    const src = code("./PrimaryNav.tsx");
    expect(src).toContain("useMatch(");
    expect(src).not.toContain("useParams");
  });
});

describe("R-N-07 图标轨：恒渲染砖名 + title，无 collapsed 分支（v6 S1）", () => {
  it("不传 collapsed：砖名文本与 title tooltip 都在，行即图标轨砖", () => {
    const html = renderNavAt("/base/base_1/table/tbl_1", {
      bases: [{ id: "base_1", name: "客户表", icon: null, iconColor: null }],
    });
    expect(html).toContain("gx-rail-item");
    expect(html).toContain("gx-rail-nm");
    expect(html).toContain(">客户表<");
    expect(html).toContain('title="客户表"');
    expect(html).toContain('data-nav-row="item"');
  });

  it("PrimaryNav 源码不再接收 collapsed，也不渲染分组标题行", () => {
    const src = code("./PrimaryNav.tsx");
    expect(src).not.toContain("collapsed");
    expect(src).not.toContain('data-nav-row="group"');
    expect(src).toContain("gx-rail-item");
  });
});

describe("R-N-17 规划入口：本阶段从界面下线（点了只弹 toast 的假入口属非直觉路径）", () => {
  it("L1 不再渲染「个人门户」等规划项，也不再出现「规划中」徽标", () => {
    const html = renderNavAt("/base/base_1/table/tbl_1");
    expect(html).not.toContain("个人门户");
    expect(html).not.toContain("工作台首页");
    expect(html).not.toContain("我的待办");
    expect(html).not.toContain("我的收藏");
    expect(html).not.toContain("个人用户");
    // 徽标组件本身仍在（表格操作行 / 导出弹窗还在用），只是 L1 不再挂这些入口。
    const src = read("./PrimaryNav.tsx");
    // 断言锁定的是「声明」而非字面量：注释里仍会提到它（说明如何取回），不能误伤。
    expect(src).not.toContain("const PERSONAL_PLANNED");
    expect(src).not.toContain("function PlannedPersonalRow");
    expect(src).toContain("本阶段不启用");
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
    // 二级行本体已不再挂三点菜单（「收纳到导航」与「移动到分组」随编排下线），
    // RowMoreMenu 组件作为通用行菜单保留，护栏按组件直接渲染断言。
    const html = renderToString(
      <RowMoreMenu label="表操作菜单" items={[{ label: "移动到分组…", icon: "folderOpen", onClick: vi.fn() }]} />,
    );
    expect(html).toContain("gx-row-more");
    expect(html).toContain("h-5 w-5");
    // P3-a11y 收尾：行尾三点必须有具体作用名（table 行 → 「表操作菜单」），不再是泛泛的「行操作」
    expect(html).toContain('aria-label="表操作菜单"');
    expect(html).toContain('data-open="false"');
    // 图标名不出现在 DOM 里（Icon 只吐 path），故对源码断言用的是竖向三点而非横向 more
    expect(read("./SecondaryNavSections.tsx")).toContain('name="moreVertical"');
  });

  it("行尾三点的可访问名称按行类型区分，且未指定时回落「行操作」", () => {
    const menu = (label: string) =>
      renderToString(<RowMoreMenu label={label} items={[{ label: "移动到分组…", icon: "folderOpen", onClick: vi.fn() }]} />);
    expect(menu("文档操作菜单")).toContain('aria-label="文档操作菜单"');
    expect(menu("画布操作菜单")).toContain('aria-label="画布操作菜单"');
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

  it("二级行选中态为整行 brand-soft（v6 S2 底板 .l2-row.is-active），且不再有 3px 色条", () => {
    const entry: SecondaryEntry = {
      id: "t1", name: "客户表", kind: "table", parentId: null,
      href: "/base/b1/table/t1", icon: null, iconColor: null,
    };
    const active = renderOneRow(entry, true);
    // 选中＝外层 gx-l2-row + is-active，600 字重与品牌色由 index.css 承载（组件零 hex）
    expect(active).toContain("gx-l2-row");
    expect(active).toContain("is-active");
    expect(active).not.toContain("bg-white");
    const idle = renderOneRow(entry, false);
    expect(idle).toContain("gx-l2-item");
    expect(idle).not.toContain("is-active");
    // 底色字面值只允许落在 index.css：#eaf2fe = --brand-soft，hover 底 #f5f8fd = --hover
    const css = read("../../index.css");
    expect(css).toMatch(/\.gx-l2-row\.is-active\s*\{/);
    expect(css).toContain("#eaf2fe");
    expect(css).toMatch(/\.gx-l2-item:hover/);
    expect(css).toContain("#f5f8fd");
    const src = read("./SecondaryNavSections.tsx");
    expect(src).not.toContain("w-[3px]");
    expect(src).not.toContain('"bg-white font-semibold text-gx-accent"');
  });
});

describe("R-I-16 表级操作行（第四批：导入 / 导出已收敛到网格工具栏）", () => {
  it("「分享数据」占位已下线：有表上下文时整行不渲染，不再留空操作条", () => {
    // 改断言原因：「分享数据」是 R-N-17 的规划占位（无记录级分享接口，点了只弹一条
    // 「规划中」toast），产品已批准下线——假入口不如没有入口。加上导入 / 导出早在第四批
    // 就迁去 GridToolbar，本行已无表级入口，故与无表上下文一致返回 null（不留 40px 空条）。
    const html = renderToString(
      <StaticRouter location="/base/b1/table/t1">
        <TableActionRow tableId="t1" viewId="v1" />
      </StaticRouter>,
    );
    expect(html).toBe("");
    expect(html).not.toContain("分享数据");
    expect(html).not.toContain("规划中");
    // 源码层也不留这个占位（含它的 toast 提示与「规划中」徽标）
    const row = code("./TableActionRow.tsx");
    expect(row).not.toContain("分享数据");
    expect(row).not.toContain("plannedHint");
    expect(row).not.toContain("PlannedBadge");
    // 导入导出确已不在这一行
    expect(html).not.toContain(">导入<");
    expect(html).not.toContain(">导出<");
  });

  it("无表上下文（库首页 / 知识库 / 工作区）→ 整行不渲染、不占位", () => {
    const html = renderToString(
      <StaticRouter location="/kb/k1">
        <TableActionRow tableId={null} />
      </StaticRouter>,
    );
    expect(html).toBe("");
  });

  it("L2 装配了表级操作行；导出仍走 client.ts 不裸 fetch、不带凭据的 window.open 已禁用", () => {
    // 改断言原因：同上——导出执行侧随向导落到 GridView，端点仍是 Tables.exportCsvText，
    // 「不裸 fetch / 不用无凭据的 window.open」这条红线跟着执行侧一起断言，不放松。
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain("<TableActionRow");
    const row = code("./TableActionRow.tsx");
    expect(row).not.toContain("fetch(");
    // 服务端只认 Authorization / X-GX-Token 请求头，window.open(exportUrl) 无头 → 401
    expect(row).not.toContain("window.open");
    const grid = code("../grid/GridView.tsx");
    expect(grid).toContain("Tables.exportCsvText");
    expect(grid).not.toContain("fetch(");
    expect(grid).not.toContain("window.open");
    expect(read("../../api/client.ts")).toContain("exportCsvText");
  });
});

describe("骨架 S-1：L2 恒 236 / nav2 底；主壳无面包屑", () => {
  it("L2 面板宽 236、底为 gx-nav2、发丝线分隔", () => {
    const html = renderToString(
      <StaticRouter location="/">
        <SecondaryNav container={{ kind: "base", id: "b1", name: "默认分组" }} onClose={vi.fn()} />
      </StaticRouter>,
    );
    expect(html).toContain("width:236px");
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

  it("L1 表面为 gx-rail-surface、宽度恒走 L1_WIDTH(76)，L2 随容器有无收起（无容器不占位）", () => {
    const src = read("./WorkspaceShell.tsx");
    expect(src).toContain("gx-rail-surface");
    expect(src).toContain("L1_WIDTH");
    expect(src).toContain("showL2");
    // v6：196/56 两档与折叠读写已整体废止
    const codeSrc = code("./WorkspaceShell.tsx");
    expect(codeSrc).not.toContain("L1_WIDTH_COLLAPSED");
    expect(codeSrc).not.toContain("readL1Collapsed");
  });
});

/** 只渲染单行二级行（绕过 SecondaryNav 的数据层），用于断言选中态。 */
function renderOneRow(
  entry: SecondaryEntry,
  active: boolean = false,
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
        active={active}
        onToggleDoc={vi.fn()}
        onNavigate={vi.fn()}
      />
    </StaticRouter>,
  );
}
