// M4/S7 剪枝纯函数表驱动单测（裁决 A-6 边界，不连库不起 HTTP）。
// 覆盖：跨透明 group 的资源祖先门、子 direct 有权但父无权不出位置、空容器普通成员隐藏/
// 管理者 dimmed、菜单容器递归保留、shortcut 只看自身 r、面包屑根端孤立 group 截断。

import { describe, expect, it } from "vitest";
import { pruneTreeRows, pruneMenuRows, pruneBreadcrumb, type PruneNode, type PruneIndex } from "../prune.js";

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
