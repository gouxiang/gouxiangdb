// parseViewAdminConfig 单测（#560）：空 -> null；完整；缺键补齐；数组类型错误回落；
// 坏 JSON / 非对象 fail-closed 抛错。

import { describe, expect, it } from "vitest";
import { parseViewAdminConfig } from "../viewAdminConfig.js";

describe("parseViewAdminConfig", () => {
  it("null / 空白串 -> null", () => {
    expect(parseViewAdminConfig(null)).toBeNull();
    expect(parseViewAdminConfig("")).toBeNull();
    expect(parseViewAdminConfig("   ")).toBeNull();
    expect(parseViewAdminConfig("\n\t")).toBeNull();
  });

  it("完整配置原样解析（version 恒为 1）", () => {
    const cfg = {
      version: 1,
      fieldOrder: ["f1", "f2"],
      hiddenFieldIds: ["f3"],
      filters: { kind: "condition", fieldId: "f1", op: "isNotEmpty" },
      coverFieldId: "f4",
      cardFieldIds: ["f5"],
      detailFieldIds: ["f6"],
    };
    const out = parseViewAdminConfig(JSON.stringify(cfg));
    expect(out).toEqual(cfg);
  });

  it("缺键由默认值补齐", () => {
    const out = parseViewAdminConfig(JSON.stringify({ hiddenFieldIds: ["f9"] }));
    expect(out).not.toBeNull();
    expect(out!.version).toBe(1);
    expect(out!.hiddenFieldIds).toEqual(["f9"]);
    expect(out!.fieldOrder).toEqual([]);
    expect(out!.filters).toBeNull();
    expect(out!.coverFieldId).toBeNull();
    expect(out!.cardFieldIds).toEqual([]);
    expect(out!.detailFieldIds).toEqual([]);
  });

  it("数组键非数组回落 []；coverFieldId 非字符串回落 null；filters 非对象回落 null", () => {
    const out = parseViewAdminConfig(JSON.stringify({
      fieldOrder: "nope",
      hiddenFieldIds: [1, 2],
      cardFieldIds: { a: 1 },
      detailFieldIds: null,
      coverFieldId: 42,
      filters: "wat",
    }));
    expect(out!.fieldOrder).toEqual([]);
    expect(out!.hiddenFieldIds).toEqual([]);
    expect(out!.cardFieldIds).toEqual([]);
    expect(out!.detailFieldIds).toEqual([]);
    expect(out!.coverFieldId).toBeNull();
    expect(out!.filters).toBeNull();
  });

  it("数组内含非字符串元素回落 []", () => {
    const out = parseViewAdminConfig(JSON.stringify({ fieldOrder: ["ok", 3] }));
    expect(out!.fieldOrder).toEqual([]);
  });

  it("坏 JSON 抛错（fail-closed，不静默放宽）", () => {
    expect(() => parseViewAdminConfig("{not json")).toThrow();
  });

  it("顶层非对象（数组/数字/字符串）抛错", () => {
    expect(() => parseViewAdminConfig("[1,2]")).toThrow();
    expect(() => parseViewAdminConfig("42")).toThrow();
    expect(() => parseViewAdminConfig('"a string"')).toThrow();
  });
});
