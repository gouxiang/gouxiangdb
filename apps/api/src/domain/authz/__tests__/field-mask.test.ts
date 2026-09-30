// M4/S1 fieldMask 纯函数：并集最宽 6 组合 + merge/apply/assert 守卫（不碰库，表驱动）。

import { describe, expect, it } from "vitest";
import {
  assertFieldsWritable,
  assertWriteOnlyFields,
  AuthzFieldError,
  applyMaskToRecords,
  canSeeField,
  canWriteField,
  fieldCapability,
  fieldVisibleInMask,
  fieldWritableInMask,
  mergeFieldMasks,
  writeOnlyFieldCapability,
} from "../fieldMask.js";
import type { ScopedPolicy } from "../types.js";

function pol(partial: Partial<ScopedPolicy> & { actions: string[] }): ScopedPolicy {
  return {
    id: partial.id ?? `pol_${Math.random().toString(36).slice(2)}`,
    nodeId: partial.nodeId ?? "node_t",
    subjectType: partial.subjectType ?? "user",
    subjectId: partial.subjectId ?? "u1",
    actions: partial.actions as ScopedPolicy["actions"],
    fieldMask: partial.fieldMask === undefined ? null : partial.fieldMask,
    rowConditions: partial.rowConditions === undefined ? null : partial.rowConditions,
    viaAncestor: partial.viaAncestor ?? false,
  };
}

describe("fieldMask 单源判定", () => {
  it("null/缺省=不裁剪；allowFields 白名单；readOnlyFields 只读", () => {
    expect(fieldVisibleInMask(null, "f1")).toBe(true);
    expect(fieldVisibleInMask({}, "f1")).toBe(true);
    expect(fieldVisibleInMask({ allowFields: ["f1"] }, "f1")).toBe(true);
    expect(fieldVisibleInMask({ allowFields: ["f1"] }, "f2")).toBe(false);
    expect(fieldWritableInMask({ allowFields: ["f1"], readOnlyFields: ["f1"] }, "f1")).toBe(false);
    expect(fieldWritableInMask({ allowFields: ["f1", "f2"], readOnlyFields: ["f1"] }, "f2")).toBe(true);
    expect(fieldWritableInMask({ readOnlyFields: ["f1"] }, "f2")).toBe(true);
  });
});

// 并集最宽 6 组合（M4 计划 §4.3：多源可见=任一来源可见之并；可写=任一来源给可写且非各来源只读）。
const SIX: Array<{
  name: string;
  policies: ScopedPolicy[];
  see: Record<string, boolean>;
  write: Record<string, boolean>;
}> = [
  {
    name: "1) 两源均无 mask：全可见全可写",
    policies: [pol({ actions: ["r", "u"] }), pol({ actions: ["r", "c"], subjectId: "u2" })],
    see: { f1: true, f2: true, fx: true },
    write: { f1: true, f2: true, fx: true },
  },
  {
    name: "2) 宽来源(null)+窄来源：宽胜，全可见全可写",
    policies: [
      pol({ actions: ["r", "u"], fieldMask: null }),
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1"] }, subjectId: "u2" }),
    ],
    see: { f1: true, f2: true, fx: true },
    write: { f1: true, f2: true, fx: true },
  },
  {
    name: "3) 两个窄白名单取并集：a,b ∪ b,c = a,b,c",
    policies: [
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1", "f2"] } }),
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f2", "f3"] }, subjectId: "u2" }),
    ],
    see: { f1: true, f2: true, f3: true, f4: false },
    write: { f1: true, f2: true, f3: true, f4: false },
  },
  {
    name: "4) 一源把并集内 f1 置只读：f1 不可写，f2/f3 仍可写（另一源给可写也需非其只读——f1 两源均只读则否）",
    policies: [
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1", "f2"], readOnlyFields: ["f1"] } }),
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1", "f3"], readOnlyFields: ["f1"] }, subjectId: "u2" }),
    ],
    see: { f1: true, f2: true, f3: true, f4: false },
    write: { f1: false, f2: true, f3: true, f4: false },
  },
  {
    name: "5) 只读不跨源传染：源 A 只读 f1，源 B 同见 f1 且不只读 -> f1 可写",
    policies: [
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1", "f2"], readOnlyFields: ["f1"] } }),
      pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1"] }, subjectId: "u2" }),
    ],
    see: { f1: true, f2: true, f3: false },
    write: { f1: true, f2: true, f3: false },
  },
  {
    name: "6) 仅 r 来源：可见面为并集，全部不可写；无 r 来源表级不可见",
    policies: [
      pol({ actions: ["r"], fieldMask: { allowFields: ["f1"] } }),
      pol({ actions: ["r"], fieldMask: { allowFields: ["f2"] }, subjectId: "u2" }),
    ],
    see: { f1: true, f2: true, f3: false },
    write: { f1: false, f2: false },
  },
];

