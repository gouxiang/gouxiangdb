// packages/shared-types/src/__tests__/authz-row-conditions.test.ts
// P1 权限契约：manage_table 第 8 枚资源动作 + RowConditions fail-closed 解析（§5.3/§6.1/§6.3）。

import { describe, it, expect } from "vitest";
import {
  RESOURCE_ACTIONS,
  LIBRARY_RESOURCE_TYPES,
  normalizeActions,
  parseRowConditions,
  PolicyValidationError,
  type RowConditions,
} from "../authz.js";
import type { FilterNode } from "../filters.js";

describe("manage_table 资源动作", () => {
  it("已加入封闭枚举 RESOURCE_ACTIONS（词汇已扩至 11 枚，末位为建链位 share_link）", () => {
    // 8 -> 10：新增 enter / edit_data 两枚库级聚合位（ADR-0056 §4.1）；
    // 10 -> 11：新增建链位 share_link（仅 kb 节点，scope 投影派生），追加在数组末位。
    expect(RESOURCE_ACTIONS).toHaveLength(11);
    expect(RESOURCE_ACTIONS).toContain("manage_table");
    expect(RESOURCE_ACTIONS).toContain("enter");
    expect(RESOURCE_ACTIONS).toContain("edit_data");
    expect(RESOURCE_ACTIONS).toContain("share_link");
    expect(RESOURCE_ACTIONS[RESOURCE_ACTIONS.length - 1]).toBe("share_link");
    expect(LIBRARY_RESOURCE_TYPES).toEqual(["base", "kb"]);
  });

  it("normalizeActions：去重 + JS 默认字典序（既有口径，不随新动作改变）", () => {
    // 字典序中 'm' < 'r'：manage_schema < manage_table < r（与既有存储串口径一致）。
    expect(normalizeActions(["manage_table", "r", "manage_schema"])).toEqual([
      "manage_schema",
      "manage_table",
      "r",
    ]);
    expect(normalizeActions(["manage_table", "manage_share", "manage_table", "c"])).toEqual([
      "c",
      "manage_share",
      "manage_table",
    ]);
  });

  it("非法动作仍被白名单过滤", () => {
    expect(normalizeActions(["manage_table", "between", "r"])).toEqual(["manage_table", "r"]);
  });
});

const literalCond: FilterNode = {
  kind: "condition",
  fieldId: "f_owner",
  op: "is",
  value: "张三",
};

const fieldCond: FilterNode = {
  kind: "condition",
  fieldId: "f_dept",
  op: "eq",
  value: "",
  valueType: "field",
  valueFieldId: "f_dept_ref",
};

const dynamicCond: FilterNode = {
  kind: "condition",
  fieldId: "f_created_by",
  op: "is",
  value: "",
  valueType: "dynamic",
  dynamicValue: "currentUser",
};

const expectThrow = (raw: string): void => {
  expect(() => parseRowConditions(raw)).toThrow(PolicyValidationError);
};

describe("parseRowConditions 空输入", () => {
  it("null / undefined / 空白串 -> null", () => {
    expect(parseRowConditions(null)).toBeNull();
    expect(parseRowConditions(undefined)).toBeNull();
    expect(parseRowConditions("")).toBeNull();
    expect(parseRowConditions("   ")).toBeNull();
  });
});

