// M4-FE 权限模型纯函数测试：七动作矩阵、字段三态、整单 diff、409 影响面、legacyUnmappable。
import { describe, expect, it } from "vitest";
import type { PolicyRowDTO } from "@gx/shared-types";
import { ApiError } from "../../../api/client";
import {
  ACTION_META,
  buildFieldMask,
  buildPolicyWrite,
  canAssignAction,
  extractInheritanceImpact,
  fieldStateForField,
  formatLegacyUnmappable,
  isInheritableKind,
  subjectDisplay,
  toEditableRows,
  toggleAction,
  type EditableRow,
} from "./policy-model";

function row(p: Partial<PolicyRowDTO> = {}): PolicyRowDTO {
  return {
    id: "p1",
    subjectType: "user",
    subjectId: "u1",
    subjectName: "张三",
    actions: ["r"],
    fieldMask: null,
    reason: "policy:v1",
    createdAt: "2026-09-16T00:00:00.000Z",
    ...p,
  };
}

/** 后端错误体在 ApiError 公共 body 类型之外还带 code/impact，测试侧按实构造。 */
function apiError(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError(status, body as ConstructorParameters<typeof ApiError>[1]);
}

describe("七动作矩阵", () => {
  it("ACTION_META 恰为七枚且字典序 r/c/u/d/comment/manage_share/manage_schema", () => {
    expect(ACTION_META.map((m) => m.action)).toEqual([
      "r",
      "c",
      "u",
      "d",
      "comment",
      "manage_share",
      "manage_schema",
    ]);
  });

  it("manage_schema 仅 table/base 可勾，doc/canvas/kb/view/group 置灰", () => {
    expect(canAssignAction("manage_schema", "table")).toBe(true);
    expect(canAssignAction("manage_schema", "base")).toBe(true);
    for (const k of ["doc", "canvas", "kb", "view", "group"]) {
      expect(canAssignAction("manage_schema", k)).toBe(false);
    }
    // 其余动作所有 kind 可勾（后端另有白名单）
    expect(canAssignAction("r", "doc")).toBe(true);
    expect(canAssignAction("manage_share", "kb")).toBe(true);
  });

  it("仅 doc/canvas 可中断/恢复继承", () => {
    expect(isInheritableKind("doc")).toBe(true);
    expect(isInheritableKind("canvas")).toBe(true);
    for (const k of ["table", "base", "kb", "view", "group"]) {
      expect(isInheritableKind(k)).toBe(false);
    }
  });

  it("toggleAction 去重并保持字典序", () => {
    expect(toggleAction(["r"], "comment", true)).toEqual(["r", "comment"]);
    expect(toggleAction(["r", "comment"], "r", false)).toEqual(["comment"]);
    // 乱序加入后收敛到 RESOURCE_ACTIONS 规范序（r,c,u,d,comment,manage_share,manage_schema）
    expect(toggleAction(["u", "r"], "d", true)).toEqual(["r", "u", "d"]);
    expect(toggleAction(["r"], "r", true)).toEqual(["r"]); // 幂等
  });
});

describe("字段三态映射（FieldMask 收窄可见 / 只读 / 缺省全量）", () => {
  it("fieldStateForField：allowFields 外=hidden，readOnlyFields=readonly，否则 editable", () => {
    expect(fieldStateForField(null, "f1")).toBe("editable");
    expect(fieldStateForField({ allowFields: ["f1"] }, "f2")).toBe("hidden");
    expect(fieldStateForField({ allowFields: ["f1", "f2"], readOnlyFields: ["f2"] }, "f2")).toBe("readonly");
    expect(fieldStateForField({ readOnlyFields: ["f1"] }, "f1")).toBe("readonly");
  });

  it("buildFieldMask 全可编辑→null；部分隐藏→allowFields；只读→readOnlyFields", () => {
    const fields = ["f1", "f2", "f3"];
    expect(buildFieldMask(fields, () => "editable")).toBeNull();
    expect(buildFieldMask(fields, (id) => (id === "f3" ? "hidden" : "editable"))).toEqual({
      allowFields: ["f1", "f2"],
    });
    expect(buildFieldMask(fields, (id) => (id === "f2" ? "readonly" : "editable"))).toEqual({
      readOnlyFields: ["f2"],
    });
    // hidden + readonly 混合
    expect(buildFieldMask(fields, (id) => (id === "f3" ? "hidden" : id === "f2" ? "readonly" : "editable"))).toEqual({
      allowFields: ["f1", "f2"],
      readOnlyFields: ["f2"],
    });
  });

  it("三态往返：由 mask 求状态再重建 mask 得等价掩码", () => {
    const fields = ["f1", "f2", "f3", "f4"];
    const original = { allowFields: ["f1", "f2", "f3"], readOnlyFields: ["f3"] };
    const rebuilt = buildFieldMask(fields, (id) => fieldStateForField(original, id));
    expect(rebuilt).toEqual(original);
  });
});