describe("fieldCapability 并集最宽 6 组合", () => {
  for (const c of SIX) {
    it(c.name, () => {
      const cap = fieldCapability(c.policies);
      for (const [f, want] of Object.entries(c.see)) {
        expect(canSeeField(cap, f)).toBe(want);
      }
      for (const [f, want] of Object.entries(c.write)) {
        expect(canWriteField(cap, f)).toBe(want);
      }
    });
  }

  it("无任何 r 来源 -> visible=false（表级不可见，不产生字段级结果）", () => {
    const cap = fieldCapability([pol({ actions: ["u"] })]);
    expect(cap.visible).toBe(false);
    expect(canSeeField(cap, "f1")).toBe(false);
  });
});

describe("mergeFieldMasks", () => {
  it("空集 -> null；任一 null/无 allowFields -> null（不裁剪）", () => {
    expect(mergeFieldMasks([])).toBeNull();
    expect(mergeFieldMasks([null, { allowFields: ["f1"] }])).toBeNull();
    expect(mergeFieldMasks([{}, { allowFields: ["f1"] }])).toBeNull();
  });

  it("allowFields 并集；readOnlyFields 各源交集", () => {
    const merged = mergeFieldMasks([
      { allowFields: ["f1", "f2"], readOnlyFields: ["f1"] },
      { allowFields: ["f2", "f3"], readOnlyFields: ["f1", "f2"] },
    ]);
    expect(merged?.allowFields?.sort()).toEqual(["f1", "f2", "f3"]);
    expect(merged?.readOnlyFields).toEqual(["f1"]);
  });
});

