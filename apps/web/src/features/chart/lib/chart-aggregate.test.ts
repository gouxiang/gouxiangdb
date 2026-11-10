import { describe, expect, it } from "vitest";
import type { FieldDTO, FieldType, RecordDTO, SelectOption } from "@gx/shared-types";
import { canBeChartDimensionField, canBeChartMetricField } from "@gx/shared-types";
import {
  CHART_EMPTY_KEY,
  CHART_EMPTY_LABEL,
  buildChartData,
  computeMetric,
  dimensionKey,
  dimensionLabel,
  toNum,
} from "./chart-aggregate.js";

function rec(id: string, fields: Record<string, unknown>): RecordDTO {
  return { id, tableId: "t1", fields, createdAt: "" } as unknown as RecordDTO;
}

function field(id: string, type: FieldType, options?: SelectOption[]): FieldDTO {
  return { id, type, options: options ?? null } as unknown as FieldDTO;
}

const selectField = field("f_sel", "singleSelect", [
  { id: "opt_a", name: "进行中", color: "" },
  { id: "opt_b", name: "已完成", color: "" },
]);

describe("toNum（同构后端 aggregate.ts:9-15）", () => {
  it("有限 number 直通，NaN/Infinity 回落 null", () => {
    expect(toNum(42)).toBe(42);
    expect(toNum(-3.5)).toBe(-3.5);
    expect(toNum(Number.NaN)).toBeNull();
    expect(toNum(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("boolean → 1/0", () => {
    expect(toNum(true)).toBe(1);
    expect(toNum(false)).toBe(0);
  });

  it("null/undefined/空串 → null", () => {
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
    expect(toNum("")).toBeNull();
  });

  it("字符串去逗号与空白后强转，非法 → null", () => {
    expect(toNum("1,234")).toBe(1234);
    expect(toNum(" 12 ")).toBe(12);
    expect(toNum("abc")).toBeNull();
  });
});

describe("dimensionKey / dimensionLabel", () => {
  it("四类空值（null/undefined/空串/空数组）统一落 __empty__ 桶与 (空白) 标签", () => {
    const f = field("f_text", "singleLineText");
    for (const empty of [null, undefined, "", []]) {
      expect(dimensionKey(empty)).toBe(CHART_EMPTY_KEY);
      expect(dimensionLabel(empty, f)).toBe(CHART_EMPTY_LABEL);
    }
  });

  it("无键对象按空值口径处理", () => {
    const f = field("f_text", "singleLineText");
    expect(dimensionKey({})).toBe(CHART_EMPTY_KEY);
    expect(dimensionLabel({}, f)).toBe(CHART_EMPTY_LABEL);
  });

  it("标量统一字符串化（number/boolean 也成字符串桶）", () => {
    const f = field("f_num", "number");
    expect(dimensionKey(42)).toBe("42");
    expect(dimensionLabel(42, f)).toBe("42");
    expect(dimensionKey(true)).toBe("true");
  });

  it("singleSelect 按 options id→name 映射，查不到回落显示 id", () => {
    expect(dimensionLabel("opt_a", selectField)).toBe("进行中");
    expect(dimensionLabel("opt_gone", selectField)).toBe("opt_gone");
    expect(dimensionKey("opt_a")).toBe("opt_a");
  });

  it("multiSelect 数组按顿号连接标签，key 排序后稳定（同集合不同顺序同桶）", () => {
    const multi = field("f_multi", "multiSelect", [
      { id: "o1", name: "一", color: "" },
      { id: "o2", name: "二", color: "" },
    ]);
    expect(dimensionLabel(["o1", "o2"], multi)).toBe("一、 二");
    expect(dimensionKey(["o2", "o1"])).toBe(dimensionKey(["o1", "o2"]));
  });

  it("非空数组但元素全为空（[''] / [null]）并入 __empty__，不产生空串幽灵桶", () => {
    const multi = field("f_multi", "multiSelect");
    expect(dimensionKey([""])).toBe(CHART_EMPTY_KEY);
    expect(dimensionKey([null])).toBe(CHART_EMPTY_KEY);
    expect(dimensionLabel([""], multi)).toBe(CHART_EMPTY_LABEL);
    expect(dimensionLabel([null], multi)).toBe(CHART_EMPTY_LABEL);
  });

  it("数组桶 key 使用不可见分隔符，拼接碰撞的两组元素不会同桶", () => {
    expect(dimensionKey(["o1", "o2"])).not.toBe(dimensionKey(["o1o", "2"]));
  });
});

describe("computeMetric（同构后端 aggregate.ts:18-44）", () => {
  it("count 不挑指标字段，字符串/对象也计入总数", () => {
    expect(computeMetric("count", ["a", "", null, 1, {}])).toBe(5);
  });

  it("sum/avg/min/max 只看可转数值，空数值数组 → null", () => {
    expect(computeMetric("sum", [1, 2, "x", null])).toBe(3);
    expect(computeMetric("avg", [2, 4])).toBe(3);
    expect(computeMetric("min", [3, 1, 2])).toBe(1);
    expect(computeMetric("max", [3, 1, 2])).toBe(3);
    expect(computeMetric("sum", ["x", null])).toBeNull();
    expect(computeMetric("max", [])).toBeNull();
  });

  it("percentEmpty / percentFilled：total=0 → null，否则互补为 100", () => {
    expect(computeMetric("percentEmpty", [])).toBeNull();
    expect(computeMetric("percentFilled", [])).toBeNull();
    const vals = [1, null, "", 4];
    const pe = computeMetric("percentEmpty", vals) ?? 0;
    const pf = computeMetric("percentFilled", vals) ?? 0;
    expect(pe + pf).toBeCloseTo(100);
  });

  it("countFilled + countEmpty 恒等于 total", () => {
    const vals = [1, null, "", [], "x", 0];
    const ce = computeMetric("countEmpty", vals) ?? 0;
    const cf = computeMetric("countFilled", vals) ?? 0;
    expect(ce + cf).toBe(vals.length);
  });
});

describe("buildChartData", () => {
  const dim = field("f_dim", "singleLineText");
  const records: RecordDTO[] = [
    rec("r1", { f_dim: "苹果", f_m: 10 }),
    rec("r2", { f_dim: "香蕉", f_m: 20 }),
    rec("r3", { f_dim: "苹果", f_m: 30 }),
    rec("r4", { f_dim: null, f_m: 5 }),
    rec("r5", { f_dim: "", f_m: 7 }),
  ];

  it("维度字段缺失（null）→ 空数组，不造假桶", () => {
    expect(buildChartData({ records, dimensionField: null, metricFieldId: "f_m", aggFunc: "sum" })).toEqual([]);
  });

  it("按首次出现顺序保序分桶，空值合并进同一个 __empty__ 桶", () => {
    const data = buildChartData({ records, dimensionField: dim, metricFieldId: "f_m", aggFunc: "sum" });
    expect(data.map((d) => d.key)).toEqual(["苹果", "香蕉", CHART_EMPTY_KEY]);
    const none = data.find((d) => d.key === CHART_EMPTY_KEY)!;
    expect(none.label).toBe(CHART_EMPTY_LABEL);
    expect(none.count).toBe(2);
    expect(none.recordIds).toEqual(["r4", "r5"]);
  });

  it("sum 桶值正确，recordIds 保持入参相对顺序", () => {
    const data = buildChartData({ records, dimensionField: dim, metricFieldId: "f_m", aggFunc: "sum" });
    expect(data.find((d) => d.key === "苹果")!.value).toBe(40);
    expect(data.find((d) => d.key === "香蕉")!.recordIds).toEqual(["r2"]);
  });

  it("metricFieldId=null：count 返回桶大小，sum 无数值入参 → null", () => {
    const counted = buildChartData({ records, dimensionField: dim, metricFieldId: null, aggFunc: "count" });
    expect(counted.find((d) => d.key === "苹果")!.value).toBe(2);
    const summed = buildChartData({ records, dimensionField: dim, metricFieldId: null, aggFunc: "sum" });
    expect(summed.every((d) => d.value === null)).toBe(true);
  });

  it("singleSelect 维度桶标签走选项名", () => {
    const rs = [rec("a", { f_sel: "opt_a" }), rec("b", { f_sel: "opt_b" }), rec("c", { f_sel: null })];
    const data = buildChartData({ records: rs, dimensionField: selectField, metricFieldId: null, aggFunc: "count" });
    expect(data.map((d) => d.label)).toEqual(["进行中", "已完成", CHART_EMPTY_LABEL]);
  });
});

describe("canBeChartDimensionField / canBeChartMetricField（shared-types 单源分组）", () => {
  it("维度：text/number/date/bool/select 可作维度，link/attachment/container 不可", () => {
    expect(canBeChartDimensionField("singleLineText")).toBe(true);
    expect(canBeChartDimensionField("number")).toBe(true);
    expect(canBeChartDimensionField("date")).toBe(true);
    expect(canBeChartDimensionField("checkbox")).toBe(true);
    expect(canBeChartDimensionField("singleSelect")).toBe(true);
    expect(canBeChartDimensionField("links")).toBe(false);
    expect(canBeChartDimensionField("lookup")).toBe(false);
    expect(canBeChartDimensionField("attachment")).toBe(false);
    expect(canBeChartDimensionField("tabs")).toBe(false);
    expect(canBeChartDimensionField("member")).toBe(false);
  });

  it("指标：仅数值族（number/currency/percent/duration/rating）可作指标", () => {
    expect(canBeChartMetricField("number")).toBe(true);
    expect(canBeChartMetricField("currency")).toBe(true);
    expect(canBeChartMetricField("percent")).toBe(true);
    expect(canBeChartMetricField("singleLineText")).toBe(false);
    expect(canBeChartMetricField("singleSelect")).toBe(false);
    expect(canBeChartMetricField("date")).toBe(false);
    expect(canBeChartMetricField("checkbox")).toBe(false);
  });
});
