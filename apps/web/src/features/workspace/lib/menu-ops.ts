// M3/S9 菜单编排纯函数层：本地 draft 编辑 + 提交时 diff 成 MenuOp[] 整单事务。
//
// 边界（ADR-0026 菜单引用层）：这里所有操作只动 menu_items 引用（增删改排/跨容器/多处
// 挂载），绝不触碰 nav_nodes.parentId——权威移动走 /nodes/:id/move + move-impact（见
// useMoveNode）。拖到"分组(group)"实体节点是权威移动，不经过本模块。
//
// 防环两道防线的第一道在此（后端 menu.ts 再拦一次并 400 NAV_CYCLE）：
// 容器不能拖到自身或自己的后代容器下。

import type { MenuItemDTO, MenuNodeSummaryDTO, MenuOp } from "@gx/shared-types";

/** 可编辑草稿：与 MenuItemDTO 同形（新增项用 menu_draft_ 前缀合法 id，匹配后端 ^[A-Za-z0-9_-]{1,64}$）。 */
export type MenuDraft = MenuItemDTO;

export interface MoveResult {
  items: MenuDraft[];
  ok: boolean;
  /** 非法拖拽（成环/目标不存在）时给出原因，UI 不做任何状态变更。 */
  reason?: "cycle" | "not-found" | "same-position";
}

