// apps/web/src/features/designer/__tests__/viewAdminFields.test.ts
// 视图管理员配置（#560）字段纯函数单测：隐藏加入/移出、上移下移边界、未排序字段追加。

import { describe, it, expect } from "vitest";
import {
  ensureOrder,
  moveField,
  toggleHidden,
  toggleId,
} from "../viewAdminFields";

describe("toggleHidden", () => {
  it("字段未隐藏时加入到末尾", () => {
    expect(toggleHidden(["a"], "b")).toEqual(["a", "b"]);
  });

  it("字段已隐藏时移出", () => {
    expect(toggleHidden(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("空列表加入首个", () => {
    expect(toggleHidden([], "x")).toEqual(["x"]);
  });

  it("移出最后一个后为空数组", () => {
    expect(toggleHidden(["x"], "x")).toEqual([]);
  });
});

describe("toggleId", () => {
  it("已选则取消、未选则追加", () => {
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("ensureOrder", () => {
  it("未排序字段按 allIds 顺序追加到末尾", () => {
    expect(ensureOrder(["b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("order 为空时直接返回 allIds", () => {
    expect(ensureOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("剔除已不在 allIds 中的幽灵字段", () => {
    expect(ensureOrder(["gone", "a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("order 中重复项按首次出现去重", () => {
    expect(ensureOrder(["a", "a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("已完全对齐时原样返回", () => {
    expect(ensureOrder(["a", "b", "c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("moveField", () => {
  it("上移一位", () => {
    expect(moveField(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  });

  it("下移一位", () => {
    expect(moveField(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("首项继续上移为边界，顺序不变", () => {
    expect(moveField(["a", "b"], "a", -1)).toEqual(["a", "b"]);
  });

  it("末项继续下移为边界，顺序不变", () => {
    expect(moveField(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("id 不在 order 中时顺序不变", () => {
    expect(moveField(["a", "b"], "z", -1)).toEqual(["a", "b"]);
  });

  it("不修改原数组", () => {
    const src = ["a", "b", "c"];
    moveField(src, "a", 1);
    expect(src).toEqual(["a", "b", "c"]);
  });
});
