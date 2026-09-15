import { describe, expect, it } from "vitest";
import type { MenuItemDTO } from "@gx/shared-types";
import {
  canMoveTo,
  diffMenu,
  draftItem,
  isSelfOrDescendant,
  moveItem,
  newDraftId,
  removeItem,
  type MenuDraft,
} from "./menu-ops";

function item(over: Partial<MenuItemDTO> & { id: string }): MenuItemDTO {
  const type = over.type ?? "shortcut";
  return {
    id: over.id,
    parentId: over.parentId ?? null,
    type,
    nodeId: over.nodeId ?? (type === "shortcut" ? `nav_${over.id}` : null),
    label: over.label ?? null,
    iconName: over.iconName ?? null,
    ord: over.ord ?? 0,
    node: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
  };
}

const c = (id: string, parentId: string | null = null, ord = 0) =>
  item({ id, type: "container", parentId, ord });
const s = (id: string, parentId: string | null = null, ord = 0, nodeId?: string) =>
  item({ id, type: "shortcut", parentId, ord, nodeId: nodeId ?? `nav_${id}` });

describe("isSelfOrDescendant", () => {
  const items = [c("root1"), c("a", "root1"), c("b", "a"), c("x", "root1")];
  it("自身判定为真", () => {
    expect(isSelfOrDescendant(items, "a", "a")).toBe(true);
  });
  it("后代判定为真", () => {
    expect(isSelfOrDescendant(items, "root1", "a")).toBe(true);
    expect(isSelfOrDescendant(items, "root1", "b")).toBe(true);
  });
  it("旁支与根层判定为假", () => {
    // 兄弟节点互不为祖先；a 挂到直接父 root1 下不成环（a 本就在其下）
    expect(isSelfOrDescendant(items, "a", "x")).toBe(false);
    expect(isSelfOrDescendant(items, "a", "root1")).toBe(false);
  });
  it("异常环不死循", () => {
    const cyclic = [c("p", "q"), c("q", "p")];
    expect(isSelfOrDescendant(cyclic, "p", "q")).toBe(true);
  });
});

describe("canMoveTo", () => {
  const items = [c("c1"), c("c2"), c("sub", "c1"), s("s1", "c1")];
  it("shortcut 不能作为父", () => {
    expect(canMoveTo(items, "s1", "s1")).toBe(false);
  });
  it("根层恒合法", () => {
    expect(canMoveTo(items, "c1", null)).toBe(true);
  });
  it("容器移入自身/后代被拦", () => {
    expect(canMoveTo(items, "c1", "c1")).toBe(false);
    expect(canMoveTo(items, "c1", "sub")).toBe(false);
  });
  it("shortcut 可跨任意容器（含同 nodeId 多处挂载）", () => {
    expect(canMoveTo(items, "s1", "c2")).toBe(true);
  });
  it("不存在目标拒绝", () => {
    expect(canMoveTo(items, "s1", "nope")).toBe(false);
  });
});