/** 沿 parentId 链判断 ancestorId 是否为 nodeId 自身或其后代（挂下去即成环）。 */
export function isSelfOrDescendant(
  items: readonly MenuDraft[],
  nodeId: string,
  ancestorCandidateId: string,
): boolean {
  if (nodeId === ancestorCandidateId) return true;
  const byId = new Map(items.map((i) => [i.id, i]));
  let cur = byId.get(ancestorCandidateId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === nodeId) return true;
    if (!cur.parentId) return false;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/**
 * 拖拽可行性：
 *  - 只有 container 能成为父（shortcut 不能挂子项）；根层 parentId=null 恒合法；
 *  - 容器不能移入自身/后代；
 *  - shortcut 可任意跨容器/多处容器（同 nodeId 多条 shortcut 是合法多处挂载，不受限）。
 */
export function canMoveTo(items: readonly MenuDraft[], itemId: string, newParentId: string | null): boolean {
  const item = items.find((i) => i.id === itemId);
  if (!item) return false;
  if (newParentId !== null) {
    const target = items.find((i) => i.id === newParentId);
    if (!target || target.type !== "container") return false;
  }
  if (item.type === "container" && isSelfOrDescendant(items, itemId, newParentId ?? "")) {
    // newParentId=null（根层）时 "" 不匹配任何链，恒安全。
    if (newParentId !== null) return false;
  }
  return true;
}

/** 同父下按 ord 升序、同 ord 按 id 兜底的稳定排序（与 menu-tree.itemSorter 同源口径）。 */
function siblingsInOrder(items: readonly MenuDraft[], parentId: string | null): MenuDraft[] {
  return items
    .filter((i) => i.parentId === parentId)
    .slice()
    .sort((a, b) => (a.ord !== b.ord ? a.ord - b.ord : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 把 itemId 移动到 newParentId 容器（null=根层），index 为目标同父序列中的插入位置。
 * 仅重算受影响两个容器的 ord（0..n 连续），其它项不动。
 */
export function moveItem(
  items: readonly MenuDraft[],
  itemId: string,
  newParentId: string | null,
  index: number,
): MoveResult {
  const item = items.find((i) => i.id === itemId);
  if (!item) return { items: items.slice(), ok: false, reason: "not-found" };
  if (!canMoveTo(items, itemId, newParentId)) return { items: items.slice(), ok: false, reason: "cycle" };
  const oldParentId = item.parentId;
  const beforeOrder = siblingsInOrder(items, oldParentId).map((i) => i.id);

  const next = items.map((i) => ({ ...i }));
  const moving = next.find((i) => i.id === itemId)!;
  moving.parentId = newParentId;

  const applyOrder = (parentId: string | null) => {
    const siblings = siblingsInOrder(next, parentId).filter((i) => i.id !== itemId);
    const clamped = Math.max(0, Math.min(index, siblings.length));
    siblings.splice(clamped, 0, moving);
    siblings.forEach((i, idx) => {
      i.ord = idx;
    });
    return siblings.map((i) => i.id);
  };

  if (oldParentId !== newParentId) {
    // 旧父收紧（moving 已因改 parentId 拔出)，新父按 index 插入
    siblingsInOrder(next, oldParentId).forEach((i, idx) => {
      i.ord = idx;
    });
    applyOrder(newParentId);
    return { items: next, ok: true };
  }

  const afterOrder = applyOrder(newParentId);
  if (beforeOrder.join("|") === afterOrder.join("|")) {
    return { items: items.slice(), ok: false, reason: "same-position" };
  }
  return { items: next, ok: true };
}

/** 新建草稿菜单项（不入后端，提交时随 insert 落库）。
 *  node 为本地临时摘要（用于保存前的名称/图标/悬挂态渲染）；diff 不比较 node，
 *  保存成功后以服务端回填的 menu 对齐，临时摘要自然消失。 */
export function draftItem(
  items: readonly MenuDraft[],
  init: {
    id: string;
    type: "container" | "shortcut";
    parentId?: string | null;
    nodeId?: string | null;
    label?: string | null;
    node?: MenuNodeSummaryDTO | null;
  },
): MenuDraft[] {
  const parentId = init.parentId ?? null;
  const ord = items.filter((i) => i.parentId === parentId).length;
  const now = "draft";
  const row: MenuDraft = {
    id: init.id,
    parentId,
    type: init.type,
    nodeId: init.nodeId ?? null,
    label: init.label ?? null,
    iconName: null,
    ord,
    node: init.node ?? null,
    createdAt: now,
    updatedAt: null,
    deletedAt: null,
  };
  return [...items, row];
}

/** 从 draft 中移除一项；删容器时按策略处理后代。 */
export interface RemoveResult {
  items: MenuDraft[];
  /** strategy=cascade 时被连带移除的后代 id（后端对容器 delete 自动级联，diff 不再逐个子发 delete）。 */
  descendantIds: string[];
}

export function removeItem(
  items: readonly MenuDraft[],
  itemId: string,
  strategy: "cascade" | "move",
  targetParentId?: string | null,
): RemoveResult {
  const byId = new Map(items.map((i) => [i.id, i]));
  const collectDescendants = (id: string): string[] => {
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const i of items) {
        if (i.parentId === pid) {
          out.push(i.id);
          walk(i.id);
        }
      }
    };
    walk(id);
    return out;
  };

  const item = byId.get(itemId);
  if (!item) return { items: items.slice(), descendantIds: [] };

  if (item.type === "shortcut" || strategy === "cascade") {
    const victims = new Set([itemId, ...(item.type === "container" ? collectDescendants(itemId) : [])]);
    return { items: items.filter((i) => !victims.has(i.id)), descendantIds: [...victims].slice(1) };
  }

  // strategy=move：容器删除，全部直接子项改挂 targetParentId（后端 deleteGroup 语义），
  // 孙级保留在各自父（若父是被移动的直接子容器，则随其在菜单层整体改挂，parentId 仍连续）。
  // 菜单删除只支持 menu_items 层；group 实体删除走 NavApi.deleteGroup，不在此函数。
  const target = targetParentId ?? null;
  if (target !== null && !items.some((i) => i.id === target && i.type === "container")) {
    return { items: items.slice(), descendantIds: [] };
  }
  const next = items
    .filter((i) => i.id !== itemId)
    .map((i) => (i.parentId === itemId ? { ...i, parentId: target } : i));
  // 重排目标容器
  const renumbered = next.map((i) => ({ ...i }));
  renumbered
    .filter((i) => i.parentId === target)
    .sort((a, b) => (a.ord !== b.ord ? a.ord - b.ord : a.id < b.id ? -1 : 1))
    .forEach((i, idx) => {
      i.ord = idx;
    });
  return { items: renumbered, descendantIds: [] };
}

/**
 * 原始菜单 → 编辑后草稿的最小操作集 diff。
 *  - draft 新增（id 不在 original）→ insert（shortcut 带 nodeId，container 不带）
 *  - label/iconName 变化 → update
 *  - parentId/ord 变化 → reorder（跨父带 parentId）
 *  - original 活项在 draft 消失 → delete（容器级联由后端处理，只发容器自身一条）
 * 不输出无变化操作；draft 中被级联消失的后代不再单独发 delete（后端随容器一并软删）。
 */
export function diffMenu(original: readonly MenuItemDTO[], draft: readonly MenuDraft[]): MenuOp[] {
  const ops: MenuOp[] = [];
  const origById = new Map(original.map((i) => [i.id, i]));
  const draftById = new Map(draft.map((i) => [i.id, i]));

  for (const d of draft) {
    const o = origById.get(d.id);
    if (!o) {
      ops.push({
        op: "insert",
        id: d.id,
        type: d.type,
        parentId: d.parentId,
        // nodeId 契约为 string?（shortcut 必填活节点，container 省略字段而非 null）
        ...(d.type === "shortcut" && d.nodeId ? { nodeId: d.nodeId } : {}),
        label: d.label,
        iconName: d.iconName,
        ord: d.ord,
      });
      continue;
    }
    if (o.parentId !== d.parentId || o.ord !== d.ord) {
      ops.push({ op: "reorder", id: d.id, ord: d.ord, ...(o.parentId !== d.parentId ? { parentId: d.parentId } : {}) });
    }
    if ((o.label ?? null) !== (d.label ?? null) || (o.iconName ?? null) !== (d.iconName ?? null)) {
      ops.push({ op: "update", id: d.id, label: d.label, iconName: d.iconName });
    }
  }

  // 删除：draft 中消失的项。若父容器也被删，则跳过子项（容器 delete 后端级联）。
  const deleted = new Set<string>();
  for (const o of original) {
    if (!draftById.has(o.id)) deleted.add(o.id);
  }
  for (const id of deleted) {
    const o = origById.get(id)!;
    if (o.parentId && deleted.has(o.parentId)) continue;
    ops.push({ op: "delete", id });
  }
  return ops;
}

/** 前端生成合法 draft 新 id（后端白名单 ^[A-Za-z0-9_-]{1,64}$）。 */
export function newDraftId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `menu_draft_${prefix}_${rand}`;
}
