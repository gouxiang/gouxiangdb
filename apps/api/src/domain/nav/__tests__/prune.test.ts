// M4/S7 剪枝纯函数表驱动单测（裁决 A-6 边界，不连库不起 HTTP）。
// 覆盖：跨透明 group 的资源祖先门、子 direct 有权但父无权不出位置、空容器普通成员隐藏/
// 管理者 dimmed、菜单容器递归保留、shortcut 只看自身 r、面包屑根端孤立 group 截断。

import { describe, expect, it } from "vitest";
import {
  pruneTreeRows,
  pruneMenuRows,
  pruneBreadcrumb,
  buildGroupContentIndex,
  type PruneNode,
  type PruneIndex,
} from "../prune.js";

function node(id: string, kind: string, parentId: string | null, path: string, resourceType: string | null = null): PruneNode {
  return { id, parentId, kind, path, resourceType: resourceType ?? (kind === "group" ? null : kind) };
}

function index(visible: ReadonlySet<string>, allNodes: PruneNode[], manageAll = false): PruneIndex {
  return { visible, allNodes, manageAll };
}

describe("pruneTreeRows 资源祖先门（group 透明）", () => {
  // base(B) -> group(G) -> doc(D，direct 有权)：B 不在 visible。
  const B = node("B", "base", null, "/B/");
  const G = node("G", "group", "B", "/B/G/");
  const D = node("D", "doc", "G", "/B/G/D/");
  const idx = index(new Set(["D"]), [B, G, D]);

  it("父无权子 direct 有权：资源子节点与透明 group 均不保留（不造伪父链、不提升位）", () => {
    const kept = pruneTreeRows([B, G, D], idx);
    expect(kept.map((k) => k.row.id)).toEqual([]);
  });

  it("父子皆有权：资源保留，透明 group 因子树有可见内容保留且不 dimmed", () => {
    const ok = index(new Set(["B", "D"]), [B, G, D]);
    const kept = pruneTreeRows([B, G, D], ok);
    expect(kept.map((k) => k.row.id).sort()).toEqual(["B", "D", "G"]);
    expect(kept.find((k) => k.row.id === "G")?.dimmed).toBe(false);
  });

  it("空容器：普通成员隐藏；管理能力者保留且 dimmed:true", () => {
    const plain = pruneTreeRows([G], index(new Set(), [B, G], false));
    expect(plain).toEqual([]);
    const managed = pruneTreeRows([G], index(new Set(), [B, G], true));
    expect(managed.map((k) => k.row.id)).toEqual(["G"]);
    expect(managed[0]!.dimmed).toBe(true);
  });

  it("资源节点永不 dimmed（即便管理者视角保留）", () => {
    const ok = index(new Set(["B", "D"]), [B, G, D], true);
    const kept = pruneTreeRows([B, G, D], ok);
    for (const k of kept) {
      if (k.row.kind !== "group") expect(k.dimmed).toBe(false);
    }
  });
});

describe("pruneMenuRows shortcut 只看自身 r + 容器递归", () => {
  // C0(容器) -> S1(shortcut->可见 doc), S2(shortcut->不可见 doc)
  // C1(子容器) -> S3(可见)；S4(顶层不可见 shortcut)
  interface M { id: string; type: "container" | "shortcut"; parentId: string | null; nodeId: string | null }
  const menus: M[] = [
    { id: "c0", type: "container", parentId: null, nodeId: null },
    { id: "s1", type: "shortcut", parentId: "c0", nodeId: "D1" },
    { id: "s2", type: "shortcut", parentId: "c0", nodeId: "D2" },
    { id: "c1", type: "container", parentId: "c0", nodeId: null },
    { id: "s3", type: "shortcut", parentId: "c1", nodeId: "D3" },
    { id: "s4", type: "shortcut", parentId: null, nodeId: "D4" },
  ];
  const run = (visible: Set<string>, manageAll: boolean): Set<string> =>
    pruneMenuRows(
      menus,
      (m) => !!m.nodeId && visible.has(m.nodeId),
      (m) => m.type === "container",
      (m) => m.parentId,
      (m) => m.id,
      manageAll,
    );

  it("普通成员：可见 shortcut 与含可见 shortcut 的容器链保留；不可见 shortcut 与其空容器剔除", () => {
    const kept = run(new Set(["D1", "D3"]), false);
    expect([...kept].sort()).toEqual(["c0", "c1", "s1", "s3"]);
  });

  it("管理者：全部容器保留（含空容器），但 shortcut 仍按自身 r 剔除", () => {
    const kept = run(new Set(["D1"]), true);
    expect(kept.has("c0")).toBe(true);
    expect(kept.has("c1")).toBe(true);
    expect(kept.has("s1")).toBe(true);
    expect(kept.has("s2")).toBe(false); // shortcut 不享受 manageAll 放行
    expect(kept.has("s4")).toBe(false);
  });
});

