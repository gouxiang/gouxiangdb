// M3-S10 N5 回归：新工作区外壳（S8/S9/S10）下，§1.3 旧链接生成点逐条仍产出
// /base/:id、/kb/:id 旧形 URL（裁决 2/ADR-0028：内容 URL 永不改名）。
//
// 范式（web 无 jsdom/testing-library、零新依赖）：
//   - 能纯函数断言的（navNodeHref 五 kind/祖先缺失/view/group）走值断言；
//   - 组件点击不可自动化，readFileSync 对各消费点源码做「仍 navigate 旧形 / 仍经单一真源」
//     接线守卫——锁住字符串形态与调用关系，防换壳/窗口化重构时静默改形或绕过 internalHref。
//   - 真实点击、R10 画布手势、子路径部署点击在【手测清单】（交付说明）中覆盖。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NavKind, NavNodeDTO } from "@gx/shared-types";
import {
  findAncestorOfKind,
  indexNavNodes,
  navNodeHref,
  resourceHref,
  type NodeIndex,
} from "../../features/workspace/lib/nav-links";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(here(p), "utf8");

function node(p: Partial<NavNodeDTO> & { id: string; kind: NavKind }): NavNodeDTO {
  return {
    workspaceId: "ws",
    name: p.id,
    state: "alive",
    parentId: null,
    resourceType: null,
    resourceId: null,
    ord: 0,
    path: `/${p.id}/`,
    depth: 2,
    isSystem: false,
    iconName: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
    ...p,
  } as NavNodeDTO;
}

describe("navNodeHref：菜单 shortcut 解析回旧形（五 kind + 边界）", () => {
  // base_1 ─ table_2            → /base/base_1/table/tbl_2
  // kb_3   ─ doc_4 / canvas_5  → /kb/kb_3/(doc|canvas)/d
  const items = [
    node({ id: "base_1", kind: "base", resourceType: "base", resourceId: "base_1" }),
    node({ id: "table_2", kind: "table", parentId: "base_1", resourceType: "table", resourceId: "tbl_2" }),
    node({ id: "kb_3", kind: "kb", resourceType: "kb", resourceId: "kb_3" }),
    node({ id: "doc_4", kind: "doc", parentId: "kb_3", resourceType: "doc", resourceId: "doc_4" }),
    node({ id: "canvas_5", kind: "canvas", parentId: "kb_3", resourceType: "canvas", resourceId: "can_5" }),
    node({ id: "view_6", kind: "view", parentId: "table_2", resourceType: "view", resourceId: "view_6" }),
    node({ id: "group_7", kind: "group", parentId: "kb_3" }),
    // 祖先链断裂（table 挂不到 base，模拟 broken/未回填）
    node({ id: "table_orphan", kind: "table", parentId: "missing", resourceType: "table", resourceId: "tbl_x" }),
  ];
  const index: NodeIndex = indexNavNodes(items);

  it("base/kb/table/doc/canvas 五类全部输出旧形，无 /w/node 新形", () => {
    expect(navNodeHref(index, items[0]!)).toBe("/base/base_1");
    expect(navNodeHref(index, items[2]!)).toBe("/kb/kb_3");
    expect(navNodeHref(index, items[1]!)).toBe("/base/base_1/table/tbl_2");
    expect(navNodeHref(index, items[3]!)).toBe("/kb/kb_3/doc/doc_4");
    expect(navNodeHref(index, items[4]!)).toBe("/kb/kb_3/canvas/can_5");
  });

  it("view/group/祖先缺失/无 resourceId → null（调用方禁用行，不硬跳不造 URL）", () => {
    expect(navNodeHref(index, items[5]!)).toBeNull();
    expect(navNodeHref(index, items[6]!)).toBeNull();
    expect(navNodeHref(index, items[7]!)).toBeNull();
    expect(navNodeHref(index, node({ id: "n", kind: "table" }))).toBeNull();
  });

  it("findAncestorOfKind 防御父环不致死；resourceHref 按资源对解析", () => {
    const cyclic = [
      node({ id: "a", kind: "doc", parentId: "b", resourceType: "doc", resourceId: "da" }),
      node({ id: "b", kind: "doc", parentId: "a" }),
    ];
    const ci = indexNavNodes(cyclic);
    expect(findAncestorOfKind(ci, cyclic[0]!, "kb")).toBeNull();
    expect(resourceHref(index, "table", "tbl_2")).toBe("/base/base_1/table/tbl_2");
    expect(resourceHref(index, "doc", "doc_4")).toBe("/kb/kb_3/doc/doc_4");
    expect(resourceHref(index, "table", null)).toBeNull();
    expect(resourceHref(index, "table", "nope")).toBeNull();
  });
});

describe("N5 §1.3 新壳路由声明：App.tsx 旧路径一条不删", () => {
  const app = read("../../App.tsx");
  const paths = [
    'path="/base/:baseId"',
    'path="/base/:baseId/table/:tableId"',
    'path="/base/:baseId/table/:tableId/view/:viewId"',
    'path="/base/:baseId/settings"',
    'path="/kb/:kbId"',
    'path="/kb/:kbId/doc/:docId"',
    'path="/kb/:kbId/canvas/:docId"',
  ];
  it.each(paths)("%s 仍声明", (p) => {
    expect(app).toContain(p);
  });
});

