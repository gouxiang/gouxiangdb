// v6 #984 筛选条件 chips 纯函数回归（node 环境，无 React/无依赖）。
//
// 锁 deriveFilterChips / removeFilterCondition 全口径：
//   null/单层多条件/or/嵌套子组折叠/not/formula/dynamic/field/literal select 映射/
//   无需值操作符/删除顶层条件/删子组/删空归一 null/不可变。
// 刻意不验证 eval 语义（那是 FilterEngine 的测试）；这里只锁派生与删除契约。

import { describe, it, expect } from "vitest";
import type { FieldDTO, FilterNode } from "@gx/shared-types";
import { deriveFilterChips, removeFilterCondition } from "./filter-chips";

const field = (id: string, name: string, type = "singleLineText", options: unknown = null): FieldDTO =>
  ({ id, name, type, options, order: 0 }) as unknown as FieldDTO;

const selectField = (id: string, name: string, type: "singleSelect" | "multiSelect" = "singleSelect"): FieldDTO =>
  ({
    id,
    name,
    type,
    order: 0,
    options: [
      { id: "opt1", name: "进行中" },
      { id: "opt2", name: "已完成" },
    ],
  }) as unknown as FieldDTO;

const cond = (
  fieldId: string,
  op: string,
  value: string,
  extra: Record<string, unknown> = {},
): FilterNode =>
  ({ kind: "condition", fieldId, op, value, ...extra }) as unknown as FilterNode;

const and = (...children: FilterNode[]): FilterNode => ({ kind: "and", children });
const or = (...children: FilterNode[]): FilterNode => ({ kind: "or", children });
const not = (child: FilterNode): FilterNode => ({ kind: "not", child });
const formula = (expression: string): FilterNode => ({ kind: "formula", expression });

describe("deriveFilterChips：基本形态", () => {
  it("null → []（无筛选不渲染 chip）", () => {
    expect(deriveFilterChips(null, [field("f1", "标题")])).toEqual([]);
  });

  it("单层 and 多条件：每个直属条件一个 cond chip，path 为顶层索引", () => {
    const node = and(cond("f1", "is", "张三"), cond("f2", "contains", "湾区"));
    const chips = deriveFilterChips(node, [field("f1", "负责人"), field("f2", "城市")]);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({
      kind: "cond",
      path: [0],
      label: "负责人",
      opLabel: "是",
      valueText: "张三",
    });
    expect(chips[1]).toMatchObject({ kind: "cond", path: [1], label: "城市", opLabel: "包含" });
  });

  it("or 根同样只展直属一层", () => {
    const node = or(cond("f1", "is", "甲"), cond("f1", "is", "乙"));
    const chips = deriveFilterChips(node, [field("f1", "负责人")]);
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.path)).toEqual([[0], [1]]);
  });
});

describe("deriveFilterChips：嵌套折叠（不下钻）", () => {
  it("直属子组只出一个 group chip「条件组（N 项）」，内部条件不被展平", () => {
    const inner = and(cond("f1", "is", "甲"), cond("f2", "isEmpty", ""));
    const node = and(cond("f1", "is", "顶"), inner);
    const chips = deriveFilterChips(node, [field("f1", "负责人"), field("f2", "城市")]);
    expect(chips).toHaveLength(2);
    expect(chips[1]).toEqual({
      key: "group-1",
      path: [1],
      kind: "group",
      label: "条件组（2 项）",
    });
  });

  it("直属 not 出「排除条件」chip（path 顶层索引），不下钻", () => {
    const node = and(cond("f1", "is", "甲"), not(cond("f2", "is", "乙")));
    const chips = deriveFilterChips(node, [field("f1", "A"), field("f2", "B")]);
    expect(chips).toHaveLength(2);
    expect(chips[1]).toMatchObject({ kind: "group", label: "排除条件", path: [1] });
  });

  it("组内公式节点按整组 chip 处理（不展平）", () => {
    const node = and(cond("f1", "is", "甲"), formula("1 == 1"));
    const chips = deriveFilterChips(node, [field("f1", "A")]);
    expect(chips).toHaveLength(2);
    expect(chips[1]).toMatchObject({ kind: "group", label: "高级筛选条件", path: [1] });
  });

  it("根就是 not：出一个「排除条件」chip，path [0]", () => {
    const chips = deriveFilterChips(not(cond("f1", "is", "甲")), [field("f1", "A")]);
    expect(chips).toEqual([
      { key: "not-0", path: [0], kind: "group", label: "排除条件" },
    ]);
  });
});

