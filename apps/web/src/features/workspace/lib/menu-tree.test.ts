// M3/S8 菜单树纯函数 characterization：组树/排序/悬挂三态过滤/激活定位/计数。
import { describe, it, expect } from "vitest";
import type { MenuItemDTO, MenuTreeDTO, MenuNodeSummaryDTO } from "@gx/shared-types";
import {
  buildMenuTree,
  composerItemState,
  filterBrowsableItems,
  filterComposerItems,
  findActiveShortcuts,
  isBrowsableShortcut,
  isComposerVisible,
  visibleShortcutCount,
  type MenuTreeNode,
} from "./menu-tree";

function summary(over: Partial<MenuNodeSummaryDTO>): MenuNodeSummaryDTO {
  return {
    id: over.id ?? "node",
    kind: over.kind ?? "table",
    name: over.name ?? "表",
    iconName: null,
    resourceType: over.resourceType ?? "table",
    resourceId: over.resourceId ?? "res",
    state: over.state ?? "alive",
  };
}

function item(over: Partial<MenuItemDTO> & { id: string }): MenuItemDTO {
  const type = over.type ?? "shortcut";
  const nodeState = over.node?.state ?? "alive";
  return {
    parentId: over.parentId ?? null,
    type,
    nodeId: over.nodeId ?? (type === "shortcut" ? `nav_${over.id}` : null),
    label: over.label ?? null,
    iconName: over.iconName ?? null,
    ord: over.ord ?? 0,
    node:
      over.node !== undefined
        ? over.node
        : type === "container"
          ? null
          : summary({ id: `nav_${over.id}`, state: nodeState, resourceId: over.id }),
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
    ...over,
  };
}