describe("pruneBreadcrumb 中性截断", () => {
  // 叶->根序：D(doc) -> G(group) -> B(base)
  const B = node("B", "base", null, "/B/");
  const G = node("G", "group", "B", "/B/G/");
  const D = node("D", "doc", "G", "/B/G/D/");

  it("全可见：根->叶完整链，truncatedAbove=false", () => {
    const r = pruneBreadcrumb([D, G, B], new Set(["B", "D"]));
    expect(r.chain.map((n) => n.id)).toEqual(["B", "G", "D"]);
    expect(r.truncatedAbove).toBe(false);
  });

  it("D 可见、B 不可见：只保留 [D]，根端孤立透明 group G 一并裁掉，truncatedAbove=true", () => {
    const r = pruneBreadcrumb([D, G, B], new Set(["D"]));
    expect(r.chain.map((n) => n.id)).toEqual(["D"]);
    expect(r.truncatedAbove).toBe(true);
  });

});

describe("buildGroupContentIndex O(n) 一次遍历（S10 规模门前置，替代 O(g*n)）", () => {
  /**
   * 深层多组夹具：1 可见根 base；深度 D 的 group 链，每层 G_d 挂一个可见 doc V_d（祖先门通过）；
   * 另有一条从不可见根 H 起的同深链挂 doc W（visible 但祖先门不通过）。
   * 确定性构造，节点总数 = 1 + 3D + 1。
   */
  function build(depth: number): { nodes: PruneNode[]; visible: Set<string>; goodGroups: string[]; badGroups: string[] } {
    const nodes: PruneNode[] = [node("B", "base", null, "/B/")];
    const visible = new Set<string>(["B"]);
    const goodGroups: string[] = [];
    const badGroups: string[] = [];
    let prev = "B";
    let p = "/B/";
    for (let d = 1; d <= depth; d++) {
      const g = `G${d}`;
      const gp = `${p}${g}/`;
      nodes.push(node(g, "group", prev, gp));
      goodGroups.push(g);
      const v = `V${d}`;
      nodes.push(node(v, "doc", g, `${gp}${v}/`));
      visible.add(v); // doc 自身可见，且祖先 B 可见 -> 门通过
      prev = g;
      p = gp;
    }
    // 不可见资源根 H：其下 doc 虽在 visible 集，但资源祖先 H 不可见 -> 门不通过。
    nodes.push(node("H", "base", null, "/H/"));
    let hprev = "H";
    let hp = "/H/";
    for (let d = 1; d <= depth; d++) {
      const g = `HG${d}`;
      const gp = `${hp}${g}/`;
      nodes.push(node(g, "group", hprev, gp));
      badGroups.push(g);
      const w = `W${d}`;
      nodes.push(node(w, "doc", g, `${gp}${w}/`));
      visible.add(w); // 自身 visible，但 H 不可见 -> 整枝不判为可见内容
      hprev = g;
      hp = gp;
    }
    return { nodes, visible, goodGroups, badGroups };
  }

  it("scanned 恒等于活节点数（记忆化每节点恰好求值一次），不随 group 数二次增长", () => {
    const f10 = build(10);
    const idx10: PruneIndex = { visible: f10.visible, allNodes: f10.nodes, manageAll: false };
    const r10 = buildGroupContentIndex(idx10);
    expect(r10.scanned).toBe(f10.nodes.length);

    const f40 = build(40);
    const idx40: PruneIndex = { visible: f40.visible, allNodes: f40.nodes, manageAll: false };
    const r40 = buildGroupContentIndex(idx40);
    expect(r40.scanned).toBe(f40.nodes.length);
    // O(g*n) 旧法在 depth=40 会做约 g*n 次节点访问；线性断言远小于该量级。
    expect(r40.scanned).toBeLessThan(f40.nodes.length * 2);
  });

  it("深层多组：可见链上每层 group 保活；不可见根 H 整枝 group 不保活（语义零变化）", () => {
    const f = build(20);
    const idx: PruneIndex = { visible: f.visible, allNodes: f.nodes, manageAll: false };
    const { contentGroups } = buildGroupContentIndex(idx);
    for (const g of f.goodGroups) expect(contentGroups.has(g), g).toBe(true);
    for (const g of f.badGroups) expect(contentGroups.has(g), g).toBe(false);
    // 经 pruneTreeRows：普通成员只见 B + 好链 group/doc，不见 H 整枝（含 visible 但门不过的 W）。
    const kept = pruneTreeRows(f.nodes, idx).map((k) => k.row.id);
    expect(kept).toContain("B");
    expect(kept).not.toContain("H");
    expect(kept).not.toContain("W1");
    expect(kept).toContain("G20");
    expect(kept).not.toContain("HG1");
  });
});
