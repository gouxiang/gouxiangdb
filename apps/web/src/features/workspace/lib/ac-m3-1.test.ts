// M3/S10 AC-M3-1 web 侧自动化对抗（纯函数层；后端 8 条对抗在 apps/api routes/v1，
// 本文件不碰 apps/api）。覆盖派单五项：
//   1. 同一实体多处挂载：菜单编排 diff 只动 menu_items 引用，语义层不含任何 nav 实体写
//   2. C1S 软删：活引用→soft_dangling 立即从浏览/收纳集合消失；源恢复（state 回 alive）自动重现
//   3. broken：浏览态隐藏、编排态保留显灰（可清理），draft 保留软删引用不产生误 delete
//   4. 三分区集合随 menu patch（insert/delete/移动容器）正确迁移
//   5. MoveImpactModal 409 MOVE_NEEDS_CONFIRM 前端处理（extractMoveImpact 窄化）
import { describe, expect, it } from "vitest";
import type { MenuItemDTO, MenuNodeSummaryDTO, NavNodeDTO } from "@gx/shared-types";
import {
  buildCollection,
  collectedUnderSubtree,
  liveShortcutNodeIds,
  selectEntries,
  uncollectedCount,
} from "./collection";
import {
  composerItemState,
  filterBrowsableItems,
  filterComposerItems,
  isBrowsableShortcut,
  isComposerVisible,
} from "./menu-tree";
import { diffMenu, draftItem, moveItem, removeItem } from "./menu-ops";
import { extractMoveImpact } from "../nav-hooks";
import { ApiError } from "../../../api/client";

// ---------- 夹具 ----------

let seq = 0;
function n(over: Partial<NavNodeDTO> & { id: string; kind: NavNodeDTO["kind"] }): NavNodeDTO {
  seq += 1;
  return {
    workspaceId: "ws",
    parentId: null,
    resourceType: over.kind === "group" ? null : over.kind,
    resourceId: `res_${over.id}`,
    name: over.name ?? over.id,
    ord: over.ord ?? seq,
    path: `/${over.id}/`,
    depth: over.depth ?? 2,
    isSystem: false,
    iconName: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
    ...over,
  };
}

function summary(id: string, state: MenuNodeSummaryDTO["state"] = "alive", kind: MenuNodeSummaryDTO["kind"] = "table"): MenuNodeSummaryDTO {
  return { id, kind: state === "broken" ? null : kind, name: `name_${id}`, iconName: null, resourceType: kind, resourceId: `res_${id}`, state };
}

function shortcut(id: string, nodeId: string, parentId: string | null, state: MenuNodeSummaryDTO["state"] = "alive", kind: MenuNodeSummaryDTO["kind"] = "table", ord = 0): MenuItemDTO {
  return {
    id, parentId, type: "shortcut", nodeId, label: null, iconName: null, ord,
    node: summary(nodeId, state, kind),
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: null, deletedAt: null,
  };
}
function container(id: string, parentId: string | null = null, ord = 0): MenuItemDTO {
  return {
    id, parentId, type: "container", nodeId: null, label: id, iconName: null, ord,
    node: null, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: null, deletedAt: null,
  };
}
/** 模拟服务端在源软删/恢复后重新下发的同 id 菜单项（只改 node.state）。 */
function withState(item: MenuItemDTO, state: MenuNodeSummaryDTO["state"]): MenuItemDTO {
  return { ...item, node: item.node ? { ...item.node, state } : item.node };
}

// ---------- 对抗 1：多处挂载只改菜单引用，零实体写语义 ----------