describe("N5 §1.3 旧链接生成点源码守卫（换壳/窗口化重构后仍 navigate 旧形）", () => {
  it("SearchDialog 三类结果仍跳 record/doc/canvas 旧形（record 走 query）", () => {
    // M5 后跳转模板收敛到 search-adapter.hitHref 单一真源，SearchDialog 只 navigate(hitHref(hit))，
    // 不再在组件内联三种路径。这里锁：组件确实经 hitHref 跳转；hitHref 产出的旧形由
    // search-adapter.test.ts 逐值断言（record=/base/...?record=、doc|canvas=/kb/:id/:kind/:docId）。
    const s = read("../../features/search/SearchDialog.tsx");
    expect(s).toContain("navigate(hitHref(hit))");
    expect(s).toContain('from "./search-adapter"');
    const adapter = read("../../features/search/search-adapter.ts");
    expect(adapter).toContain("`/base/${hit.baseId}/table/${hit.tableId}?record=${hit.entityId}`");
    // doc/canvas 共用同一模板（kind 段由 hit.type 决定）
    expect(adapter).toContain("`/kb/${hit.kbId}/${hit.type}/${hit.docId}`");
  });

  it("画布 DocRefCard 双分支仍为 /kb/:id/(doc|canvas)/:docId", () => {
    const s = read("../../features/kb/canvas/DocRefCard.tsx");
    expect(s).toContain('ref_.kind === "canvas" ? `/kb/${kbId}/canvas/${ref_.docId}` : `/kb/${kbId}/doc/${ref_.docId}`');
  });

  it("GxLinkBlockView 解析后 navigate 的 target 仍是 /kb/:id/:kind/:docId 旧形", () => {
    const s = read("../../features/kb/canvas/GxLinkBlockView.tsx");
    expect(s).toContain("const target = `/kb/${kbId ?? \"\"}/${element.gxLinkRef.kind}/${element.gxLinkRef.docId}`");
    expect(s).toContain("navigate(target)");
  });

  it("RefEmbedBody 的 onNavigate 交回 react-router navigate（不整页刷新、不新形）", () => {
    const s = read("../../features/kb/canvas/RefEmbedBody.tsx");
    expect(s).toContain("onNavigate: (p) => navigate(p)");
  });

  it("ShareJoin 落地与兜底分别为 /base/:id 与 /、/login（无新壳专用落地路径）", () => {
    const s = read("../../features/auth/ShareJoinPage.tsx");
    expect(s).toContain("navigate(`/base/${result.baseId}`)");
    expect(s).toContain('navigate(loggedIn ? "/" : "/login")');
  });

  it("表页 TopBar：视图切换、分享设置锚点、删表回落仍为旧形；面包屑按 R-N-19 下线", () => {
    const s = read("../../features/shell/TopBar.tsx");
    expect(s).toContain("navigate(`/base/${baseId}/table/${tableId}/view/${v.id}`)");
    expect(s).toContain("navigate(`/base/${baseId}/settings#share`)");
    expect(s).toContain("navigate(`/base/${baseId}`)");
    // R-N-19：主壳内不渲染面包屑——原「库名 › 表名」链整段移除，该条旧形随链一起下线，
    // 故此处改断言它【不再】出现（防后续有人把面包屑加回来）。
    expect(s).not.toContain("navigate(`/base/${baseId}/table/${tableId}`)");
  });

  it("ViewTabs 切视图仍跳 /base/:id/table/:tid/view/:vid", () => {
    const s = read("../../features/shell/ViewTabs.tsx");
    expect(s).toContain("navigate(`/base/${baseId}/table/${tableId}/view/${v.id}`)");
  });

  it("LibrarySwitcher 四个跳转点（base/kb 各两处）仍为旧形", () => {
    const s = read("../../components/LibrarySwitcher.tsx");
    expect(s).toContain("navigate(`/base/${b.id}`)");
    expect(s).toContain("navigate(`/kb/${r.knowledgeBase.id}`)");
    expect(s).toContain("navigate(`/kb/${k.id}`)");
    // base 出现至少两次（快捷入口 + 列表行）
    expect(s.match(/navigate\(`\/base\/\$\{b\.id\}`\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("正文两个编辑器仍以 internalHref 为内部链接单一真源（防重构时绕过协议手写 href）", () => {
    const md = read("../../features/kb/MarkdownEditor.tsx");
    const wys = read("../../features/kb/WysiwygEditor.tsx");
    expect(md).toContain("internalHref(");
    expect(wys).toContain("internalHref(");
    // 编辑器内不允许直接手拼 /kb/ /base/ 模板串（一律走 internalHref）
    expect(md).not.toMatch(/`\/kb\/\$\{|`\/base\/\$\{/);
    expect(wys).not.toMatch(/`\/kb\/\$\{|`\/base\/\$\{/);
  });

  it("新壳一级/二级导航自身只经 navNodeHref 产出 href，不出现手拼 /base /kb 模板串", () => {
    const primary = read("../../features/workspace/PrimaryNav.tsx");
    const secondary = read("../../features/workspace/SecondaryNavSections.tsx");
    expect(primary).toContain("navNodeHref(");
    expect(secondary).toContain("navNodeHref(");
    expect(primary).not.toMatch(/`\/kb\/\$\{|`\/base\/\$\{/);
    expect(secondary).not.toMatch(/`\/kb\/\$\{|`\/base\/\$\{/);
  });
});
