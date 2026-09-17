// M5/S13 纯函数层测试（m5-bench-lib：族比例/内存守卫/线性外推/EXPLAIN 断言/CLI 解析）。

import { describe, expect, it } from "vitest";
import {
  assertNoFullRecall, decideMemory, estimateVectorBytes, kiloLabel, linearFit, parseBenchArgs,
  parseNumberList, planFamilyMix, roundStats, scaleLabel, smoothChunkLimit,
} from "../m5-bench-lib.js";

describe("planFamilyMix：三族 chunk 目标", () => {
  it("三族之和恰等于总量，且 record>doc>canvas（默认权重）", () => {
    const m = planFamilyMix(100_000);
    expect(m.record + m.doc + m.canvas).toBe(100_000);
    expect(m.record).toBeGreaterThan(m.doc);
    expect(m.doc).toBeGreaterThan(m.canvas);
  });

  it("小总量不出现负数/超量（末族收口）", () => {
    for (const n of [0, 1, 3, 7, 100]) {
      const m = planFamilyMix(n);
      expect(m.record + m.doc + m.canvas).toBe(n);
      expect(Math.min(m.record, m.doc, m.canvas)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("estimateVectorBytes / decideMemory", () => {
  it("向量账 = N×dim×4", () => {
    expect(estimateVectorBytes(100_000, 1536)).toBe(100_000 * 1536 * 4);
  });

  it("可用内存不足（含余量）-> 不 ok 且 reason=insufficient_memory", () => {
    const v = decideMemory(100 * 1024 * 1024, 200 * 1024 * 1024, 512 * 1024 * 1024);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("insufficient_memory");
  });

  it("可用内存充足 -> ok 且无 reason", () => {
    const v = decideMemory(4 * 1024 * 1024 * 1024, 200 * 1024 * 1024, 512 * 1024 * 1024);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeUndefined();
  });
});

describe("linearFit / smoothChunkLimit：可流畅上限外推", () => {
  it("线性点集拟合精确", () => {
    const m = linearFit([{ x: 0, y: 10 }, { x: 100, y: 110 }]);
    expect(m.a).toBeCloseTo(10, 6);
    expect(m.b).toBeCloseTo(1, 6);
  });

  it("单调上升：解 a + b·N = target 得上限", () => {
    // p95 = 10 + 0.001·N；target 110 -> N=100000
    const s = smoothChunkLimit([{ chunks: 1000, p95Ms: 11 }, { chunks: 10000, p95Ms: 20 }], 110);
    expect(s.limit).toBeCloseTo(100_000, -2);
    expect(s.extrapolated).toBe(true);
  });

  it("斜率 ≤0 -> 上限 null 且说明在已测规模内未达阈值", () => {
    const s = smoothChunkLimit([{ chunks: 1000, p95Ms: 30 }, { chunks: 10000, p95Ms: 30 }], 500);
    expect(s.limit).toBeNull();
    expect(s.note).toMatch(/未达/);
  });

  it("最小档已超阈值 -> 上限小于最小已测档并给出降维提示", () => {
    const s = smoothChunkLimit([{ chunks: 1000, p95Ms: 900 }, { chunks: 10000, p95Ms: 1500 }], 500);
    expect(s.limit).not.toBeNull();
    expect(s.limit!).toBeLessThan(1000);
    expect(s.note).toMatch(/降维|缩小 scope/);
  });
});

describe("assertNoFullRecall：EXPLAIN 铁律断言", () => {
  it("vec 计划含 LIST SUBQUERY + temp_scope、fts 含 temp_scope -> OK", () => {
    const v = assertNoFullRecall({
      fts: ["SCAN fts_chunks VIRTUAL TABLE", "SEARCH s USING COVERING INDEX sqlite_autoindex_temp_scope_x_1 (nodeId=?)"],
      vec: ["SCAN vec_chunks VIRTUAL TABLE", "LIST SUBQUERY 5", "SEARCH s USING COVERING INDEX sqlite_autoindex_temp_scope_x_1 (nodeId=?)"],
    });
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it("vec 缺 LIST SUBQUERY（疑似先全量 KNN）-> FAIL 且列出缺项", () => {
    const v = assertNoFullRecall({ vec: ["SCAN vec_chunks VIRTUAL TABLE", "SEARCH s ... temp_scope_x ..."] });
    expect(v.ok).toBe(false);
    expect(v.missing.join()).toMatch(/LIST SUBQUERY/);
  });

  it("fts 缺 temp_scope -> FAIL", () => {
    const v = assertNoFullRecall({ fts: ["SCAN fts_chunks VIRTUAL TABLE"] });
    expect(v.ok).toBe(false);
    expect(v.missing.join()).toMatch(/temp_scope/);
  });
});

describe("CLI 解析与规模标签", () => {
  it("--k v 与裸 flag；不吞后续 flag", () => {
    const a = parseBenchArgs(["--sizes", "1000,10000", "--force", "--rounds", "10"]);
    expect(a.sizes).toBe("1000,10000");
    expect(a.force).toBe("true");
    expect(a.rounds).toBe("10");
  });

  it("parseNumberList：去重升序、非法项丢弃、空则回落", () => {
    expect(parseNumberList("10000,1000,x,1000,-5", [7])).toEqual([1000, 10000]);
    expect(parseNumberList(undefined, [1, 2])).toEqual([1, 2]);
    expect(parseNumberList("", [9])).toEqual([9]);
  });

  it("scaleLabel / kiloLabel", () => {
    expect(scaleLabel(1000)).toBe("1k");
    expect(scaleLabel(10000)).toBe("10k");
    expect(scaleLabel(100000)).toBe("100k");
    // kiloLabel 无碰撞：20k/50k 不撞 10k
    expect(kiloLabel(1000)).toBe("1k");
    expect(kiloLabel(20000)).toBe("20k");
    expect(kiloLabel(50000)).toBe("50k");
    expect(kiloLabel(1500)).toBe("1500");
  });

  it("roundStats 复用 stats 口径（p95=最近秩）", () => {
    const r = roundStats([5, 1, 3, 2, 4]);
    expect(r.p50Ms).toBe(3);
    expect(r.maxMs).toBe(5);
    expect(r.minMs).toBe(1);
    expect(r.rounds).toBe(5);
  });
});
