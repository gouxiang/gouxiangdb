// M3/S10 导航组件级回归（node 环境，react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 第三批导航重构后本文件锁的是**新的渲染契约**：
//   - 一级只渲染 bases + knowledge_bases 两组，实体名正常输出；
//   - 一级里不出现任何二级内容（表 / 文档 / 画布）——用户定的红线；
//   - 旧链不改名：/base/:id 与 /kb/:id 仍是这两个入口的 href 形态（N5 §1.3）；
//   - 每个库在一级只出现一次（数据源改成实体列表后，天然不存在「同一实体多处挂载」）。
//
// 已随 menu_items 下线、不再在此断言的旧语义：
//   三态浏览渲染（alive / soft_dangling / broken）——L1 不再渲染 shortcut；
//   同一 node 的多条 shortcut 去重 —— L1 直接列实体，一行一库。
// 纯函数层的编排/三分区/409 行为见 ac-m3-1.test.ts；本文件锁「渲染出来的 HTML」。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { NavNodeDTO } from "@gx/shared-types";
import { indexNavNodes, navNodeHref } from "./lib/nav-links";

// L2「库操作」新断言需要渲染真实 SecondaryNav：与 secondary-nav-render.test.tsx 同款 mock。
vi.mock("../../api/hooks", () => ({
  useTables: (baseId: string | null) => ({
    data: baseId ? [] : undefined,
    isLoading: false,
    isError: false,
  }),
  useBase: () => ({ data: { permissions: { canManageSchema: true } } }),
  useGXMutations: () => ({
    createTable: { mutateAsync: vi.fn() },
    updateTable: { mutateAsync: vi.fn() },
    duplicateTable: { mutateAsync: vi.fn() },
    clearTable: { mutateAsync: vi.fn() },
    deleteTable: { mutateAsync: vi.fn() },
    restoreTrash: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("../kb/kb-hooks", () => ({
  useKbDocs: () => ({ data: [], isLoading: false, isError: false }),
  useKb: () => ({ data: { role: "owner" } }),
  useCreateDoc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMoveDoc: () => ({ mutateAsync: vi.fn() }),
}));

import { PrimaryNav } from "./PrimaryNav";
import { SecondaryNav } from "./SecondaryNav";

const TS = "2026-09-16T00:00:00.000Z";

function treeNode(id: string, kind: NavNodeDTO["kind"], resourceId: string, parentId: string | null): NavNodeDTO {
  return {
    workspaceId: "ws", id, parentId, resourceType: kind === "group" ? null : kind, resourceId,
    name: id, ord: 0, path: `/${id}/`, depth: parentId ? 2 : 1, isSystem: false, iconName: null,
    createdAt: TS, updatedAt: null, deletedAt: null, kind,
  } as NavNodeDTO;
}

interface LibDTO {
  id: string;
  name: string;
  icon?: string | null;
  iconColor?: string | null;
  /** 本人角色；缺省按 owner（与 KbSettingsPage 的 role ?? "owner" 同口径）。 */
  role?: string;
}

const BASES: LibDTO[] = [
  { id: "base_1", name: "客户主库", icon: null, iconColor: null },
  { id: "base_2", name: "订单库", icon: null, iconColor: null },
];
const KBS: LibDTO[] = [{ id: "kb_9", name: "产品知识库", icon: null, iconColor: null }];

function renderNav(location = "/", props: { bases?: LibDTO[]; kbs?: LibDTO[] } = {}) {
  return renderToString(
    <StaticRouter location={location}>
      <PrimaryNav bases={props.bases ?? []} kbs={props.kbs ?? []} />
    </StaticRouter>,
  );
}

beforeEach(() => {
  // 夹具是常量，无需重置；保留 hook 以满足后续可能的扩展
});

describe("PrimaryNav 一级只列数据库与知识库（第三批契约；v6 S1：分组永不画线）", () => {
  it("全部库名都输出且带 data-grp 分组归属；组名文字不渲染；空态不渲染文字块", () => {
    const html = renderNav("/", { bases: BASES, kbs: KBS });
    // v6 S1：分组在表层不做视觉体现（底板契约），组名文字与 data-nav-row="group" 都不出现
    expect(html).not.toContain('data-nav-row="group"');
    expect(html).not.toContain(">数据库<");
    expect(html).not.toContain(">知识库<");
    expect(html).toContain('data-grp="base"');
    expect(html).toContain('data-grp="kb"');
    expect(html).toContain("客户主库");
    expect(html).toContain("订单库");
    expect(html).toContain("产品知识库");

    // 空态：不渲染文字块（建库入口在轨道底部常驻可达，PrimaryNav 本身不挂建库钮）
    const empty = renderNav();
    expect(empty).not.toContain("暂无数据库或知识库");
    expect(empty).not.toContain('data-nav-row="item"');
  });

  it("一级内不出现任何二级内容（表 / 文档 / 画布）", () => {
    const html = renderNav("/base/base_1", { bases: BASES, kbs: KBS });
    // 数据源里根本没有二级实体，行标记只有 base / kb 两档
    expect(html).toContain('data-nav-entity="base"');
    expect(html).toContain('data-nav-entity="kb"');
    expect(html).not.toContain('data-nav-entity="table"');
    expect(html).not.toContain('data-nav-entity="doc"');
    expect(html).not.toContain('data-nav-entity="canvas"');
    // 只读实体列表，不消费 menu_items / nav 树（这是「一级无二级」的根因保证）
    const src = readFileSync(fileURLToPath(new URL("./PrimaryNav.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain("useNavMenu");
    expect(src).not.toContain("useNavNodeIndex");
    expect(src).not.toContain("buildCollection");
  });

  it("每个库只占一行（L1 直接列实体，不存在「同一实体多处挂载」）", () => {
    const html = renderNav("/", { bases: BASES });
    expect((html.match(/data-nav-entity="base"/g) ?? []).length).toBe(2);
    expect(html).toContain("客户主库");
    expect(html).toContain("订单库");
  });

  it("停在库的任意子资源上，一级对应行仍是选中态（刷新/直访都成立）", () => {
    const html = renderNav("/base/base_1/table/tbl_1", { bases: BASES, kbs: KBS });
    expect(html).toContain("is-active");
    expect(html).toContain("gx-rail-item");
    // 未命中的库不亮选中态
    const other = renderNav("/kb/kb_9/doc/d1", { bases: BASES, kbs: KBS });
    expect(other).toContain("is-active");
    expect(other).toContain("gx-rail-tile");
  });

  it("渲染出的入口不含 /w/ 新形前缀；旧形 href 模板仍是 /base/:id 与 /kb/:id", () => {
    const html = renderNav("/", { bases: BASES, kbs: KBS });
    expect(html).not.toContain("/w/");
    expect(html).not.toContain("/workspace/");
    const src = readFileSync(fileURLToPath(new URL("./PrimaryNav.tsx", import.meta.url)), "utf8");
    expect(src).toContain("`/base/${row.entityId}`");
    expect(src).toContain("`/kb/${row.entityId}`");
  });
});

describe("L1 砖行不再挂库操作菜单（v6 S1：重命名 / 设置迁到 L2 面板头）", () => {
  it("L1 砖上没有任何 aria-haspopup，也没有「数据库操作 / 知识库操作」aria-label", () => {
    const html = renderNav("/", { bases: BASES, kbs: KBS });
    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).not.toContain("数据库操作");
    expect(html).not.toContain("知识库操作");
  });

  it("PrimaryNav 源码不再产出库操作菜单项（重命名 / 设置接线已迁走）", () => {
    const src = readFileSync(fileURLToPath(new URL("./PrimaryNav.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain("RowMoreMenu");
    expect(src).not.toContain("打开数据库设置");
    expect(src).not.toContain("打开知识库设置");
  });

  it("无管理角色（viewer）也与砖行菜单无关：砖行结构对所有角色一致（操作在 L2 头）", () => {
    const html = renderNav("/", {
      bases: [{ id: "base_2", name: "订单库", icon: null, iconColor: null, role: "viewer" }],
    });
    expect(html).toContain("订单库");
    expect(html).toContain('data-nav-row="item"');
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("图标轨恒定渲染（折叠档废止）：不传 collapsed，砖名与 title 恒在", () => {
    const html = renderNav("/", { bases: BASES, kbs: KBS });
    expect(html).toContain(">客户主库<");
    expect(html).toContain('title="客户主库"');
    expect(html).not.toContain('data-nav-row="group"');
  });

  it("重命名/设置已迁 L2 头：SecondaryNav 传 libraryCanManage 时出现 aria-label=\"库操作\"", () => {
    const html = renderToString(
      <StaticRouter location="/base/b1">
        <SecondaryNav
          container={{ kind: "base", id: "b1", name: "客户主数据库" }}
          onClose={vi.fn()}
          libraryCanManage
          onRenameLibrary={vi.fn()}
        />
      </StaticRouter>,
    );
    expect(html).toContain('aria-label="库操作"');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("默认不传 libraryCanManage 时 L2 头不渲染库操作钮（旧契约不破）", () => {
    const html = renderToString(
      <StaticRouter location="/base/b1">
        <SecondaryNav container={{ kind: "base", id: "b1", name: "客户主数据库" }} onClose={vi.fn()} />
      </StaticRouter>,
    );
    expect(html).not.toContain('aria-label="库操作"');
  });
});

describe("N5 §1.3 旧链形态：nav 树解析与路由声明仍为旧形（冷备未坏）", () => {
  it("navNodeHref 把 table/doc/canvas/base/kb 解析为旧形，且 App.tsx 仍声明对应旧路由", () => {
    const treeItems = [
      treeNode("nav_b", "base", "base_9", null),
      treeNode("nav_t", "table", "tbl_9", "nav_b"),
      treeNode("nav_k", "kb", "kb_9", null),
      treeNode("nav_d", "doc", "doc_9", "nav_k"),
      treeNode("nav_c", "canvas", "can_9", "nav_k"),
    ];
    const idx = indexNavNodes(treeItems);
    expect(navNodeHref(idx, idx.byId.get("nav_t")!)).toBe("/base/base_9/table/tbl_9");
    expect(navNodeHref(idx, idx.byId.get("nav_d")!)).toBe("/kb/kb_9/doc/doc_9");
    expect(navNodeHref(idx, idx.byId.get("nav_c")!)).toBe("/kb/kb_9/canvas/can_9");
    expect(navNodeHref(idx, idx.byId.get("nav_b")!)).toBe("/base/base_9");
    expect(navNodeHref(idx, idx.byId.get("nav_k")!)).toBe("/kb/kb_9");
    const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain('path="/base/:baseId/table/:tableId"');
    expect(app).toContain('path="/kb/:kbId/doc/:docId"');
    expect(app).toContain('path="/kb/:kbId/canvas/:docId"');
  });
});
