import { describe, expect, it } from "vitest";
import type { MenuItemDTO, NavNodeDTO } from "@gx/shared-types";
import {
  buildCollection,
  collectedUnderSubtree,
  liveShortcutNodeIds,
  selectEntries,
  uncollectedCount,
  type CollectableEntry,
} from "./collection";

let seq = 0;
function node(over: Partial<NavNodeDTO> & { id: string; kind: NavNodeDTO["kind"] }): NavNodeDTO {
  seq += 1;
  return {
    workspaceId: "ws",
    parentId: null,
    resourceType: over.kind === "group" ? null : over.kind,
    resourceId: `res_${over.id}`,
    name: over.name ?? over.id,
    ord: over.ord ?? seq,
    path: `/${over.id}/`,
    depth: over.depth ?? 1,
    isSystem: false,
    iconName: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
    ...over,
  };
}

function menuShortcut(id: string, nodeId: string, parentId: string | null, state: "alive" | "soft_dangling" | "broken" = "alive"): MenuItemDTO {
  return {
    id,
    parentId,
    type: "shortcut",
    nodeId,
    label: null,
    iconName: null,
    ord: 0,
    node: {
      id: nodeId,
      kind: state === "broken" ? null : "table",
      name: `name_${nodeId}`,
      iconName: null,
      resourceType: "table",
      resourceId: `res_${nodeId}`,
      state,
    },
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
  };
}
function menuContainer(id: string, parentId: string | null = null): MenuItemDTO {
  return {
    id, parentId, type: "container", nodeId: null, label: id, iconName: null, ord: 0,
    node: null, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: null, deletedAt: null,
  };
}

describe("liveShortcutNodeIds", () => {
  it("只收录 alive shortcut；soft_dangling/broken 与 container 不收录", () => {
    const menu = [
      menuShortcut("m1", "n1", null),
      menuShortcut("m2", "n1", null, "soft_dangling"),
      menuShortcut("m3", "n2", null, "broken"),
      menuContainer("c1"),
    ];
    const map = liveShortcutNodeIds(menu);
    expect([...map.keys()]).toEqual(["n1"]);
    expect(map.get("n1")!.map((m) => m.id)).toEqual(["m1"]);
  });
  it("同一 nodeId 多处挂载全部保留", () => {
    const map = liveShortcutNodeIds([menuShortcut("m1", "n1", "c1"), menuShortcut("m2", "n1", "c2")]);
    expect(map.get("n1")!.length).toBe(2);
  });
});

describe("buildCollection", () => {
  const tree: NavNodeDTO[] = [
    node({ id: "kb1", kind: "kb", depth: 1 }),
    node({ id: "docTop", kind: "doc", parentId: "kb1", depth: 2 }),
    node({ id: "docChild", kind: "doc", parentId: "docTop", depth: 3 }),
    node({ id: "cv1", kind: "canvas", parentId: "kb1", depth: 2 }),
    node({ id: "base1", kind: "base", depth: 1 }),
    node({ id: "tbl1", kind: "table", parentId: "base1", depth: 2 }),
    node({ id: "view1", kind: "view", parentId: "tbl1", depth: 3 }),
    node({ id: "grp1", kind: "group", parentId: "base1", depth: 2 }),
  ];
  const coll = buildCollection(tree, []);

  it("只收集 table/doc/canvas 三类（base/kb/view/group 不入）", () => {
    expect(coll.entries.map((e) => e.node.id).sort()).toEqual(["cv1", "docChild", "docTop", "tbl1"]);
    expect(coll.byKind.table.map((e) => e.node.id)).toEqual(["tbl1"]);
    expect(coll.byKind.doc.map((e) => e.node.id)).toEqual(["docTop", "docChild"]);
    expect(coll.byKind.canvas.map((e) => e.node.id)).toEqual(["cv1"]);
  });
  it("祖先资源解析：table→base，doc/canvas→kb；isRootDoc 仅根级 doc 为真", () => {
    const tbl = coll.byKind.table[0]!;
    expect(tbl.baseResourceId).toBe("res_base1");
    expect(tbl.kbResourceId).toBeNull();
    const top = coll.entries.find((e) => e.node.id === "docTop")!;
    const child = coll.entries.find((e) => e.node.id === "docChild")!;
    expect(top.kbResourceId).toBe("res_kb1");
    expect(top.isRootDoc).toBe(true);
    expect(child.isRootDoc).toBe(false);
  });
  it("软删节点不收集", () => {
    const withDeleted = [...tree, node({ id: "tblDead", kind: "table", parentId: "base1", deletedAt: "2026-09-16T00:00:00.000Z" })];
    expect(buildCollection(withDeleted, []).byKind.table.some((e) => e.node.id === "tblDead")).toBe(false);
  });
});

