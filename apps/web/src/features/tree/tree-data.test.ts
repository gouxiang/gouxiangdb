import { describe, expect, it } from "vitest";
import type { RecordDTO } from "@gx/shared-types";
import {
  parentIdFromLinks,
  toTreeRows,
  treeWouldCycle,
} from "./tree-data.js";

function rec(id: string, fields: Record<string, unknown>): RecordDTO {
  return { id, tableId: "t1", fields, createdAt: "" } as unknown as RecordDTO;
}

describe("parentIdFromLinks", () => {
  it("空/非数组 -> null", () => {
    expect(parentIdFromLinks(null, "t1")).toBeNull();
    expect(parentIdFromLinks([], "t1")).toBeNull();
  });

  it("取首个同表关联的 recordId", () => {
    const v = [{ tableId: "t1", recordId: "r2", title: "B" }];
    expect(parentIdFromLinks(v, "t1")).toBe("r2");
  });

  it("跨表关联 -> null", () => {
    const v = [{ tableId: "other", recordId: "r9", title: "X" }];
    expect(parentIdFromLinks(v, "t1")).toBeNull();
  });
});

describe("toTreeRows", () => {
  it("按 link 字段映射父子，标题用主字段，空标题兜底", () => {
    const records = [
      rec("r1", { f_title: "父", f_parent: [{ tableId: "t1", recordId: null }] }),
      rec("r2", { f_title: "子", f_parent: [{ tableId: "t1", recordId: "r1" }] }),
      rec("r3", { f_title: "", f_parent: [] }),
    ];
    const rows = toTreeRows(records, "f_parent", "f_title");
    expect(rows).toEqual([
      { id: "r1", parentId: null, name: "父" },
      { id: "r2", parentId: "r1", name: "子" },
      { id: "r3", parentId: null, name: "未命名" },
    ]);
  });

  it("父字段为空 -> 全部根", () => {
    const rows = toTreeRows([rec("r1", {})], null, null);
    expect(rows[0].parentId).toBeNull();
  });
});

describe("treeWouldCycle", () => {
  const rows = [
    { id: "a", parentId: null, name: "a" },
    { id: "b", parentId: "a", name: "b" },
    { id: "c", parentId: "b", name: "c" },
  ];

  it("挂到根不环", () => {
    expect(treeWouldCycle(rows, "c", null)).toBe(false);
  });

  it("挂到自身成环", () => {
    expect(treeWouldCycle(rows, "b", "b")).toBe(true);
  });

  it("挂到自己子孙下成环", () => {
    expect(treeWouldCycle(rows, "a", "c")).toBe(true);
  });

  it("挂到无关节点不环", () => {
    expect(treeWouldCycle(rows, "b", "a")).toBe(false);
  });
});