describe("applyMaskToRecords / assertFieldsWritable", () => {
  const cap = fieldCapability([
    pol({ actions: ["r", "u"], fieldMask: { allowFields: ["f1", "f2"], readOnlyFields: ["f2"] } }),
  ]);
  const defs = [{ id: "f1" }, { id: "f2" }, { id: "f3" }];

  it("投影删除不可见键（不改输入），字段清单同步过滤", () => {
    const records = [{ id: "r1", fields: { f1: 1, f2: 2, f3: 3 } }];
    const out = applyMaskToRecords(records, defs, cap);
    expect(out.records[0]!.fields).toEqual({ f1: 1, f2: 2 });
    expect(records[0]!.fields).toEqual({ f1: 1, f2: 2, f3: 3 });
    expect(out.fields.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("写 payload 含隐藏键/只读键整单拒绝 FORBIDDEN_FIELD；合法键放行", () => {
    expect(() => assertFieldsWritable(["f1", "f3"], cap)).toThrow(AuthzFieldError);
    try {
      assertFieldsWritable(["f1", "f3"], cap);
      throw new Error("应抛出");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthzFieldError);
      expect((e as AuthzFieldError).code).toBe("FORBIDDEN_FIELD");
      expect((e as AuthzFieldError).status).toBe(403);
      expect((e as AuthzFieldError).fieldIds).toEqual(["f3"]);
    }
    expect(() => assertFieldsWritable(["f2"], cap)).toThrow(/只读/);
    expect(() => assertFieldsWritable(["f1"], cap)).not.toThrow();
  });
});

// P1-B：只写身份（有 c/u 窄掩码、无任何 r 来源）必须仍按 writeSources 收窄，不能因 read-capability
// visibleFields=null 而 fail-open。旧 MCP 守卫 `!writableAll && visibleFields!==null` 在此整段跳过。
describe("P1-B writeOnlyFieldCapability / assertWriteOnlyFields（只写身份 fail-closed）", () => {
  it("窄 c + allowFields:[fA]、无 r：read-capability visible=false，但纯写能力只放 fA", () => {
    const policies = [pol({ actions: ["c"], fieldMask: { allowFields: ["fA"] } })];
    // 旧的读能力：无 r -> visible=false / visibleFields=null（旧 MCP 守卫因此跳过白名单 = fail-open）
    const readCap = fieldCapability(policies);
    expect(readCap.visible).toBe(false);
    expect(readCap.visibleFields).toBeNull();
    // 新纯写能力：命中 c、非全写、可写集仅 fA
    const wcap = writeOnlyFieldCapability(policies, "c");
    expect(wcap.writeMatched).toBe(true);
    expect(wcap.writableAll).toBe(false);
    expect([...wcap.writableFields]).toEqual(["fA"]);
    // fA 放行；fB（掩码外）整单拒
    expect(() => assertWriteOnlyFields(["fA"], wcap)).not.toThrow();
    try {
      assertWriteOnlyFields(["fA", "fB"], wcap);
      throw new Error("应拒绝掩码外字段");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthzFieldError);
      expect((e as AuthzFieldError).fieldIds).toEqual(["fB"]);
    }
  });

  it("readOnlyFields 中的键即使在 allowFields 内也不可写（双查）", () => {
    const policies = [pol({ actions: ["c"], fieldMask: { allowFields: ["fA", "fR"], readOnlyFields: ["fR"] } })];
    const wcap = writeOnlyFieldCapability(policies, "c");
    expect([...wcap.writableFields].sort()).toEqual(["fA"]);
    expect(() => assertWriteOnlyFields(["fR"], wcap)).toThrow(AuthzFieldError);
  });

  it("宽 c（mask=null）-> writableAll=true，全字段放行（只写身份可用，不回归）", () => {
    const wcap = writeOnlyFieldCapability([pol({ actions: ["c"], fieldMask: null })], "c");
    expect(wcap.writeMatched).toBe(true);
    expect(wcap.writableAll).toBe(true);
    expect(() => assertWriteOnlyFields(["fA", "fB", "fx"], wcap)).not.toThrow();
  });

  it("只有 readOnlyFields 无 allowFields 的写来源：不放大为可写（无可写白名单）", () => {
    const wcap = writeOnlyFieldCapability(
      [pol({ actions: ["u"], fieldMask: { readOnlyFields: ["fR"] } })],
      "u",
    );
    expect(wcap.writableAll).toBe(false);
    expect(wcap.writableFields.size).toBe(0);
    expect(() => assertWriteOnlyFields(["fX"], wcap)).toThrow(AuthzFieldError);
  });

  it("无该动作写来源 -> matched=false 且任意键 fail-closed（不回落全写）", () => {
    const wcap = writeOnlyFieldCapability([pol({ actions: ["r"], fieldMask: { allowFields: ["fA"] } })], "c");
    expect(wcap.writeMatched).toBe(false);
    expect(wcap.writableAll).toBe(false);
    expect(() => assertWriteOnlyFields(["fA"], wcap)).toThrow(AuthzFieldError);
  });

  it("多窄写来源取并集；c 与 u 动作互不串用", () => {
    const policies = [
      pol({ actions: ["c"], fieldMask: { allowFields: ["fA", "fB"] }, subjectId: "u2" }),
      pol({ actions: ["c"], fieldMask: { allowFields: ["fB", "fC"] }, subjectId: "u3" }),
    ];
    const ccap = writeOnlyFieldCapability(policies, "c");
    expect([...ccap.writableFields].sort()).toEqual(["fA", "fB", "fC"]);
    // 同样策略但问 u：无 u 来源 -> fail-closed
    const ucap = writeOnlyFieldCapability(policies, "u");
    expect(ucap.writeMatched).toBe(false);
  });
});