describe("buildMenuTree", () => {
  it("平铺按 parentId 组两层容器树，ord 升序、同 ord 按 id 兜底", () => {
    const items: MenuItemDTO[] = [
      item({ id: "s2", parentId: "c1", ord: 2 }),
      item({ id: "c1", type: "container", nodeId: null, node: null, ord: 1 }),
      item({ id: "s1", parentId: "c1", ord: 1 }),
      item({ id: "c0", type: "container", nodeId: null, node: null, ord: 0 }),
    ];
    const tree = buildMenuTree(items);
    expect(tree.map((n) => n.item.id)).toEqual(["c0", "c1"]);
    expect(tree[1]!.children.map((c) => c.item.id)).toEqual(["s1", "s2"]);
  });

  it("父项缺失的孤儿按根项挂出（不白屏）", () => {
    const tree = buildMenuTree([item({ id: "x", parentId: "missing" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.item.id).toBe("x");
  });

  it("防御自引用 parentId=id 不无限递归，挂根", () => {
    const tree = buildMenuTree([item({ id: "self", parentId: "self", type: "container", nodeId: null, node: null })]);
    expect(tree).toHaveLength(1);
  });
});

describe("shortcut 悬挂三态浏览规则（openapi state，前端写死）", () => {
  it("alive shortcut 可浏览；soft_dangling/broken 浏览态隐藏", () => {
    const alive = item({ id: "a" });
    const soft = item({ id: "b", node: summary({ id: "b", state: "soft_dangling", resourceId: "b" }) });
    const broken = item({ id: "c", node: summary({ id: "c", state: "broken", resourceId: "c" }) });
    expect(isBrowsableShortcut(alive)).toBe(true);
    expect(isBrowsableShortcut(soft)).toBe(false);
    expect(isBrowsableShortcut(broken)).toBe(false);
  });

  it("container 恒可浏览；shortcut node=null（broken 摘要缺失）不可浏览", () => {
    const c = item({ id: "c", type: "container", nodeId: null, node: null });
    const s = item({ id: "s", node: null });
    expect(isBrowsableShortcut(c)).toBe(true);
    expect(isBrowsableShortcut(s)).toBe(false);
  });

  it("filterBrowsableItems 剔除全部悬挂 shortcut，保留容器", () => {
    const kept = filterBrowsableItems([
      item({ id: "c", type: "container", nodeId: null, node: null }),
      item({ id: "ok" }),
      item({ id: "gone", node: summary({ id: "gone", state: "soft_dangling", resourceId: "gone" }) }),
    ]);
    expect(kept.map((i) => i.id)).toEqual(["c", "ok"]);
  });

  it("编排态：broken 显灰保留可清理（含 node=null），soft_dangling 与浏览态一致全员隐藏", () => {
    expect(isComposerVisible(item({ id: "b", node: summary({ id: "b", state: "broken", resourceId: "b" }) }))).toBe(true);
    expect(isComposerVisible(item({ id: "s", node: summary({ id: "s", state: "soft_dangling", resourceId: "s" }) }))).toBe(false);
    expect(isComposerVisible(item({ id: "n", node: null }))).toBe(true);
  });

  it("filterComposerItems 剔除 soft_dangling shortcut，保留 alive/broken 与容器", () => {
    const kept = filterComposerItems([
      item({ id: "c", type: "container", nodeId: null, node: null }),
      item({ id: "ok" }),
      item({ id: "brk", node: summary({ id: "brk", state: "broken", resourceId: "brk" }) }),
      item({ id: "soft", node: summary({ id: "soft", state: "soft_dangling", resourceId: "soft" }) }),
    ]);
    expect(kept.map((i) => i.id)).toEqual(["c", "ok", "brk"]);
  });
});

describe("composerItemState 编排态行状态（容器缺摘要回归）", () => {
  it("容器 node 恒 null 也必须判 alive，不显示已失效徽章/删除线（S9 真机回归）", () => {
    const c1 = item({ id: "c1", type: "container", nodeId: "nav_base_1", node: null });
    const c2 = item({ id: "c2", type: "container", nodeId: null, node: null });
    expect(composerItemState(c1)).toBe("alive");
    expect(composerItemState(c2)).toBe("alive");
  });

  it("shortcut 按摘要三态；node=null 视为 broken", () => {
    expect(composerItemState(item({ id: "a" }))).toBe("alive");
    expect(composerItemState(item({ id: "s", node: summary({ id: "s", state: "soft_dangling", resourceId: "s" }) }))).toBe(
      "soft_dangling",
    );
    expect(composerItemState(item({ id: "b", node: summary({ id: "b", state: "broken", resourceId: "b" }) }))).toBe("broken");
    expect(composerItemState(item({ id: "n", node: null }))).toBe("broken");
  });
});

describe("激活定位与可见计数", () => {
  const menu: MenuTreeDTO = {
    workspaceId: "ws_default",
    menuVersion: 1,
    items: [
      item({ id: "c", type: "container", nodeId: null, node: null }),
      item({ id: "t1", parentId: "c", node: summary({ id: "n1", resourceId: "tbl_1", state: "alive" }) }),
      // 同一实体多处挂载（第二处也应高亮）
      item({ id: "t1b", node: summary({ id: "n1b", resourceId: "tbl_1", state: "alive" }) }),
      item({ id: "t2", parentId: "c", node: summary({ id: "n2", resourceId: "tbl_2", state: "soft_dangling" }) }),
    ],
  };

  it("findActiveShortcuts 返回指向当前资源的全部活 shortcut（多处挂载均命中）", () => {
    const hits = findActiveShortcuts(menu, "tbl_1").map((i) => i.id);
    expect(hits).toEqual(["t1", "t1b"]);
  });

  it("悬挂 shortcut 不参与激活；空资源 id 返回空", () => {
    expect(findActiveShortcuts(menu, "tbl_2")).toEqual([]);
    expect(findActiveShortcuts(menu, null)).toEqual([]);
    expect(findActiveShortcuts(undefined, "tbl_1")).toEqual([]);
  });

  it("visibleShortcutCount 只数活 shortcut（容器递归、悬挂不计）", () => {
    const tree = buildMenuTree(menu.items);
    const countAll = (nodes: MenuTreeNode[]): number =>
      nodes.reduce((acc, n) => acc + (n.item.type === "shortcut" ? 1 : 0) + countAll(n.children), 0);
    expect(countAll(tree)).toBe(3);
    expect(visibleShortcutCount(tree)).toBe(2);
  });
});
