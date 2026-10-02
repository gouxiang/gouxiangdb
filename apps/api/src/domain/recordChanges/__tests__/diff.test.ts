// 记录变更历史：纯函数层单测（diff + 开关解析）。零 IO、零真库，跑得快、失败定位准。
// 端到端（真迁移库 + 真路由）见 routes/__tests__/recordChanges.test.ts。

import { describe, expect, it } from "vitest";
import { diffRecordFields, valuesEqual } from "../diff.js";
import { parseRecordChangesFlag, recordChangesEnabled } from "../../../configRecordChanges.js";

const F = [
  { id: "f1", name: "名称", type: "singleLineText" },
  { id: "f2", name: "状态", type: "singleSelect" },
  { id: "f3", name: "备注", type: "singleLineText" },
  { id: "f4", name: "公式", type: "formula" },
];

describe("valuesEqual", () => {
  it("两侧都空即等价（null / undefined / 空串 / 空数组交叉相等）", () => {
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual(null, "")).toBe(true);
    expect(valuesEqual("", [])).toBe(true);
    expect(valuesEqual(null, [])).toBe(true);
  });

  it("数组逐项比且顺序敏感；长度不同即不等", () => {
    expect(valuesEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(valuesEqual(["b", "a"], ["a", "b"])).toBe(false);
    expect(valuesEqual(["a"], ["a", "b"])).toBe(false);
    expect(valuesEqual(["a"], "a")).toBe(true);
  });

  it("标量严格相等；对象退化为 JSON 串比", () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual(1, "1")).toBe(false);
    expect(valuesEqual(true, false)).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("diffRecordFields", () => {
  it("create：before 恒 null，产出所有落到非空值的字段（初始值快照）", () => {
    const out = diffRecordFields({
      op: "create",
      beforeFields: {},
      afterFields: { f1: "A", f2: "opt1", f3: null },
      fields: F,
    });
    expect(out).toEqual([
      { fieldId: "f1", fieldName: "名称", before: null, after: "A" },
      { fieldId: "f2", fieldName: "状态", before: null, after: "opt1" },
    ]);
  });

  it("update：只产出真正变了的字段，未动的字段不出现", () => {
    const out = diffRecordFields({
      op: "update",
      beforeFields: { f1: "A", f2: "opt1", f3: "备注原值" },
      afterFields: { f1: "B", f2: "opt1", f3: "备注原值" },
      fields: F,
    });
    expect(out).toEqual([{ fieldId: "f1", fieldName: "名称", before: "A", after: "B" }]);
  });

  it("update：清空一个字段记为一条（before 有值、after 空），before/after 归一", () => {
    const out = diffRecordFields({
      op: "update",
      beforeFields: { f1: "A", f3: "x" },
      afterFields: { f1: "A", f3: "" },
      fields: F,
    });
    expect(out).toEqual([{ fieldId: "f3", fieldName: "备注", before: "x", after: null }]);
  });

  it("update：null -> 空串不算变更（避免噪声条目）", () => {
    const out = diffRecordFields({
      op: "update",
      beforeFields: { f1: null },
      afterFields: { f1: "" },
      fields: F,
    });
    expect(out).toEqual([]);
  });

  it("计算/系统字段一律不进日志（不是人改的）", () => {
    const out = diffRecordFields({
      op: "update",
      beforeFields: { f4: 1 },
      afterFields: { f4: 2 },
      fields: F,
    });
    expect(out).toEqual([]);
  });

  it("字段被删后（不在 fields 里）无法命名，直接跳过而不是产出无名条目", () => {
    const out = diffRecordFields({
      op: "update",
      beforeFields: { ghost: "x" },
      afterFields: { ghost: "y" },
      fields: F,
    });
    expect(out).toEqual([]);
  });

  it("遍历顺序按字段定义顺序，与 Object.keys 顺序无关（输出稳定）", () => {
    const a = diffRecordFields({
      op: "create",
      beforeFields: {},
      afterFields: { f3: "c", f1: "a", f2: "b" },
      fields: F,
    });
    expect(a.map((x) => x.fieldId)).toEqual(["f1", "f2", "f3"]);
  });
});

describe("GX_RECORD_CHANGES 开关解析", () => {
  it("默认开启（fail-open）：未设置 / 空串 / 未知值一律 true", () => {
    // 历史不可回溯补写，故默认值必须是"记"；漏配 env 的代价只能是"多记"，不能是"永久丢失"。
    expect(parseRecordChangesFlag(undefined)).toBe(true);
    expect(parseRecordChangesFlag("")).toBe(true);
    expect(parseRecordChangesFlag("   ")).toBe(true);
    expect(parseRecordChangesFlag("on")).toBe(true);
    expect(parseRecordChangesFlag("ON")).toBe(true);
    expect(parseRecordChangesFlag("On")).toBe(true);
    expect(parseRecordChangesFlag("true")).toBe(true);
    expect(parseRecordChangesFlag("1")).toBe(true);
    // 笔误（想写 off 写成 opne）也按"开"处理：反方向的笔误才会造成历史空洞
    expect(parseRecordChangesFlag("opne")).toBe(true);
  });

  it("仅精确 off / false / 0（大小写与首尾空白不敏感）为关", () => {
    expect(parseRecordChangesFlag("off")).toBe(false);
    expect(parseRecordChangesFlag("OFF")).toBe(false);
    expect(parseRecordChangesFlag(" off ")).toBe(false);
    expect(parseRecordChangesFlag("false")).toBe(false);
    expect(parseRecordChangesFlag("0")).toBe(false);
  });

  it("recordChangesEnabled 走 env（运行时可读，故测试可切）", () => {
    expect(recordChangesEnabled({})).toBe(true);
    expect(recordChangesEnabled({ GX_RECORD_CHANGES: "on" })).toBe(true);
    expect(recordChangesEnabled({ GX_RECORD_CHANGES: "off" })).toBe(false);
  });
});