describe("moveItem", () => {
  it("同父内重排：a 从首位拖到 x 之后（index=2 拔出自身后的序列）", () => {
    const items = [c("c1"), s("a", "c1", 0), s("b", "c1", 1), s("x", "c1", 2)];
    // 拔出 a 后序列 [b,x]，index=2 表示落到末尾 x 之后
    const r = moveItem(items, "a", "c1", 2);
    expect(r.ok).toBe(true);
    const ordOf = (id: string) => r.items.find((i) => i.id === id)!.ord;
    expect([ordOf("b"), ordOf("x"), ordOf("a")]).toEqual([0, 1, 2]);
  });
  it("跨容器移动：旧父收紧 ord、新父重排", () => {
    const items = [c("c1"), c("c2"), s("a", "c1", 0), s("b", "c2", 0)];
    const r = moveItem(items, "a", "c2", 0);
    expect(r.ok).toBe(true);
    const moved = r.items.find((i) => i.id === "a")!;
    expect(moved.parentId).toBe("c2");
    expect(moved.ord).toBe(0);
    expect(r.items.find((i) => i.id === "b")!.ord).toBe(1);
  });
  it("成环拖拽被前端拦截且不修改数据", () => {
    const items = [c("c1"), c("sub", "c1")];
    const r = moveItem(items, "c1", "sub", 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cycle");
    expect(r.items).toEqual(items);
  });
  it("同位拖放返回 same-position", () => {
    const items = [c("c1"), s("a", "c1", 0), s("b", "c1", 1)];
    const r = moveItem(items, "a", "c1", 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("same-position");
  });
  it("不存在的菜单项返回 not-found", () => {
    const r = moveItem([c("c1")], "ghost", "c1", 0);
    expect(r).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("draftItem", () => {
  it("新 shortcut ord 接续同父兄弟数", () => {
    const items = [s("a", "c1", 0), s("b", "c1", 1)];
    const next = draftItem(items, { id: "d1", type: "shortcut", parentId: "c1", nodeId: "nav_x" });
    expect(next.at(-1)).toMatchObject({ id: "d1", parentId: "c1", ord: 2, nodeId: "nav_x" });
  });
});

describe("removeItem", () => {
  it("删容器 cascade：自身与全部后代移除", () => {
    const items = [c("c1"), c("sub", "c1"), s("a", "sub"), s("b", "c1"), s("keep", "c2"), c("c2")];
    const r = removeItem(items, "c1", "cascade");
    const ids = r.items.map((i) => i.id);
    expect(ids).toEqual(["keep", "c2"]);
    expect(r.descendantIds.sort()).toEqual(["a", "b", "sub"]);
  });
  it("删容器 move：直接子项改挂目标容器，孙级 parentId 链保留", () => {
    const items = [c("c1"), c("c2"), c("sub", "c1"), s("a", "sub"), s("b", "c1")];
    const r = removeItem(items, "c1", "move", "c2");
    const ids = r.items.map((i) => i.id);
    expect(ids).toContain("b");
    expect(r.items.find((i) => i.id === "sub")!.parentId).toBe("c2");
    // sub 是直接子容器被改挂；a 仍是 sub 子级
    expect(r.items.find((i) => i.id === "a")!.parentId).toBe("sub");
  });
  it("shortcut 删除只移除自身", () => {
    const items = [c("c1"), s("a", "c1"), s("b", "c1")];
    const r = removeItem(items, "a", "cascade");
    expect(r.items.map((i) => i.id)).toEqual(["c1", "b"]);
  });
});

describe("diffMenu", () => {
  it("空→空 无操作", () => {
    expect(diffMenu([], [])).toEqual([]);
  });
  it("新增 shortcut 生成 insert（带 nodeId/ord）", () => {
    const draft: MenuDraft[] = [s("d1", "c1", 0, "nav_t1")];
    const ops = diffMenu([], draft);
    expect(ops).toEqual([
      { op: "insert", id: "d1", type: "shortcut", parentId: "c1", nodeId: "nav_t1", label: null, iconName: null, ord: 0 },
    ]);
  });
  it("改别名生成单条 update", () => {
    const orig = [s("a", "c1", 0)];
    const draft = [{ ...s("a", "c1", 0), label: "别名" }];
    expect(diffMenu(orig, draft)).toEqual([
      { op: "update", id: "a", label: "别名", iconName: null },
    ]);
  });
  it("跨容器移动生成 reorder 带 parentId", () => {
    const orig = [c("c1"), c("c2"), s("a", "c1", 0)];
    const draft = [c("c1"), c("c2"), { ...s("a", "c2", 0) }];
    const ops = diffMenu(orig, draft);
    expect(ops).toContainEqual({ op: "reorder", id: "a", ord: 0, parentId: "c2" });
  });
  it("删除 shortcut 生成 delete；删容器时子孙不重复发 delete", () => {
    const orig = [c("c1"), c("sub", "c1"), s("a", "sub"), s("keep", "c2"), c("c2")];
    const draft = [s("keep", "c2"), c("c2")];
    const ops = diffMenu(orig, draft);
    expect(ops).toEqual([{ op: "delete", id: "c1" }]);
  });
  it("无变化草稿不产生任何操作", () => {
    const orig = [c("c1"), s("a", "c1", 0, "nav_t1")];
    expect(diffMenu(orig, orig)).toEqual([]);
  });
});

describe("newDraftId", () => {
  it("生成的 id 匹配后端白名单且带前缀", () => {
    const id = newDraftId("g");
    expect(id).toMatch(/^menu_draft_g_[a-z0-9]+$/);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