describe("deriveFilterChips：formula 根", () => {
  it("formula 根 → 单个 formula chip（clearAll，path [0]）", () => {
    const chips = deriveFilterChips(formula("LEN([姓名]) > 2"), []);
    expect(chips).toEqual([
      {
        key: "formula-0",
        path: [0],
        kind: "formula",
        label: "高级筛选条件",
        clearAll: true,
      },
    ]);
  });
});

describe("deriveFilterChips：条件文案", () => {
  it("字段找不到 → label「未命名字段」，操作符按兜底文本类型取", () => {
    const chips = deriveFilterChips(and(cond("ghost", "is", "x")), []);
    expect(chips[0]!.label).toBe("未命名字段");
    expect(chips[0]!.opLabel).toBe("是");
  });

  it("dynamic/currentUser → 值「当前登录用户」", () => {
    const node = and(
      cond("f1", "is", "", { valueType: "dynamic", dynamicValue: "currentUser" }),
    );
    const chips = deriveFilterChips(node, [field("f1", "创建人", "createdBy")]);
    expect(chips[0]!.valueText).toBe("当前登录用户");
  });

  it("field 比较：值为比较字段名（valueFieldId），找不到回落「另一字段」", () => {
    const node = and(
      cond("f1", "eq", "", { valueType: "field", valueFieldId: "f2" }),
      cond("f1", "eq", "", { valueType: "field" }),
    );
    const chips = deriveFilterChips(node, [field("f1", "A", "number"), field("f2", "B", "number")]);
    expect(chips[0]!.valueText).toBe("B");
    expect(chips[1]!.valueText).toBe("另一字段");
  });

  it("singleSelect：option.id 映射选项名", () => {
    const f = selectField("f1", "状态", "singleSelect");
    const chips = deriveFilterChips(and(cond("f1", "is", "opt1")), [f]);
    expect(chips[0]!.valueText).toBe("进行中");
  });

  it("multiSelect：逗号分隔多 id 映射后用「、」连接，未知 id 原样兜底", () => {
    const f = selectField("f1", "状态", "multiSelect");
    const chips = deriveFilterChips(and(cond("f1", "isAnyOf", "opt1,opt2,optX")), [f]);
    expect(chips[0]!.valueText).toBe("进行中、已完成、optX");
  });

  it("literal 空白值不出值段；无需值操作符（isEmpty）不出值段", () => {
    const node = and(
      cond("f1", "is", "   "),
      cond("f1", "isEmpty", ""),
    );
    const chips = deriveFilterChips(node, [field("f1", "A")]);
    expect(chips[0]!.valueText).toBeUndefined();
    expect(chips[1]!.valueText).toBeUndefined();
  });
});

describe("removeFilterCondition：不可变删除与归一", () => {
  it("删顶层条件：返回新树，入参不被原地修改", () => {
    const node = and(cond("f1", "is", "甲"), cond("f2", "is", "乙"));
    const snapshot = JSON.parse(JSON.stringify(node));
    const next = removeFilterCondition(node, [1]);
    expect(next).toEqual(and(cond("f1", "is", "甲")));
    expect(node).toEqual(snapshot);
    expect(next).not.toBe(node);
  });

  it("删掉唯一条件后空 and 根归一 null", () => {
    expect(removeFilterCondition(and(cond("f1", "is", "甲")), [0])).toBeNull();
  });

  it("空 or 根保留（UI 口径：children.length>0 || kind!=='and'）", () => {
    expect(removeFilterCondition(or(cond("f1", "is", "甲")), [0])).toEqual({ kind: "or", children: [] });
  });

  it("删直属子组（含 not）：整组移除；删后空 and → null", () => {
    const node = and(cond("f1", "is", "甲"), and(cond("f2", "is", "乙")));
    expect(removeFilterCondition(node, [1])).toEqual(and(cond("f1", "is", "甲")));
    const onlyNot = and(not(cond("f2", "is", "乙")));
    expect(removeFilterCondition(onlyNot, [0])).toBeNull();
  });

  it("formula / not / 单条件根的顶层删除即清空（null）", () => {
    expect(removeFilterCondition(formula("1==1"), [0])).toBeNull();
    expect(removeFilterCondition(not(cond("f1", "is", "甲")), [0])).toBeNull();
    expect(removeFilterCondition(cond("f1", "is", "甲"), [0])).toBeNull();
  });

  it("空路径 / null 入参原样返回（不毁数据）", () => {
    const node = and(cond("f1", "is", "甲"));
    expect(removeFilterCondition(node, [])).toBe(node);
    expect(removeFilterCondition(null, [0])).toBeNull();
  });
});
