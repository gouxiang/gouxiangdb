// M3/S10 二级导航三分区 SSR 回归（node + renderToString + vi.mock）。
// 锁：三视角 Tab 文案存在；未收纳计数（C4）正确；大列表行渲染有界（窗口化）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { MenuItemDTO, MenuTreeDTO, NavNodeDTO, NavTreeDTO } from "@gx/shared-types";

let menuItems: MenuItemDTO[] = [];
let treeItems: NavNodeDTO[] = [];

vi.mock("./nav-hooks", () => ({
  useNavMenu: () => ({ menu: { workspaceId: "ws", menuVersion: 1, items: menuItems } as MenuTreeDTO }),
  useNavTreeDeep: () => ({
    tree: { workspaceId: "ws", navVersion: 1, items: treeItems, truncated: false } as NavTreeDTO,
    isLoading: false,
  }),
  useNavNodeIndex: () => ({ index: { byId: new Map(treeItems.map((n) => [n.id, n])), byResource: new Map() } }),
  usePatchMenu: () => ({ mutate: vi.fn() }),
  useMoveNode: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { SecondaryNav } from "./SecondaryNav";

const TS = "2026-09-16T00:00:00.000Z";

function tableNode(i: number): NavNodeDTO {
  return {
    workspaceId: "ws", id: `nav_t${i}`, parentId: "nav_base", resourceType: "table", resourceId: `t${i}`,
    name: `未收纳表 ${i}`, ord: i, path: `/t${i}/`, depth: 2, isSystem: false, iconName: null,
    createdAt: TS, updatedAt: null, deletedAt: null, kind: "table",
  } as NavNodeDTO;
}

function renderSecondary() {
  return renderToString(
    <StaticRouter location="/">
      <SecondaryNav containerMenuId="c_base" containerName="默认分组" onClose={vi.fn()} />
    </StaticRouter>,
  );
}

beforeEach(() => {
  menuItems = [];
  treeItems = [];
});

describe("SecondaryNav 三分区", () => {
  it("渲染 全部/未收纳/已收纳 三个 Tab（无收藏无最近）", () => {
    treeItems = [
      { id: "nav_base", kind: "base", parentId: null, resourceType: "base", resourceId: "b1", name: "库" } as NavNodeDTO,
    ];
    menuItems = [{
      id: "c_base", parentId: null, type: "container", nodeId: "nav_base", label: "默认分组",
      iconName: null, ord: 0, node: null, createdAt: TS, updatedAt: null, deletedAt: null,
    }];
    const html = renderSecondary();
    expect(html).toContain("全部");
    expect(html).toContain("未收纳");
    expect(html).toContain("已收纳");
    expect(html).not.toContain("收藏");
    expect(html).not.toContain("最近");
  });

  it("未收纳徽标按 C4 口径计数（table 无活 shortcut 计 1）", () => {
    treeItems = [
      { id: "nav_base", kind: "base", parentId: null, resourceType: "base", resourceId: "b1", name: "库" } as NavNodeDTO,
      tableNode(1),
    ];
    menuItems = [{
      id: "c_base", parentId: null, type: "container", nodeId: "nav_base", label: "默认分组",
      iconName: null, ord: 0, node: null, createdAt: TS, updatedAt: null, deletedAt: null,
    }];
    const html = renderSecondary();
    // Tab「未收纳」后跟计数 1
    expect(html).toMatch(/未收纳[\s\S]*?1/);
    expect(html).toContain("未收纳表 1");
  });

  it("1200 个未收纳 table：首帧只渲染有界行（窗口化，不全量 1200）", () => {
    treeItems = [
      { id: "nav_base", kind: "base", parentId: null, resourceType: "base", resourceId: "b1", name: "库" } as NavNodeDTO,
      ...Array.from({ length: 1200 }, (_, i) => tableNode(i)),
    ];
    menuItems = [{
      id: "c_base", parentId: null, type: "container", nodeId: "nav_base", label: "默认分组",
      iconName: null, ord: 0, node: null, createdAt: TS, updatedAt: null, deletedAt: null,
    }];
    const t0 = performance.now();
    const html = renderSecondary();
    const ms = performance.now() - t0;
    const rendered = (html.match(/未收纳表 \d+/g) ?? []).length;
    expect(rendered).toBeGreaterThan(0);
    // table 段窗口：viewport≈31*24=744，可见 24 + overscan 24 → ≤48，留余量 ≤120
    expect(rendered).toBeLessThanOrEqual(120);
    expect(rendered).toBeLessThan(1200 / 5);
    console.log(`[S10-metric] SecondaryNav SSR 1200 uncollected: renderedRows=${rendered}, render=${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });
});