describe("buildPolicyWrite 整单 diff（全合法才提交；清空=删除；无变化不发单）", () => {
  it("无变化返回 null（不发空单，后端要求至少一项）", () => {
    const rows = toEditableRows([row()]);
    expect(buildPolicyWrite(rows)).toBeNull();
  });

  it("新增动作 → upsert（带 subject 与 actions）；移除动作回原 → 空单", () => {
    const rows = toEditableRows([row()]);
    rows[0]!.actions = ["r", "u"];
    expect(buildPolicyWrite(rows)).toEqual({
      upserts: [{ subjectType: "user", subjectId: "u1", actions: ["r", "u"], fieldMask: null }],
    });
  });

  it("原有行动作清空 → deletes；标记 removed → deletes；新增行清空 → 忽略", () => {
    const original: EditableRow[] = [
      { subjectType: "user", subjectId: "u1", actions: [], fieldMask: null, original: row() },
      { subjectType: "dept", subjectId: "d1", actions: ["r"], fieldMask: null, original: row({ subjectType: "dept", subjectId: "d1" }), removed: true },
      { subjectType: "role", subjectId: "r1", actions: [], fieldMask: null, original: null },
    ];
    expect(buildPolicyWrite(original)).toEqual({
      deletes: [
        { subjectType: "user", subjectId: "u1" },
        { subjectType: "dept", subjectId: "d1" },
      ],
    });
  });

  it("fieldMask 变化进 upsert；动作集排序差异不算变化", () => {
    const rows = toEditableRows([row({ actions: ["u", "r"] })]); // 乱序但集合相同
    expect(buildPolicyWrite(rows)).toBeNull();
    rows[0]!.fieldMask = { readOnlyFields: ["f9"] };
    expect(buildPolicyWrite(rows)?.upserts?.[0]?.fieldMask).toEqual({ readOnlyFields: ["f9"] });
  });
});

describe("extractInheritanceImpact：只认 409 + INHERITANCE_CONFIRM_REQUIRED + impact", () => {
  const impact = { nodeId: "n1", from: true, to: false, delta: "losing", count: 2, items: [], limit: 100, offset: 0, exempt: [] } as const;
  it("命中返回 impact", () => {
    const e = apiError(409, { error: "需确认", code: "INHERITANCE_CONFIRM_REQUIRED", impact });
    expect(extractInheritanceImpact(e)).toEqual(impact);
  });
  it("409 他 code / 缺 impact / 403 / 500 / 非 ApiError → null", () => {
    expect(extractInheritanceImpact(apiError(409, { code: "OTHER", impact }))).toBeNull();
    expect(extractInheritanceImpact(apiError(409, { code: "INHERITANCE_CONFIRM_REQUIRED" }))).toBeNull();
    expect(extractInheritanceImpact(apiError(403, { code: "FORBIDDEN" }))).toBeNull();
    expect(extractInheritanceImpact(apiError(500, {}))).toBeNull();
    expect(extractInheritanceImpact(new TypeError("network"))).toBeNull();
    expect(extractInheritanceImpact(null)).toBeNull();
  });
});

describe("legacyUnmappable 200 提示与悬挂主体", () => {
  it("按主体类型给具体中文提示并带 reasons（成功提示，非错误）", () => {
    const lines = formatLegacyUnmappable([
      { subjectType: "role", subjectId: "role_1", reasons: ["field_mask", "nonstandard_actions"] },
      { subjectType: "dept", subjectId: "d2", reasons: [] },
    ]);
    expect(lines[0]).toContain("角色 role_1");
    expect(lines[0]).toContain("仅在企业权限引擎生效");
    expect(lines[0]).toContain("field_mask、nonstandard_actions");
    expect(lines[1]).toContain("部门 d2");
    expect(lines[1]).not.toContain("（");
  });

  it("subjectName=null 显‘已删除主体’，有名显原名", () => {
    expect(subjectDisplay(null)).toBe("已删除主体");
    expect(subjectDisplay("李四")).toBe("李四");
  });
});
