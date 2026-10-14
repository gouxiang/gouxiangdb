// apps/web/src/features/comments/organize.test.ts
// 两级评论规整/计数单测（node，无 jsdom）：根倒序、回复升序、嵌套/扁平两形态、
// 孤儿回复不丢、不改入参（不用 reverse）、总数=根+回复。

import { describe, expect, it } from "vitest";
import type { CommentDTO } from "@gx/shared-types";
import { organizeComments, totalComments } from "./organize";

const c = (o: Partial<CommentDTO> & { id: string }): CommentDTO =>
  ({
    recordId: "r1",
    userId: "u",
    displayName: "名",
    avatarUrl: null,
    body: "",
    attachments: [],
    mentions: [],
    parentId: null,
    replyToUserId: null,
    replyToDisplayName: null,
    replies: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...o,
  }) as CommentDTO;

describe("organizeComments：根倒序、回复升序、不 reverse", () => {
  it("嵌套形态：根按 createdAt 倒序，回复升序", () => {
    const list = [
      c({
        id: "root-a",
        createdAt: "2026-01-01T00:00:00Z",
        replies: [
          c({
            id: "a-r2",
            parentId: "root-a",
            createdAt: "2026-01-03T00:00:00Z",
          }),
          c({
            id: "a-r1",
            parentId: "root-a",
            createdAt: "2026-01-02T00:00:00Z",
          }),
        ],
      }),
      c({ id: "root-b", createdAt: "2026-02-01T00:00:00Z" }),
    ];
    const roots = organizeComments(list);
    expect(roots.map((r) => r.id)).toEqual(["root-b", "root-a"]);
    expect(roots[1]!.replies!.map((r) => r.id)).toEqual(["a-r1", "a-r2"]);
  });

  it("扁平形态：把回复挂到对应根下", () => {
    const list = [
      c({ id: "root", createdAt: "2026-01-01T00:00:00Z" }),
      c({
        id: "rep",
        parentId: "root",
        replyToUserId: "root",
        replyToDisplayName: "名",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ];
    const roots = organizeComments(list);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe("root");
    expect(roots[0]!.replies!.map((r) => r.id)).toEqual(["rep"]);
  });

  it("同一回复嵌套+扁平同时出现时按 id 去重", () => {
    const list = [
      c({
        id: "root",
        replies: [
          c({ id: "rep", parentId: "root", createdAt: "2026-01-02T00:00:00Z" }),
        ],
      }),
      c({ id: "rep", parentId: "root", createdAt: "2026-01-02T00:00:00Z" }),
    ];
    const roots = organizeComments(list);
    expect(roots[0]!.replies!.map((r) => r.id)).toEqual(["rep"]);
  });

  it("父评论缺失的孤儿回复不丢弃，并入根池按时间倒序", () => {
    const list = [
      c({ id: "root", createdAt: "2026-01-01T00:00:00Z" }),
      c({ id: "orphan", parentId: "gone", createdAt: "2026-03-01T00:00:00Z" }),
    ];
    const roots = organizeComments(list);
    expect(roots.map((r) => r.id)).toEqual(["orphan", "root"]);
    expect(roots.find((r) => r.id === "orphan")!.parentId).toBeNull();
  });

  it("不修改入参（拷贝排序），不使用 reverse", () => {
    const list = [
      c({ id: "a", createdAt: "2026-01-01T00:00:00Z" }),
      c({ id: "b", createdAt: "2026-01-02T00:00:00Z" }),
    ];
    organizeComments(list);
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("null/undefined 返回空数组", () => {
    expect(organizeComments(undefined)).toEqual([]);
  });
});

describe("totalComments：根+回复总数", () => {
  it("嵌套计数", () => {
    const list = [
      c({
        id: "r1",
        replies: [
          c({ id: "x", parentId: "r1", createdAt: "1" }),
          c({ id: "y", parentId: "r1", createdAt: "2" }),
        ],
      }),
      c({ id: "r2" }),
    ];
    expect(totalComments(list)).toBe(4);
  });
  it("空态为 0", () => {
    expect(totalComments(null)).toBe(0);
    expect(totalComments([])).toBe(0);
  });
});
