// M3/S10 导航组件级回归（node 环境，react-dom/server + vi.mock，无 jsdom/新依赖）。
//
// 覆盖：
//  - AC-M3-1 三态浏览渲染：alive 显示；soft_dangling/broken 在一级导航浏览态都不输出
//  - N5 旧链回归：新 WorkspaceShell 下 PrimaryNav 的 shortcut 解析出的 href 仍是
//    /base/:b/table/:t、/kb/:k/doc/:d 等旧形；命中当前旧路径的项高亮（active class）
//  - 多处挂载：同一 node 多条 shortcut 都渲染（不被去重隐藏）
// 纯函数层的编排/三分区/409 行为见 ac-m3-1.test.ts；本文件锁「渲染出来的 HTML」。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { MenuItemDTO, MenuNodeSummaryDTO, MenuTreeDTO, NavNodeDTO } from "@gx/shared-types";
import { indexNavNodes, navNodeHref } from "./lib/nav-links";

// ---- 可控夹具 ----
let menuItems: MenuItemDTO[] = [];
let treeItems: NavNodeDTO[] = [];

vi.mock("./nav-hooks", () => ({
  useNavMenu: () => ({
    menu: { workspaceId: "ws", menuVersion: 1, items: menuItems } as MenuTreeDTO,
    isLoading: false,
    isError: false,
  }),
  useNavNodeIndex: () => ({
    index: {
      byId: new Map(treeItems.map((n) => [n.id, n])),
      byResource: new Map(),
    },
  }),
  useNavTreeDeep: () => ({ tree: { workspaceId: "ws", navVersion: 1, items: treeItems, truncated: false }, isLoading: false }),
  usePatchMenu: () => ({ mutate: vi.fn() }),
  useMoveNode: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { PrimaryNav } from "./PrimaryNav";

const TS = "2026-09-16T00:00:00.000Z";

function summary(over: Partial<MenuNodeSummaryDTO> & { id: string }): MenuNodeSummaryDTO {
  return {
    id: over.id,
    kind: over.kind ?? "table",
    name: over.name ?? over.id,
    iconName: null,
    resourceType: over.resourceType ?? over.kind ?? "table",
    resourceId: over.resourceId ?? over.id,
    state: over.state ?? "alive",
  };
}

function shortcut(
  id: string,
  nodeId: string,
  state: MenuNodeSummaryDTO["state"] = "alive",
  kind: MenuNodeSummaryDTO["kind"] = "table",
  resourceId?: string,
): MenuItemDTO {
  return {
    id, parentId: null, type: "shortcut", nodeId, label: null, iconName: null, ord: 0,
    node: state === "alive" || state === "soft_dangling" || state === "broken"
      ? summary({ id: nodeId, state, kind, resourceId: resourceId ?? nodeId.replace("nav_", "res_") })
      : null,
    createdAt: TS, updatedAt: null, deletedAt: null,
  };
}

function treeNode(id: string, kind: NavNodeDTO["kind"], resourceId: string, parentId: string | null): NavNodeDTO {
  return {
    workspaceId: "ws", id, parentId, resourceType: kind === "group" ? null : kind, resourceId,
    name: id, ord: 0, path: `/${id}/`, depth: parentId ? 2 : 1, isSystem: false, iconName: null,
    createdAt: TS, updatedAt: null, deletedAt: null, kind,
  } as NavNodeDTO;
}

function renderNav(location = "/") {
  return renderToString(
    <StaticRouter location={location}>
      <PrimaryNav />
    </StaticRouter>,
  );
}

beforeEach(() => {
  menuItems = [];
  treeItems = [];
});

describe("PrimaryNav 三态浏览渲染（AC-M3-1 C-12）", () => {
  it("alive shortcut 输出名称；soft_dangling 与 broken 浏览态都不输出", () => {
    menuItems = [
      { ...shortcut("m_ok", "nav_ok", "alive", "table"), ord: 0 },
      { ...shortcut("m_soft", "nav_soft", "soft_dangling", "table"), ord: 1 },
      { ...shortcut("m_broken", "nav_broken", "broken", "table"), ord: 2 },
    ];
    menuItems[0]!.node = summary({ id: "nav_ok", name: "活表", state: "alive", resourceId: "res_ok" });
    treeItems = [
      treeNode("nav_ok", "table", "res_ok", "nav_base"),
      treeNode("nav_base", "base", "base_1", null),
    ];
    const html = renderNav();
    expect(html).toContain("活表");
    expect(html).not.toContain("nav_soft");
    expect(html).not.toContain("nav_broken");
  });

  it("broken 项即便 node 摘要非 null（后端 brokenSummary 形态）也不渲染", () => {
    menuItems = [shortcut("m_b", "nav_ghost", "broken", "table", "res_gone")];
    const html = renderNav();
    expect(html).not.toContain("res_gone");
  });
});

describe("PrimaryNav N5 旧链形态（href 不改名）", () => {
  it("navNodeHref 把 table/doc/canvas/base/kb 解析为旧形，且 App.tsx 仍声明对应旧路由", () => {
    treeItems = [
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
    // 新壳换皮不换路由：旧路径仍在 App.tsx 声明（防 S8/S10 误改成 /w/:nodeId）
    const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain('path="/base/:baseId/table/:tableId"');
    expect(app).toContain('path="/kb/:kbId/doc/:docId"');
    expect(app).toContain('path="/kb/:kbId/canvas/:docId"');
  });

  it("渲染出的 shortcut 不含新形前缀，实体名正常输出", () => {
    const s = shortcut("m_t", "nav_t", "alive", "table", "tbl_9");
    s.node = summary({ id: "nav_t", name: "客户", state: "alive", kind: "table", resourceId: "tbl_9" });
    menuItems = [s];
    treeItems = [
      treeNode("nav_t", "table", "tbl_9", "nav_b"),
      treeNode("nav_b", "base", "base_9", null),
    ];
    const html = renderNav();
    expect(html).toContain("客户");
    expect(html).not.toContain("/w/");
    expect(html).not.toContain("/workspace/");
  });
});

describe("PrimaryNav 同一实体多处挂载", () => {
  it("同一 node 的两条 shortcut 都渲染（不去重），当前旧路径两处都高亮", () => {
    const mk = (id: string, ord: number): MenuItemDTO => {
      const s = shortcut(id, "nav_t", "alive", "table", "tbl_1");
      s.ord = ord;
      s.node = summary({ id: "nav_t", name: "共享表", state: "alive", kind: "table", resourceId: "tbl_1" });
      return s;
    };
    menuItems = [mk("m1", 0), mk("m2", 1)];
    treeItems = [
      treeNode("nav_t", "table", "tbl_1", "nav_b"),
      treeNode("nav_b", "base", "base_1", null),
    ];
    const html = renderNav("/base/base_1/table/tbl_1");
    expect(html).toContain("共享表");
    // 两处 active 3px 指示条（bg-gx-accent-bg 行），断言出现两次可点击项文本
    const occurrences = html.split("共享表").length - 1;
    expect(occurrences).toBe(2);
  });
});
