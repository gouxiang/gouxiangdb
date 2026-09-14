// M2/S3 部门物化路径纯函数单测（不碰数据库；deptTree 仅 type-only 引 DbTx）。
import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  selfPath,
  depthOfPath,
  isSelfOrDescendant,
  wouldCreateCycle,
  rewriteSubtreePath,
  validateDeptName,
  planSubtreeRewrite,
  type DeptPathRow,
} from "../deptTree.js";

describe("selfPath / depthOfPath", () => {
  it("根部门 path 首尾带斜杠；子部门接在父 path 后", () => {
    expect(selfPath(null, "a")).toBe("/a/");
    expect(selfPath("", "a")).toBe("/a/");
    expect(selfPath("/a/", "b")).toBe("/a/b/");
    expect(selfPath("/a/b/", "c")).toBe("/a/b/c/");
  });

  it("depth 数段", () => {
    expect(depthOfPath("/a/")).toBe(1);
    expect(depthOfPath("/a/b/")).toBe(2);
    expect(depthOfPath("/a/b/c/d/e/f/")).toBe(6);
  });
});

describe("isSelfOrDescendant / wouldCreateCycle", () => {
  it("自身与子孙前缀为真，平级/旁支为假", () => {
    expect(isSelfOrDescendant("/a/", "/a/")).toBe(true);
    expect(isSelfOrDescendant("/a/", "/a/b/")).toBe(true);
    expect(isSelfOrDescendant("/a/", "/a/b/c/")).toBe(true);
    expect(isSelfOrDescendant("/a/", "/b/")).toBe(false);
    // 前缀但不处于段边界（/ab/）不应误判：startsWith("/a/") 对 "/ab/" 为 false
    expect(isSelfOrDescendant("/a/", "/ab/")).toBe(false);
  });

  it("新父为自身或子孙 -> 成环；移到根或旁支不环", () => {
    expect(wouldCreateCycle("/a/", "/a/")).toBe(true);
    expect(wouldCreateCycle("/a/", "/a/b/")).toBe(true);
    expect(wouldCreateCycle("/a/b/", "/a/b/c/")).toBe(true);
    expect(wouldCreateCycle("/a/", null)).toBe(false);
    expect(wouldCreateCycle("/a/", "")).toBe(false);
    expect(wouldCreateCycle("/a/b/", "/x/")).toBe(false);
  });
});

describe("rewriteSubtreePath / planSubtreeRewrite", () => {
  it("移动子树后自身与全部后代 path 正确重写", () => {
    expect(rewriteSubtreePath("/a/", "/a/", "/x/a/")).toBe("/x/a/");
    expect(rewriteSubtreePath("/a/b/", "/a/", "/x/a/")).toBe("/x/a/b/");
    expect(rewriteSubtreePath("/a/b/c/", "/a/", "/x/a/")).toBe("/x/a/b/c/");
    // 移到根：去掉前缀层级
    expect(rewriteSubtreePath("/x/a/b/", "/x/a/", "/a/")).toBe("/a/b/");
  });

  function row(id: string, parentId: string | null, path: string): DeptPathRow {
    return { id, parentId, path };
  }

  it("plan 产出整棵子树（含自身）变更集且顺序稳定", () => {
    const subtree = [
      row("b", "a", "/a/b/"),
      row("a", null, "/a/"),
      row("c", "b", "/a/b/c/"),
    ];
    const plan = planSubtreeRewrite(subtree, "/a/", "/x/a/");
    expect(plan).toEqual([
      { id: "a", newPath: "/x/a/" },
      { id: "b", newPath: "/x/a/b/" },
      { id: "c", newPath: "/x/a/b/c/" },
    ]);
  });

  it("重写后深度超 32 -> 抛错", () => {
    const deep: DeptPathRow[] = [];
    const ids: string[] = [];
    for (let i = 0; i < MAX_DEPTH; i++) ids.push(`d${i}`);
    // 构造一棵本就在 32 层的链，把根下移 1 层即变 33。
    ids.forEach((id, i) => deep.push(row(id, i === 0 ? null : ids[i - 1], `/${ids.slice(0, i + 1).join("/")}/`)));
    expect(() => planSubtreeRewrite(deep, `/${ids[0]}/`, "/newparent/x/")).toThrow(/32/);
  });

  it("6 层链平移到另一根下，深度不变且在护栏内", () => {
    const ids = ["d1", "d2", "d3", "d4", "d5", "d6"];
    const chain = ids.map((id, i) => row(id, i === 0 ? null : ids[i - 1], `/${ids.slice(0, i + 1).join("/")}/`));
    const plan = planSubtreeRewrite(chain, "/d1/", "/root/d1/");
    expect(plan.at(-1)?.newPath).toBe("/root/d1/d2/d3/d4/d5/d6/");
    expect(depthOfPath(plan.at(-1)!.newPath)).toBe(7);
  });
});

describe("validateDeptName", () => {
  it("trim 后非空通过", () => {
    expect(validateDeptName("  研发部 ")).toBe("研发部");
  });
  it("非字符串/空/超长拒绝", () => {
    expect(() => validateDeptName(123)).toThrow();
    expect(() => validateDeptName("   ")).toThrow();
    expect(() => validateDeptName("")).toThrow();
    expect(() => validateDeptName("x".repeat(61))).toThrow(/60/);
    expect(validateDeptName("x".repeat(60))).toHaveLength(60);
  });
});
