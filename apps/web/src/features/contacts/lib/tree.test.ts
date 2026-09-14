// M2/S7 通讯录纯函数单测：组树、展开拍平、子孙闭包、移动候选父/拦环、虚拟窗口。
import { describe, it, expect } from "vitest";
import {
  buildDeptTree,
  flattenVisible,
  descendantIds,
  movableParentCandidates,
  wouldFormCycle,
  virtualWindow,
  type DeptLike,
} from "./tree";

function dept(id: string, parentId: string | null, name = id, ord = 0): DeptLike {
  return { id, parentId, name, ord, memberCount: 0 };
}

// 6 层链：a > b > c > d > e > f，外加 a 的第二个子 g。
const SIX_LEVEL: DeptLike[] = [
  dept("a", null, "A"),
  dept("b", "a", "B"),
  dept("c", "b", "C"),
  dept("d", "c", "D"),
  dept("e", "d", "E"),
  dept("f", "e", "F"),
  dept("g", "a", "G"),
];

describe("buildDeptTree 平铺组树", () => {
  it("按 parentId 组为树，根在最外层", () => {
    const tree = buildDeptTree(SIX_LEVEL);
    expect(tree.map((n) => n.dept.id)).toEqual(["a"]);
    const a = tree[0]!;
    expect(a.children.map((n) => n.dept.id)).toEqual(["b", "g"]);
    // 链深度
    let node: (typeof tree)[number] | undefined = a;
    const chain: string[] = [];
    while (node) {
      chain.push(node.dept.id);
      node = node.children.find((n) => n.dept.id !== "g");
    }
    expect(chain).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("同父按 ord 升序排序", () => {
    const flat = [
      dept("x1", "r", "X1", 2),
      dept("r", null, "R", 0),
      dept("x0", "r", "X0", 0),
      dept("x2", "r", "X2", 1),
    ];
    const tree = buildDeptTree(flat);
    const r = tree.find((n) => n.dept.id === "r")!;
    expect(r.children.map((n) => n.dept.id)).toEqual(["x0", "x2", "x1"]);
  });

  it("parentId 指向缺失父（软删竞态）时按根挂出，不丢节点", () => {
    const flat = [dept("orphan", "missing", "孤儿"), dept("root", null, "根")];
    const tree = buildDeptTree(flat);
    expect(tree.map((n) => n.dept.id).sort()).toEqual(["orphan", "root"]);
  });
});

describe("flattenVisible 展开拍平带层级", () => {
  it("全展开时深度优先、depth 正确", () => {
    const tree = buildDeptTree(SIX_LEVEL);
    const all = new Set(SIX_LEVEL.map((d) => d.id));
    const rows = flattenVisible(tree, all);
    expect(rows.map((r) => r.dept.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    const depthOf = Object.fromEntries(rows.map((r) => [r.dept.id, r.depth]));
    expect(depthOf).toMatchObject({ a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 1 });
  });

  it("折叠某节点时其子树整体跳过", () => {
    const tree = buildDeptTree(SIX_LEVEL);
    // 只展开根 a：其直接子 b、g 出现；b 未展开 → b 的子树 c..f 整体跳过。
    const rows = flattenVisible(tree, new Set(["a"]));
    expect(rows.map((r) => r.dept.id)).toEqual(["a", "b", "g"]);
    // b 的层级为 1
    expect(rows.find((r) => r.dept.id === "b")!.depth).toBe(1);
  });
});

describe("descendantIds 子孙闭包", () => {
  it("不含自身时只取后代；含自身时加自身", () => {
    expect([...descendantIds(SIX_LEVEL, "a", false)].sort()).toEqual(
      ["b", "c", "d", "e", "f", "g"].sort(),
    );
    expect(descendantIds(SIX_LEVEL, "a", true).has("a")).toBe(true);
    expect([...descendantIds(SIX_LEVEL, "f", false)]).toEqual([]);
  });
});

describe("movableParentCandidates / wouldFormCycle 前端拦环", () => {
  it("移动 a 时候选父排除自身与其全部子孙（6 层下候选为空）", () => {
    // a 是所有节点的祖先：所有部门都在其自身或子孙闭包内
    expect(movableParentCandidates(SIX_LEVEL, "a").map((d) => d.id)).toEqual([]);
  });

  it("移动 c 时排除 c/d/e/f，保留 a/b/g", () => {
    expect(movableParentCandidates(SIX_LEVEL, "c").map((d) => d.id).sort()).toEqual(
      ["a", "b", "g"].sort(),
    );
  });

  it("移到自身或子孙判为成环，移到根/旁支合法", () => {
    expect(wouldFormCycle(SIX_LEVEL, "c", "c")).toBe(true);
    expect(wouldFormCycle(SIX_LEVEL, "c", "d")).toBe(true); // d 是 c 子孙
    expect(wouldFormCycle(SIX_LEVEL, "c", "f")).toBe(true);
    expect(wouldFormCycle(SIX_LEVEL, "c", "a")).toBe(false); // 移到祖先合法
    expect(wouldFormCycle(SIX_LEVEL, "c", null)).toBe(false); // 移到根
  });
});

describe("virtualWindow 定高行虚拟窗口", () => {
  it("顶部时从 0 起，含 overscan，总高=行数×行高", () => {
    const w = virtualWindow(0, 500, 40, 500, 8);
    expect(w.start).toBe(0);
    expect(w.end).toBe(Math.ceil(500 / 40) + 16);
    expect(w.padTop).toBe(0);
    expect(w.totalHeight).toBe(20000);
  });

  it("滚动后 start 前移并以 overscan 兜底，padTop 把首行推到正确位置", () => {
    const w = virtualWindow(1000, 500, 40, 500, 8);
    expect(w.start).toBe(Math.floor(1000 / 40) - 8); // 17
    expect(w.padTop).toBe(w.start * 40);
    expect(w.padBottom).toBe(w.totalHeight - w.end * 40);
    // 占位上下之和 + 窗口内行高 == 总高（滚动条不跳）
    expect(w.padTop + (w.end - w.start) * 40 + w.padBottom).toBe(20000);
  });

  it("空列表 / 非法行高返回全零窗口", () => {
    expect(virtualWindow(0, 500, 40, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
    expect(virtualWindow(0, 500, 0, 100).totalHeight).toBe(0);
  });

  it("滚到底部时 end 不超过总行数", () => {
    const w = virtualWindow(19600, 500, 40, 500, 8);
    expect(w.end).toBeLessThanOrEqual(500);
    expect(w.padBottom).toBe(0);
  });
});