describe("三视角 selectEntries", () => {
  const tree: NavNodeDTO[] = [
    node({ id: "kb1", kind: "kb" }),
    node({ id: "docTop", kind: "doc", parentId: "kb1" }),
    node({ id: "docChild", kind: "doc", parentId: "docTop" }),
    node({ id: "cv1", kind: "canvas", parentId: "kb1" }),
    node({ id: "base1", kind: "base" }),
    node({ id: "tblIn", kind: "table", parentId: "base1" }),
    node({ id: "tblOut", kind: "table", parentId: "base1" }),
  ];
  const menu = [menuContainer("c1"), menuShortcut("m1", "tblIn", "c1"), menuShortcut("m2", "docTop", "c1")];
  const coll = buildCollection(tree, menu);

  it("全部：返回四类（全部活实体）", () => {
    expect(selectEntries(coll, "all").map((e) => e.node.id).sort()).toEqual(
      ["cv1", "docChild", "docTop", "tblIn", "tblOut"],
    );
  });
  it("已收纳：只有被活 shortcut 引用的实体", () => {
    expect(selectEntries(coll, "collected").map((e) => e.node.id).sort()).toEqual(["docTop", "tblIn"]);
  });
  it("未收纳（C4）：table/canvas + 根级 doc；嵌套 doc 不计入", () => {
    const un = selectEntries(coll, "uncollected");
    expect(un.map((e) => e.node.id).sort()).toEqual(["cv1", "tblOut"]);
  });
  it("soft_dangling shortcut 不算已收纳", () => {
    const menu2 = [menuShortcut("m1", "tblOut", null, "soft_dangling")];
    const c2 = buildCollection(tree, menu2);
    expect(selectEntries(c2, "collected")).toHaveLength(0);
    expect(selectEntries(c2, "uncollected").some((e) => e.node.id === "tblOut")).toBe(true);
  });
  it("按 kind + 关键词过滤（大小写不敏感）", () => {
    const hit = selectEntries(coll, "all", { kind: "doc", query: "docCHILD" });
    expect(hit.map((e) => e.node.id)).toEqual(["docChild"]);
  });
  it("containerMenuId 限定某菜单容器内的引用", () => {
    const inC1 = selectEntries(coll, "collected", { containerMenuId: "c1" });
    expect(inC1.length).toBe(2);
    expect(selectEntries(coll, "collected", { containerMenuId: "other" })).toHaveLength(0);
  });
});

describe("uncollectedCount", () => {
  it("与 C4 未收纳列表同口径计数", () => {
    const tree: NavNodeDTO[] = [
      node({ id: "kb1", kind: "kb" }),
      node({ id: "d1", kind: "doc", parentId: "kb1" }),
      node({ id: "d2", kind: "doc", parentId: "d1" }),
      node({ id: "base1", kind: "base" }),
      node({ id: "t1", kind: "table", parentId: "base1" }),
    ];
    // 只收纳 d1：未收纳 = t1（d2 嵌套跟随，不计）
    const coll = buildCollection(tree, [menuShortcut("m1", "d1", null)]);
    expect(uncollectedCount(coll)).toBe(1);
  });
});

describe("collectedUnderSubtree", () => {
  it("容器子树（含后代容器）引用的条目去重返回", () => {
    const tree: NavNodeDTO[] = [
      node({ id: "base1", kind: "base" }),
      node({ id: "t1", kind: "table", parentId: "base1" }),
      node({ id: "t2", kind: "table", parentId: "base1" }),
    ];
    const menu = [
      menuContainer("c1"),
      menuContainer("sub", "c1"),
      menuShortcut("m1", "t1", "c1"),
      menuShortcut("m2", "t2", "sub"),
    ];
    const coll = buildCollection(tree, menu);
    const ids = collectedUnderSubtree(coll, menu, "c1").map((e: CollectableEntry) => e.node.id).sort();
    expect(ids).toEqual(["t1", "t2"]);
  });
  it("containerId=null 返回根层容器引用的条目", () => {
    const tree: NavNodeDTO[] = [
      node({ id: "base1", kind: "base" }),
      node({ id: "t1", kind: "table", parentId: "base1" }),
    ];
    const menu = [menuContainer("c1"), menuShortcut("m1", "t1", "c1")];
    const coll = buildCollection(tree, menu);
    expect(collectedUnderSubtree(coll, menu, null).map((e) => e.node.id)).toEqual(["t1"]);
  });
});
