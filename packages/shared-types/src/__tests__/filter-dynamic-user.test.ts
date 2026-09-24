// packages/shared-types/src/__tests__/filter-dynamic-user.test.ts
// 动态筛选值「当前登录用户」（valueType="dynamic" / dynamicValue="currentUser"）。
// 人名字段按 userId 精确匹配（不是显示名），与物理 records.createdBy 列口径一致；
// 无登录用户时 fail-closed（含反向操作），不放行任何行。

import { describe, it, expect } from "vitest";
import { evalFilter, type FilterEvalContext, type RawValue } from "../filter.js";
import type { FilterNode } from "../filters.js";

const cond = (over: Record<string, unknown>): FilterNode =>
  ({ kind: "condition", fieldId: "f_creator", op: "is", value: "", ...over }) as FilterNode;

/** 模拟 recordService：createdBy / lastModifiedBy 字段回顶层物理 userId，其余字段无 actor */
const makeGetActorId =
  (actorByField: Record<string, string | null>) =>
  (fid: string): RawValue =>
    Object.prototype.hasOwnProperty.call(actorByField, fid) ? actorByField[fid] : null;

const ctx = (
  currentUserId: string | null | undefined,
  actorByField: Record<string, string | null>,
): FilterEvalContext => ({
  vars: { currentUserId },
  getActorId: makeGetActorId(actorByField),
});

describe("evalFilter 当前用户（valueType=dynamic, currentUser）", () => {
  it("is：创建者 userId = 当前用户 → 命中", () => {
    const node = cond({ op: "is", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(node, () => "张三" as RawValue, undefined, ctx("u1", { f_creator: "u1" }))).toBe(true);
  });

  it("is：创建者是别的用户 → 不命中（即便显示名恰好相同也按 userId 判定）", () => {
    const node = cond({ op: "is", valueType: "dynamic", dynamicValue: "currentUser" });
    // 内存字段里是显示名「张三」，actor userId 是 u2；当前用户 u1 也叫张三 → 仍不命中
    expect(evalFilter(node, () => "张三" as RawValue, undefined, ctx("u1", { f_creator: "u2" }))).toBe(false);
  });

  it("isNot：创建者不是当前用户 → true", () => {
    const node = cond({ op: "isNot", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(node, () => "李四" as RawValue, undefined, ctx("u1", { f_creator: "u2" }))).toBe(true);
  });

  it("isNot：创建者正是当前用户 → false", () => {
    const node = cond({ op: "isNot", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(node, () => "张三" as RawValue, undefined, ctx("u1", { f_creator: "u1" }))).toBe(false);
  });

  it("lastModifiedBy 字段同样按 userId 精确匹配", () => {
    const node = cond({ fieldId: "f_editor", op: "is", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(node, () => null, undefined, ctx("u9", { f_editor: "u9" }))).toBe(true);
    expect(evalFilter(node, () => null, undefined, ctx("u9", { f_editor: "u1" }))).toBe(false);
  });

  it("and/or/not 组内递归透传动态上下文", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        cond({ fieldId: "f_creator", op: "is", valueType: "dynamic", dynamicValue: "currentUser" }),
        {
          kind: "or",
          children: [
            cond({ fieldId: "f_editor", op: "isNot", valueType: "dynamic", dynamicValue: "currentUser" }),
            { kind: "not", child: cond({ fieldId: "f_x", op: "is", valueType: "dynamic", dynamicValue: "currentUser" }) },
          ],
        },
      ],
    };
    const c = ctx("u1", { f_creator: "u1", f_editor: "u2", f_x: "u3" });
    expect(evalFilter(node, () => null, undefined, c)).toBe(true);
  });
});

describe("evalFilter currentUser fail-closed（无登录态）", () => {
  const node = cond({ op: "is", valueType: "dynamic", dynamicValue: "currentUser" });

  it("不传 ctx（旧调用方）：currentUser 条件恒 false，不抛错", () => {
    expect(evalFilter(node, () => "u1" as RawValue)).toBe(false);
  });

  it("currentUserId=null（分享外链/未登录）：恒 false", () => {
    expect(evalFilter(node, () => "张三" as RawValue, undefined, ctx(null, { f_creator: "u1" }))).toBe(false);
  });

  it("currentUserId 为空串：恒 false", () => {
    expect(evalFilter(node, () => "张三" as RawValue, undefined, ctx("", { f_creator: "u1" }))).toBe(false);
  });

  it("反向操作 isNot 在无登录态也恒 false —— 不得放开全表", () => {
    const notNode = cond({ op: "isNot", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(notNode, () => "李四" as RawValue)).toBe(false);
    expect(evalFilter(notNode, () => "李四" as RawValue, undefined, ctx(null, { f_creator: "u2" }))).toBe(false);
  });

  it("notContains 无登录态同样 fail-closed", () => {
    const ncNode = cond({ op: "notContains", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(ncNode, () => "李四" as RawValue, undefined, ctx(null, { f_creator: "u2" }))).toBe(false);
  });

  it("记录 actor userId 缺失（对齐物理 NULL）：is 与 isNot 都不成立", () => {
    expect(evalFilter(node, () => null, undefined, ctx("u1", { f_creator: null }))).toBe(false);
    const notNode = cond({ op: "isNot", valueType: "dynamic", dynamicValue: "currentUser" });
    expect(evalFilter(notNode, () => null, undefined, ctx("u1", { f_creator: null }))).toBe(false);
  });

  it("未知 dynamicValue（非 currentUser）：fail-closed", () => {
    const weird = cond({ op: "is", valueType: "dynamic", dynamicValue: "futureThing" });
    expect(evalFilter(weird, () => "x" as RawValue, undefined, ctx("u1", { f_creator: "u1" }))).toBe(false);
  });
});

describe("evalFilter currentUser 向后兼容", () => {
  it("无值操作符 isEmpty 不引用 currentUser：有登录态也按字段空值正常判定", () => {
    const emptyNode = cond({ op: "isEmpty", valueType: "dynamic", dynamicValue: "currentUser" });
    // getActorId 给不出值（字段为空），isEmpty 应基于原始 get 的值
    expect(evalFilter(emptyNode, () => null as RawValue, undefined, ctx("u1", {}))).toBe(true);
    expect(evalFilter(emptyNode, () => "张三" as RawValue, undefined, ctx("u1", { f_creator: "u1" }))).toBe(false);
  });

  it("字面量条件在引入 ctx 后行为不变", () => {
    const lit = cond({ op: "is", valueType: "literal", value: "张三" });
    expect(evalFilter(lit, () => "张三" as RawValue, undefined, ctx("u1", { f_creator: "u1" }))).toBe(true);
    expect(evalFilter(lit, () => "李四" as RawValue, undefined, ctx("u1", { f_creator: "u1" }))).toBe(false);
  });
});
