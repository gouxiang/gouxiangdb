// M3/S9 二级导航三视角纯函数（裁决 8：全部/未收纳/已收纳；无收藏无最近）。
//
// 输入：nav tree（权威实体平铺）+ menu（引用层）。
// 收纳口径对齐 reconcile C4（reconcile-menu.ts:79）：
//   - table/canvas：活节点且无任何活 shortcut 引用 = 未收纳
//   - doc：kb 根级（parentId 指向 kb 容器）活 doc 无活 shortcut = 未收纳；
//     嵌套 doc 跟随父文档，不单独计入 C4（但"全部"列表仍展示全部活 doc）
// view/base/kb/group 不参与收纳计数。

import type { MenuItemDTO, NavKind, NavNodeDTO } from "@gx/shared-types";

export type CollectableKind = "table" | "doc" | "canvas";
export type CollectionView = "all" | "uncollected" | "collected";

export interface CollectableEntry {
  kind: CollectableKind;
  node: NavNodeDTO;
  /** 指向本节点的活 shortcut 菜单项（可多处，全部列出）。 */
  shortcuts: MenuItemDTO[];
  /** doc/canvas 的 kb 祖先资源 id（分段展示与 href 用）。 */
  kbResourceId: string | null;
  /** table 的 base 祖先资源 id。 */
  baseResourceId: string | null;
  /** doc 父节点为 kb 容器（kb 根级文档，C4 口径参与未收纳计数）。 */
  isRootDoc: boolean;
}

const COLLECTABLE: ReadonlySet<NavKind> = new Set(["table", "doc", "canvas"]);

/** 活菜单 shortcut 的 nodeId → 菜单项列表（state=alive；soft_dangling/broken 不算已收纳）。 */
export function liveShortcutNodeIds(menu: readonly MenuItemDTO[]): Map<string, MenuItemDTO[]> {
  const map = new Map<string, MenuItemDTO[]>();
  for (const item of menu) {
    if (item.type !== "shortcut" || !item.nodeId || !item.node) continue;
    if (item.node.state !== "alive") continue;
    const arr = map.get(item.nodeId);
    if (arr) arr.push(item);
    else map.set(item.nodeId, [item]);
  }
  return map;
}

function ancestorResource(
  index: Map<string, NavNodeDTO>,
  node: NavNodeDTO,
  kind: NavKind,
): string | null {
  let cur: NavNodeDTO | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (!cur.parentId) return null;
    cur = index.get(cur.parentId);
    if (cur?.kind === kind) return cur.resourceId;
  }
  return null;
}

export interface Collection {
  /** 三类平铺条目（全部活实体）。 */
  entries: CollectableEntry[];
  byKind: Record<CollectableKind, CollectableEntry[]>;
}

export function buildCollection(tree: readonly NavNodeDTO[], menu: readonly MenuItemDTO[]): Collection {
  const index = new Map(tree.map((n) => [n.id, n]));
  const shortcuts = liveShortcutNodeIds(menu);
  const entries: CollectableEntry[] = [];
  for (const node of tree) {
    if (node.deletedAt) continue;
    if (!COLLECTABLE.has(node.kind)) continue;
    const parent = node.parentId ? index.get(node.parentId) : undefined;
    entries.push({
      kind: node.kind as CollectableKind,
      node,
      shortcuts: shortcuts.get(node.id) ?? [],
      kbResourceId: node.kind === "table" ? null : ancestorResource(index, node, "kb"),
      baseResourceId: node.kind === "table" ? ancestorResource(index, node, "base") : null,
      isRootDoc: node.kind === "doc" && parent?.kind === "kb",
    });
  }
  const byKind = {
    table: entries.filter((e) => e.kind === "table"),
    doc: entries.filter((e) => e.kind === "doc"),
    canvas: entries.filter((e) => e.kind === "canvas"),
  };
  return { entries, byKind };
}

export interface SelectOptions {
  kind?: CollectableKind;
  query?: string;
  /** 限定"已收纳到指定菜单容器"的引用（collected 视角配合使用）。 */
  containerMenuId?: string | null;
}

/** 某视角 + 类型/搜索/容器过滤下的条目。 */
export function selectEntries(
  collection: Collection,
  view: CollectionView,
  options: SelectOptions = {},
): CollectableEntry[] {
  let out = options.kind ? collection.byKind[options.kind] : collection.entries;
  out = out.filter((e) => {
    if (view === "collected" && e.shortcuts.length === 0) return false;
    if (view === "uncollected") {
      if (e.shortcuts.length > 0) return false;
      // C4 口径：嵌套 doc 不算"未收纳"（跟随父文档），未收纳列表只展示 table/canvas 与根级 doc
      if (e.kind === "doc" && !e.isRootDoc) return false;
    }
    if (options.containerMenuId !== undefined && options.containerMenuId !== null) {
      if (!e.shortcuts.some((s) => s.parentId === options.containerMenuId)) return false;
    }
    const q = options.query?.trim().toLowerCase();
    if (q && !e.node.name.toLowerCase().includes(q)) return false;
    return true;
  });
  return out;
}

/** "已收纳"视角下，指定菜单容器子树（含后代容器）引用的去重条目。 */
export function collectedUnderSubtree(
  collection: Collection,
  menu: readonly MenuItemDTO[],
  containerId: string | null,
): CollectableEntry[] {
  const subtree = new Set<string>();
  const walk = (id: string) => {
    subtree.add(id);
    for (const m of menu) if (m.parentId === id) walk(m.id);
  };
  if (containerId === null) {
    for (const m of menu) if (m.parentId === null) subtree.add(m.id);
  } else {
    walk(containerId);
  }
  return collection.entries.filter((e) => e.shortcuts.some((s) => subtree.has(s.parentId ?? "")));
}

/** 收集某 nav 节点（通常是 base/kb 容器节点）权威子树内的全部后代节点 id（不含自身）。 */
export function navSubtreeIds(tree: readonly NavNodeDTO[], rootId: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const n of tree) {
      if (n.parentId === pid) {
        out.add(n.id);
        walk(n.id);
      }
    }
  };
  walk(rootId);
  return out;
}

/** 未收纳计数（徽标用，C4 口径）。 */
export function uncollectedCount(collection: Collection): number {
  return collection.entries.filter((e) => {
    if (e.shortcuts.length > 0) return false;
    if (e.kind === "doc") return e.isRootDoc;
    return true;
  }).length;
}