describe("AC-M3-1#1 同一实体多处挂载：编排 diff 只含 menu_items 引用操作", () => {
  const tree = [
    n({ id: "base1", kind: "base", depth: 1 }),
    n({ id: "kb1", kind: "kb", depth: 1 }),
    n({ id: "tblA", kind: "table", parentId: "base1", depth: 2 }),
  ];
  const original = [
    container("c_base"),
    container("c_kb"),
    shortcut("m1", "tblA", "c_base"),
  ];

  it("同一 table 被加到 3 个容器：diff 只有 2 条 insert，nodeId 恒为同一实体，无实体操作字段", () => {
    let draft = original.map((i) => ({ ...i }));
    draft = draftItem(draft, { id: "d1", type: "shortcut", parentId: "c_kb", nodeId: "tblA", node: summary("tblA") });
    draft = draftItem(draft, { id: "d2", type: "shortcut", parentId: "c_kb", nodeId: "tblA", node: summary("tblA") });
    const ops = diffMenu(original, draft);
    expect(ops.map((o) => o.op)).toEqual(["insert", "insert"]);
    for (const op of ops) {
      // type 字段仅在 insert 分支上，先窄化再断言（reorder/update/delete 无 type）
      expect("type" in op && op.type).toBe("shortcut");
      expect("nodeId" in op && op.nodeId).toBe("tblA");
      // MenuOp 联合里不存在任何 nav 实体写字段（防把权威移动混进菜单 PATCH）
      expect("newParentId" in op).toBe(false);
      expect("confirmed" in op).toBe(false);
      expect("resourceId" in op).toBe(false);
    }
    // 权威树输入未被任何编排操作修改（实体归属不变的纯函数侧证据）
    expect(tree.find((x) => x.id === "tblA")!.parentId).toBe("base1");
  });

  it("各容器内拖拽排序/删除快捷项后，实体 parentId 不变，diff 仅 reorder/delete 菜单行", () => {
    let draft = original.map((i) => ({ ...i }));
    // 把 m1 从 c_base 拖到 c_kb（跨容器菜单移动，非权威移动）
    const moved = moveItem(draft, "m1", "c_kb", 9999);
    expect(moved.ok).toBe(true);
    draft = moved.items;
    const ops1 = diffMenu(original, draft);
    expect(ops1).toHaveLength(1);
    expect(ops1[0]!.op).toBe("reorder");
    expect(ops1[0]).toHaveProperty("parentId", "c_kb");
    expect("newParentId" in ops1[0]!).toBe(false);

    // 删除其中一处引用
    const removed = removeItem(draft, "m1", "cascade");
    const ops2 = diffMenu(original, removed.items);
    expect(ops2.map((o) => o.op)).toEqual(["delete"]);
    expect(ops2[0]!).toHaveProperty("id", "m1");
    // 实体仍然挂在 base1 下，GET table 的归属不受影响
    expect(tree.find((x) => x.id === "tblA")!.parentId).toBe("base1");
  });
});

// ---------- 对抗 2：C1S 软删隐藏 + 恢复自动还原 ----------

describe("AC-M3-1#2 源软删（soft_dangling）引用立即隐藏，恢复后自动重现，draft 不误删", () => {
  const tree = [
    n({ id: "base1", kind: "base", depth: 1 }),
    n({ id: "tblA", kind: "table", parentId: "base1", depth: 2 }),
  ];
  const menuAlive = [container("c1"), shortcut("m1", "tblA", "c1")];

  it("软删后：浏览树剔除、收纳集合清空、未收纳计数 +1（warning 非阻断）", () => {
    const menuSoft = [withState(menuAlive[1]!, "soft_dangling")];
    // 浏览态
    expect(isBrowsableShortcut(menuSoft[0]!)).toBe(false);
    expect(filterBrowsableItems(menuSoft).some((i) => i.id === "m1")).toBe(false);
    // 三分区
    const coll = buildCollection(tree, menuSoft);
    expect(selectEntries(coll, "collected")).toHaveLength(0);
    expect(selectEntries(coll, "uncollected").map((e) => e.node.id)).toEqual(["tblA"]);
    expect(uncollectedCount(coll)).toBe(1);
    // 活引用索引不含软删引用
    expect(liveShortcutNodeIds(menuSoft).has("tblA")).toBe(false);
  });

  it("恢复（state 回 alive）后：引用自动重新出现，无需任何菜单写操作", () => {
    const menuRestored = [container("c1"), withState(menuAlive[1]!, "alive")];
    expect(isBrowsableShortcut(menuRestored[1]!)).toBe(true);
    const coll = buildCollection(tree, menuRestored);
    expect(selectEntries(coll, "collected").map((e) => e.node.id)).toEqual(["tblA"]);
    expect(uncollectedCount(coll)).toBe(0);
    // 关键：恢复前后菜单项 id/parentId/ord 完全一致，diff 必须为空——引用是保留而非重建
    const ops = diffMenu(menuSoftStable(), menuRestored);
    expect(ops).toEqual([]);
  });

  it("编排态视图隐藏软删引用，但 draft 保留原行——不编辑直接保存 diff 为空（不误删，源恢复自动还原）", () => {
    const menuSoft = [container("c1"), withState(menuAlive[1]!, "soft_dangling")];
    // 视图层：编排树不渲染软删行（ADR-0029 定稿：soft_dangling 与浏览态一致全员隐藏）
    expect(isComposerVisible(menuSoft[1]!)).toBe(false);
    expect(filterComposerItems(menuSoft).map((i) => i.id)).toEqual(["c1"]);
    // 数据层：NavComposer 的 draft 对齐是 menu.items 全量镜像（不过滤），保存 diff 为空
    const draft = menuSoft.map((i) => ({ ...i }));
    expect(diffMenu(menuSoft, draft)).toEqual([]);
  });

  // 恢复场景的“软删前稳定菜单”（与 menuAlive 同形，独立构造避免数组引用干扰）
  function menuSoftStable(): MenuItemDTO[] {
    return [container("c1"), shortcut("m1", "tblA", "c1")];
  }
});

