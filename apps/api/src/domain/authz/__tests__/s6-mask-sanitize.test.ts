// M4/S6 sanitizeViewConfigForMask 纯函数表驱动单测（不碰库）：
// 隐藏字段引用必须在【查询发生之前】从视图配置抹掉，且与 compile 兜底共用同一份脱敏结果。
//  - 条件叶隐藏 -> 删除；AND 收窄余项；OR/NOT 任一分支引用隐藏字段 -> 整树失效(null)；
//  - sorts 隐藏列删除；aggregations 隐藏列删除；groupByFieldId 隐藏 -> null；
//  - 可见引用原样保留（含 value/op 不被改动）；visible=全可见集时配置恒等。

import { describe, expect, it } from "vitest";
import type { FilterNode, ViewConfig } from "@gx/shared-types";
import { sanitizeViewConfigForMask } from "../fieldMask.js";

const cond = (fieldId: string, op = "is", value = "x"): FilterNode =>
  ({ kind: "condition", fieldId, op, value }) as FilterNode;

function baseConfig(over: Partial<ViewConfig>): ViewConfig {
  return {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
    ...over,
  };
}

const VISIBLE = new Set(["f1", "f2", "f3"]);

describe("sanitizeViewConfigForMask filters", () => {
  it("单个隐藏条件叶 -> filters=null（可见叶原样）", () => {
    const out = sanitizeViewConfigForMask(baseConfig({ filters: cond("secret") }), VISIBLE);
    expect(out.filters).toBeNull();
    const keep = sanitizeViewConfigForMask(baseConfig({ filters: cond("f1", "contains", "abc") }), VISIBLE);
    expect(keep.filters).toEqual(cond("f1", "contains", "abc"));
  });

  it("AND：隐藏叶删除，其余子句收窄保留；全隐藏 -> null", () => {
    const tree: FilterNode = { kind: "and", children: [cond("f1", "eq", "1"), cond("secret", "eq", "2")] };
    const out = sanitizeViewConfigForMask(baseConfig({ filters: tree }), VISIBLE);
    expect(out.filters).toEqual(cond("f1", "eq", "1"));
    const allHidden = sanitizeViewConfigForMask(
      baseConfig({ filters: { kind: "and", children: [cond("secret"), cond("secret2")] } }),
      VISIBLE,
    );
    expect(allHidden.filters).toBeNull();
  });

  it("OR：任一分支引用隐藏字段 -> 整棵 OR 失效（不可安全收窄，隐藏分支真值未知）", () => {
    const tree: FilterNode = { kind: "or", children: [cond("f1"), cond("secret")] };
    const out = sanitizeViewConfigForMask(baseConfig({ filters: tree }), VISIBLE);
    expect(out.filters).toBeNull();
    // 全可见 OR 原样
    const ok = sanitizeViewConfigForMask(
      baseConfig({ filters: { kind: "or", children: [cond("f1"), cond("f2")] } }),
      VISIBLE,
    );
    expect(ok.filters).toEqual({ kind: "or", children: [cond("f1"), cond("f2")] });
  });

  it("NOT：子树引用隐藏字段 -> 整体失效；子树全可见原样", () => {
    const out = sanitizeViewConfigForMask(
      baseConfig({ filters: { kind: "not", child: cond("secret") } }),
      VISIBLE,
    );
    expect(out.filters).toBeNull();
    const ok = sanitizeViewConfigForMask(
      baseConfig({ filters: { kind: "not", child: cond("f1") } }),
      VISIBLE,
    );
    expect(ok.filters).toEqual({ kind: "not", child: cond("f1") });
  });

  it("嵌套 AND(OR(...)) 深层隐藏引用按同一规则向上收窄", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [
        cond("f1"),
        { kind: "or", children: [cond("f2"), cond("secret")] },
        cond("f3", "contains", "z"),
      ],
    };
    const out = sanitizeViewConfigForMask(baseConfig({ filters: tree }), VISIBLE);
    // OR 整体失效后 AND 收窄为两个可见叶
    expect(out.filters).toEqual({ kind: "and", children: [cond("f1"), cond("f3", "contains", "z")] });
  });
});

describe("sanitizeViewConfigForMask sorts/aggregations/groupBy", () => {
  it("sorts 隐藏列删除，可见列保留方向", () => {
    const out = sanitizeViewConfigForMask(
      baseConfig({ sorts: [{ fieldId: "f1", direction: "asc" }, { fieldId: "secret", direction: "desc" }] }),
      VISIBLE,
    );
    expect(out.sorts).toEqual([{ fieldId: "f1", direction: "asc" }]);
  });

  it("aggregations 隐藏列删除（不能借表尾聚合泄漏隐藏列统计）", () => {
    const out = sanitizeViewConfigForMask(
      baseConfig({ aggregations: { f1: "sum", secret: "avg", f2: "max" } }),
      VISIBLE,
    );
    expect(out.aggregations).toEqual({ f1: "sum", f2: "max" });
  });

  it("groupByFieldId 隐藏 -> null（不产生掩码字段分组桶）；可见保留", () => {
    expect(sanitizeViewConfigForMask(baseConfig({ groupByFieldId: "secret" }), VISIBLE).groupByFieldId).toBeNull();
    expect(sanitizeViewConfigForMask(baseConfig({ groupByFieldId: "f1" }), VISIBLE).groupByFieldId).toBe("f1");
  });

  it("全可见集（visibleAll 口径调用方传全集）时配置恒等，且不改输入对象", () => {
    const cfg = baseConfig({
      filters: { kind: "and", children: [cond("f1"), cond("secret")] },
      sorts: [{ fieldId: "secret", direction: "asc" }],
      aggregations: { secret: "sum" },
      groupByFieldId: "secret",
      search: "保持",
    });
    const snapshot = JSON.parse(JSON.stringify(cfg)) as ViewConfig;
    const out = sanitizeViewConfigForMask(cfg, new Set(["f1", "f2", "f3", "secret"]));
    expect(out).toEqual(snapshot);
    expect(cfg).toEqual(snapshot); // 输入不被原地修改
  });
});
