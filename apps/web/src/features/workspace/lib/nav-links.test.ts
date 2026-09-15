// M3/S8 shortcut → 既有内容 URL 解析纯函数 characterization。
// 铁律（ADR-0028/裁决 2）：只解析回 /base/..、/kb/.. 旧形，永不引 /w/node。
import { describe, it, expect } from "vitest";
import type { NavNodeDTO } from "@gx/shared-types";
import { findAncestorOfKind, indexNavNodes, navNodeHref, resourceHref } from "./nav-links";

let seq = 0;
function node(over: Partial<NavNodeDTO> & { id: string; kind: NavNodeDTO["kind"] }): NavNodeDTO {
  seq++;
  return {
    workspaceId: "ws_default",
    parentId: over.parentId ?? null,
    resourceType: over.resourceType ?? (over.kind === "group" ? null : over.kind),
    resourceId: over.resourceId ?? (over.kind === "group" ? null : over.id),
    name: over.name ?? over.id,
    ord: over.ord ?? seq,
    path: over.path ?? `/${over.id}/`,
    depth: over.depth ?? 0,
    isSystem: false,
    iconName: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
    ...over,
  };
}

function baseTree() {
  // base_b → table_t → view_v；kb_k → doc_d / canvas_can（doc 挂父文档 dp 场景）
  const items = [
    node({ id: "b", kind: "base", resourceId: "B1" }),
    node({ id: "t", kind: "table", parentId: "b", resourceId: "T1" }),
    node({ id: "v", kind: "view", parentId: "t", resourceId: "V1" }),
    node({ id: "k", kind: "kb", resourceId: "K1" }),
    node({ id: "dp", kind: "doc", parentId: "k", resourceId: "D0" }),
    node({ id: "d", kind: "doc", parentId: "dp", resourceId: "D1" }),
    node({ id: "can", kind: "canvas", parentId: "k", resourceId: "C1" }),
    node({ id: "g", kind: "group", parentId: "b", resourceType: null, resourceId: null }),
  ];
  return { index: indexNavNodes(items), items };
}

describe("navNodeHref：只解析回既有旧形 URL", () => {
  it("base → /base/:id；kb → /kb/:id", () => {
    const { index } = baseTree();
    expect(navNodeHref(index, index.byId.get("b")!)).toBe("/base/B1");
    expect(navNodeHref(index, index.byId.get("k")!)).toBe("/kb/K1");
  });

  it("table 沿 parentId 找 base 祖先拼 /base/:base/table/:table", () => {
    const { index } = baseTree();
    expect(navNodeHref(index, index.byId.get("t")!)).toBe("/base/B1/table/T1");
  });

  it("doc 嵌套在父文档下仍向上找到 kb 祖先；canvas 同构", () => {
    const { index } = baseTree();
    expect(navNodeHref(index, index.byId.get("d")!)).toBe("/kb/K1/doc/D1");
    expect(navNodeHref(index, index.byId.get("can")!)).toBe("/kb/K1/canvas/C1");
  });

  it("view 与 group 不可导航（返回 null），不生成新协议 URL", () => {
    const { index } = baseTree();
    expect(navNodeHref(index, index.byId.get("v")!)).toBeNull();
    expect(navNodeHref(index, index.byId.get("g")!)).toBeNull();
  });

  it("祖先缺失（脏数据/未收纳树片段）安全返回 null，不拼出 /base/undefined", () => {
    const orphan = indexNavNodes([node({ id: "t", kind: "table", parentId: "ghost", resourceId: "T9" })]);
    expect(navNodeHref(orphan, orphan.byId.get("t")!)).toBeNull();
  });

  it("异常环不死循环（32 深度护栏的前端侧），返回 null", () => {
    const a = node({ id: "a", kind: "doc", parentId: "b", resourceId: "DA" });
    const b = node({ id: "b", kind: "doc", parentId: "a", resourceId: "DB" });
    const idx = indexNavNodes([a, b]);
    expect(findAncestorOfKind(idx, a, "kb")).toBeNull();
  });
});

describe("resourceHref / byResource 索引", () => {
  it("按 resourceType:resourceId 解析快捷方式", () => {
    const { index } = baseTree();
    expect(resourceHref(index, "table", "T1")).toBe("/base/B1/table/T1");
    expect(resourceHref(index, "canvas", "C1")).toBe("/kb/K1/canvas/C1");
  });

  it("未知资源/空入参返回 null", () => {
    const { index } = baseTree();
    expect(resourceHref(index, "table", "NOPE")).toBeNull();
    expect(resourceHref(index, null, "x")).toBeNull();
    expect(resourceHref(index, "table", null)).toBeNull();
  });

  it("group 不进 byResource（resourceType/resourceId 为 null）", () => {
    const { index } = baseTree();
    expect(index.byResource.has("group:g")).toBe(false);
  });
});