// ---------- 对抗 3：broken 浏览隐藏、编排显灰可清理 ----------

describe("AC-M3-1#3 broken（物理消失）：浏览隐藏、编排保留显灰，仅手动清理才 delete", () => {
  const brokenItem = shortcut("m1", "ghost", "c1", "broken");

  it("浏览态不可见；编排态可见且状态判为 broken", () => {
    expect(isBrowsableShortcut(brokenItem)).toBe(false);
    expect(isComposerVisible(brokenItem)).toBe(true);
    expect(composerItemState(brokenItem)).toBe("broken");
  });

  it("node 摘要缺失（shortcut node=null，物理消失断裂）判 broken：浏览隐藏、编排显灰保留可清理", () => {
    const noSummary: MenuItemDTO = { ...shortcut("m2", "ghost2", "c1"), node: null };
    expect(isBrowsableShortcut(noSummary)).toBe(false);
    expect(composerItemState(noSummary)).toBe("broken");
    // 定稿 menu-tree.ts:68：node=null 的 broken 引用编排态保留（显灰可清理），不静默丢失
    expect(isComposerVisible(noSummary)).toBe(true);
    expect(filterComposerItems([container("c1"), noSummary]).map((i) => i.id)).toEqual(["c1", "m2"]);
  });

  it("容器菜单项 node 恒 null 仍判 alive（S9 真机回归：不显示已失效）", () => {
    expect(composerItemState(container("c1"))).toBe("alive");
    expect(isBrowsableShortcut(container("c1"))).toBe(true);
  });

  it("手动清理 broken 引用才产生 delete；不清理直接保存 diff 为空", () => {
    const menu = [container("c1"), brokenItem];
    expect(diffMenu(menu, menu.map((i) => ({ ...i })))).toEqual([]);
    const after = removeItem(menu, "m1", "cascade");
    const ops = diffMenu(menu, after.items);
    expect(ops).toEqual([{ op: "delete", id: "m1" }]);
  });
});

// ---------- 对抗 4：三分区集合随 menu patch 迁移 ----------