describe("parseRowConditions 合法条件", () => {
  const wrap = (filter: FilterNode): string => JSON.stringify({ version: 1, filter });

  it("literal 条件：缺省 valueType 按 literal", () => {
    const result = parseRowConditions(wrap(literalCond)) as RowConditions;
    expect(result.version).toBe(1);
    expect(result.filter).toEqual(literalCond);
  });

  it("field 条件（两字段值比较）", () => {
    const result = parseRowConditions(wrap(fieldCond)) as RowConditions;
    expect(result.filter).toEqual(fieldCond);
  });

  it("dynamic currentUser 条件", () => {
    const result = parseRowConditions(wrap(dynamicCond)) as RowConditions;
    expect(result.filter).toEqual(dynamicCond);
  });

  it("无值操作符 isEmpty/checked 不要求 value 与 valueType", () => {
    const emptyCond: FilterNode = {
      kind: "condition",
      fieldId: "f_name",
      op: "isEmpty",
      value: "",
    };
    const checkedCond: FilterNode = {
      kind: "condition",
      fieldId: "f_done",
      op: "checked",
      value: "",
    };
    expect(parseRowConditions(wrap(emptyCond))).not.toBeNull();
    expect(parseRowConditions(wrap(checkedCond))).not.toBeNull();
  });

  it("and/or/not 嵌套合法", () => {
    const nested: FilterNode = {
      kind: "and",
      children: [
        literalCond,
        { kind: "or", children: [fieldCond, dynamicCond] },
        { kind: "not", child: { kind: "condition", fieldId: "f_x", op: "contains", value: "a" } },
      ],
    };
    const result = parseRowConditions(wrap(nested)) as RowConditions;
    expect(result.filter).toEqual(nested);
  });
});

describe("parseRowConditions fail-closed（全部抛 PolicyValidationError）", () => {
  it("坏 JSON", () => {
    expectThrow("{not json");
  });

  it("顶层不是对象", () => {
    expectThrow(JSON.stringify([1, 2]));
    expectThrow("123");
  });

  it("version 缺失或不等于 1", () => {
    expectThrow(JSON.stringify({ filter: literalCond }));
    expectThrow(JSON.stringify({ version: 2, filter: literalCond }));
    expectThrow(JSON.stringify({ version: "1", filter: literalCond }));
  });

  it("filter 缺失或不是节点", () => {
    expectThrow(JSON.stringify({ version: 1 }));
    expectThrow(JSON.stringify({ version: 1, filter: null }));
  });

  it("不存在的操作符 between（filters.ts 无此 op）", () => {
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: { kind: "condition", fieldId: "f_n", op: "between", value: "1,10" },
      }),
    );
  });

  it("不存在的操作符 in_", () => {
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: { kind: "condition", fieldId: "f_n", op: "in_", value: "a" },
      }),
    );
  });

  it("fieldId 缺失或为空", () => {
    expectThrow(JSON.stringify({ version: 1, filter: { kind: "condition", op: "is", value: "x" } }));
    expectThrow(
      JSON.stringify({ version: 1, filter: { kind: "condition", fieldId: "  ", op: "is", value: "x" } }),
    );
  });

  it("valueType 非法", () => {
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: { kind: "condition", fieldId: "f", op: "is", value: "x", valueType: "expr" },
      }),
    );
  });

  it("valueType=field 但 valueFieldId 缺失/空", () => {
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: { kind: "condition", fieldId: "f", op: "eq", value: "", valueType: "field" },
      }),
    );
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: {
          kind: "condition",
          fieldId: "f",
          op: "eq",
          value: "",
          valueType: "field",
          valueFieldId: "  ",
        },
      }),
    );
  });

  it("valueType=dynamic 但 dynamicValue 非 currentUser", () => {
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: {
          kind: "condition",
          fieldId: "f",
          op: "is",
          value: "",
          valueType: "dynamic",
          dynamicValue: "currentDate",
        },
      }),
    );
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: {
          kind: "condition",
          fieldId: "f",
          op: "is",
          value: "",
          valueType: "dynamic",
        },
      }),
    );
  });

  it("group children 为空数组或缺失", () => {
    expectThrow(JSON.stringify({ version: 1, filter: { kind: "and", children: [] } }));
    expectThrow(JSON.stringify({ version: 1, filter: { kind: "or" } }));
  });

  it("group children 含坏 child", () => {
    expectThrow(
      JSON.stringify({
        version: 1,
        filter: {
          kind: "and",
          children: [{ kind: "condition", fieldId: "f", op: "between", value: "1" }],
        },
      }),
    );
  });

  it("not child 非法", () => {
    expectThrow(JSON.stringify({ version: 1, filter: { kind: "not", child: { kind: "what" } } }));
    expectThrow(JSON.stringify({ version: 1, filter: { kind: "not" } }));
  });

  it("未知 kind", () => {
    expectThrow(JSON.stringify({ version: 1, filter: { kind: "xor", children: [literalCond] } }));
  });
});
