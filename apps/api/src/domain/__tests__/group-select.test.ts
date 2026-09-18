// 分组引擎对【选择类字段】的解析回归（M7 真机缺陷：optionId 泄漏到服务端出口）。
//
// 症状：按「状态」字段分组时，分组标题是 opt_xxx 而不是「进行中」，且颜色圆点恒空。
// 根因：computeGroups 缺少 singleSelect 专属分支，单选值落到文本兜底分支；
//      optionColor 只按 name 匹配，而落库值是 id。
// 本文件覆盖：id 解析 / name 兼容 / 多值字段 / 未知 id 退化 / 无 options 字段 / 空白桶。

import { describe, expect, it } from "vitest";
import {
  computeGroups,
  EMPTY_GROUP_KEY,
  EMPTY_GROUP_LABEL,
  type GroupFieldInfo,
  type GroupInput,
} from "../group.js";

const OPTIONS = [
  { id: "opt_todo", name: "待办", color: "#B58900" },
  { id: "opt_doing", name: "进行中", color: "#2684FF" },
  { id: "opt_done", name: "已完成", color: "#1D9E75" },
];

const STATUS: GroupFieldInfo = { id: "f_status", type: "singleSelect", options: OPTIONS };

/** 按给定顺序构造 GroupInput（recordIds 顺序决定未命中选项时的兜底排序）。 */
function inputOf(map: Record<string, unknown>, order?: string[]): GroupInput {
  const ids = order ?? Object.keys(map);
  return { recordIds: ids, get: (rid, _fid) => map[rid] };
}

const noAgg = () => ({});

describe("singleSelect 分组（id → 名称 + 颜色）", () => {
  it("标题是选项名、带选项颜色，并按 options 顺序排列", () => {
    const buckets = computeGroups(
      inputOf({ r1: "opt_doing", r2: "opt_todo", r3: "opt_done" }),
      STATUS,
      noAgg,
    );
    expect(buckets.map((b) => b.label)).toEqual(["待办", "进行中", "已完成"]);
    expect(buckets.map((b) => b.color)).toEqual(["#B58900", "#2684FF", "#1D9E75"]);
    // 键必须是稳定派生值（落库 id），不能把中文名字混进 key 里
    expect(buckets.map((b) => b.key)).toEqual(["opt:opt_todo", "opt:opt_doing", "opt:opt_done"]);
    expect(buckets.map((b) => b.recordIds)).toEqual([["r2"], ["r1"], ["r3"]]);
  });

  it("历史数据落库存的是选项名时，与 id 归并到同一桶（不做重复分组）", () => {
    const buckets = computeGroups(
      inputOf({ r1: "opt_doing", r2: "进行中" }),
      STATUS,
      noAgg,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.label).toBe("进行中");
    expect(buckets[0]!.color).toBe("#2684FF");
    expect(buckets[0]!.recordIds).toEqual(["r1", "r2"]);
  });

  it("未知 optionId（已删选项/脏数据）退化为原值且不崩，排在已知选项之后、空白桶之前", () => {
    const buckets = computeGroups(
      inputOf({ r1: "opt_doing", r2: "opt_ghost", r3: null }, ["r1", "r2", "r3"]),
      STATUS,
      noAgg,
    );
    expect(buckets.map((b) => b.label)).toEqual(["进行中", "opt_ghost", EMPTY_GROUP_LABEL]);
    expect(buckets[1]!.color).toBeNull(); // 颜色无从得知 -> 不臆造
    expect(buckets[2]!.key).toBe(EMPTY_GROUP_KEY);
  });

  it("字段未定义 options（异常结构）时不抛错，按原值分组", () => {
    const bare: GroupFieldInfo = { id: "f_status", type: "singleSelect", options: null };
    const buckets = computeGroups(inputOf({ r1: "opt_doing" }, ["r1"]), bare, noAgg);
    expect(buckets.map((b) => b.label)).toEqual(["opt_doing"]);
    expect(buckets[0]!.color).toBeNull();
  });
});

describe("multiSelect 分组", () => {
  const TAGS: GroupFieldInfo = { id: "f_tags", type: "multiSelect", options: OPTIONS };

  it("每个选项单独成桶，标题为选项名且带颜色；一条记录可落在多个桶", () => {
    const buckets = computeGroups(
      inputOf({ r1: ["opt_doing", "opt_done"], r2: ["opt_todo"] }),
      TAGS,
      noAgg,
    );
    expect(buckets.map((b) => b.label)).toEqual(["进行中", "已完成", "待办"]);
    expect(buckets.map((b) => b.color)).toEqual(["#2684FF", "#1D9E75", "#B58900"]);
    expect(buckets[0]!.recordIds).toContain("r1");
    expect(buckets[1]!.recordIds).toEqual(["r1"]);
  });

  it("数组中混入未知 id 时只解析可识别项，其余保留原值", () => {
    const buckets = computeGroups(inputOf({ r1: ["opt_ghost", "opt_todo"] }), TAGS, noAgg);
    expect(buckets.map((b) => b.label)).toEqual(["opt_ghost", "待办"]);
  });
});

describe("非选择类字段不回归", () => {
  it("checkbox 仍是「已勾选/未勾选」且与其颜色（按 checked 优先排序）", () => {
    const cb: GroupFieldInfo = { id: "f_cb", type: "checkbox" };
    const buckets = computeGroups(inputOf({ r1: false, r2: true }), cb, noAgg);
    expect(buckets.map((b) => b.label)).toEqual(["已勾选", "未勾选"]);
    expect(buckets[0]!.color).toBe("#1D9E75");
  });

  it("文本字段仍走文本化分支，key 前缀为 val:", () => {
    const txt: GroupFieldInfo = { id: "f_txt", type: "singleLineText" };
    const buckets = computeGroups(inputOf({ r1: "甲" }, ["r1"]), txt, noAgg);
    expect(buckets.map((b) => b.key)).toEqual(["val:甲"]);
    expect(buckets[0]!.label).toBe("甲");
  });
});