describe("AC-M3-1#4 三分区集合随菜单 insert/delete/容器移动正确迁移", () => {
  const tree = [
    n({ id: "base1", kind: "base", depth: 1 }),
    n({ id: "t1", kind: "table", parentId: "base1", depth: 2 }),
    n({ id: "t2", kind: "table", parentId: "base1", depth: 2 }),
    n({ id: "t3", kind: "table", parentId: "base1", depth: 2 }),
  ];

  it("insert：未收纳→已收纳，计数与两视角同步迁移", () => {
    const before = buildCollection(tree, [container("c1")]);
    expect(uncollectedCount(before)).toBe(3);
    const after = buildCollection(tree, [container("c1"), shortcut("m1", "t1", "c1", "alive", "table")]);
    expect(selectEntries(after, "uncollected").map((e) => e.node.id).sort()).toEqual(["t2", "t3"]);
    expect(selectEntries(after, "collected").map((e) => e.node.id)).toEqual(["t1"]);
    expect(uncollectedCount(after)).toBe(2);
  });

  it("delete：已收纳退回未收纳（实体仍在全部视角与权威树中）", () => {
    const withMenu = buildCollection(tree, [container("c1"), shortcut("m1", "t1", "c1", "alive", "table")]);
    const after = buildCollection(tree, [container("c1")]);
    expect(selectEntries(withMenu, "collected").map((e) => e.node.id)).toEqual(["t1"]);
    expect(selectEntries(after, "collected")).toHaveLength(0);
    expect(selectEntries(after, "all").map((e) => e.node.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("同一实体多处挂载时，删一处引用仍算已收纳（另一处存活）；全删才退未收纳", () => {
    const two = buildCollection(tree, [
      container("c1"), container("c2"),
      shortcut("m1", "t1", "c1", "alive", "table"),
      shortcut("m2", "t1", "c2", "alive", "table"),
    ]);
    expect(selectEntries(two, "collected").map((e) => e.node.id)).toEqual(["t1"]);
    const one = buildCollection(tree, [
      container("c1"), container("c2"),
      shortcut("m2", "t1", "c2", "alive", "table"),
    ]);
    expect(selectEntries(one, "collected").map((e) => e.node.id)).toEqual(["t1"]);
    expect(collectedUnderSubtree(one, [
      container("c1"), container("c2"), shortcut("m2", "t1", "c2", "alive", "table"),
    ], "c1")).toHaveLength(0);
  });

  it("容器子树收集随引用挂到后代容器一并迁移", () => {
    const menu = [
      container("root"),
      container("sub", "root"),
      shortcut("m1", "t1", "sub", "alive", "table"),
    ];
    const coll = buildCollection(tree, menu);
    expect(collectedUnderSubtree(coll, menu, "root").map((e) => e.node.id)).toEqual(["t1"]);
    expect(collectedUnderSubtree(coll, menu, "sub").map((e) => e.node.id)).toEqual(["t1"]);
  });
});

// ---------- 对抗 5：409 MOVE_NEEDS_CONFIRM 前端处理 ----------

/**
 * 构造带 code/impact 的错误信封：ApiError.body 的公共类型只声明 error/message/details，
 * 但后端 409 实际同体携带 code/impact（extractMoveImpact 据此窄化）。测试按运行时形态构造，
 * 不放宽 client.ts 的生产类型。
 */
function apiError(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError(status, body as ConstructorParameters<typeof ApiError>[1]);
}

describe("AC-M3-1#5 extractMoveImpact：只认 409 + MOVE_NEEDS_CONFIRM + impact 体", () => {
  const impact = {
    nodeId: "nav_doc_1",
    newParentId: "navgrp_1",
    subtreeItemCount: 2,
    affectedUserCount: 1,
    shortcutCount: 2,
    willBreakInheritanceHint: false,
  };

  it("409 确认型错误返回 impact（供 MoveImpactModal 渲染三行计数）", () => {
    const e = apiError(409, { error: "移动需确认影响面后执行", code: "MOVE_NEEDS_CONFIRM", impact });
    expect(extractMoveImpact(e)).toEqual(impact);
  });

  it("409 但 code 不匹配（如 NAV_NODE_IN_USE）返回 null，走普通错误 toast", () => {
    const e = apiError(409, { error: "分组被引用", code: "NAV_NODE_IN_USE" });
    expect(extractMoveImpact(e)).toBeNull();
  });

  it("409 code 匹配但缺 impact 体返回 null（防御畸形响应）", () => {
    const e = apiError(409, { error: "移动需确认影响面后执行", code: "MOVE_NEEDS_CONFIRM" });
    expect(extractMoveImpact(e)).toBeNull();
  });

  it("非 409（403/500/网络错误）一律返回 null", () => {
    expect(extractMoveImpact(apiError(403, { error: "禁止", code: "FORBIDDEN" }))).toBeNull();
    expect(extractMoveImpact(apiError(500, { error: "服务器内部错误", code: "INTERNAL" }))).toBeNull();
    expect(extractMoveImpact(new TypeError("network down"))).toBeNull();
    expect(extractMoveImpact(null)).toBeNull();
  });
});
