import { describe, expect, it } from "vitest";
import type { ChartDatum } from "./chart-aggregate.js";
import {
  barGeometry,
  degToRad,
  horizontalBarGeometry,
  lineGeometry,
  maxAbsoluteValue,
  pieGeometry,
} from "./chart-geometry.js";

function datum(partial: Partial<ChartDatum> & { key: string }): ChartDatum {
  return {
    label: partial.key,
    value: null,
    count: 1,
    recordIds: [],
    ...partial,
  };
}

const sample: ChartDatum[] = [
  datum({ key: "a", value: 10 }),
  datum({ key: "b", value: 20 }),
  datum({ key: "c", value: null }),
  datum({ key: "d", value: -30 }),
];

describe("maxAbsoluteValue", () => {
  it("取绝对值最大者，忽略 null", () => {
    expect(maxAbsoluteValue(sample)).toBe(30);
  });

  it("空数组 / 全 null → 0", () => {
    expect(maxAbsoluteValue([])).toBe(0);
    expect(maxAbsoluteValue([datum({ key: "x", value: null })])).toBe(0);
  });
});

describe("barGeometry", () => {
  const W = 400;
  const H = 300;
  const PAD = 20;

  it("空数据 → 空数组", () => {
    expect(barGeometry([], W, H, PAD)).toEqual([]);
  });

  it("ratio 夹在 0~1，最大值满高，null/零值为 0", () => {
    const bars = barGeometry(sample, W, H, PAD);
    expect(bars).toHaveLength(4);
    for (const b of bars) {
      expect(b.ratio).toBeGreaterThanOrEqual(0);
      expect(b.ratio).toBeLessThanOrEqual(1);
    }
    expect(bars[3]!.ratio).toBeCloseTo(1); // |-30| 最大
    expect(bars[2]!.ratio).toBe(0); // null
  });

  it("坐标非负且全部落在绘图框内，柱宽为 slot 的 70%", () => {
    const bars = barGeometry(sample, W, H, PAD);
    const plotW = W - PAD * 2;
    const slot = plotW / sample.length;
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(PAD);
      expect(b.x + b.barWidth).toBeLessThanOrEqual(PAD + plotW);
      expect(b.y).toBeGreaterThanOrEqual(PAD);
      expect(b.y + b.barHeight).toBeLessThanOrEqual(H - PAD);
      expect(b.barWidth).toBeCloseTo(slot * 0.7);
    }
  });

  it("maxAbs=0 时所有柱高度为 0 但仍返回合法坐标", () => {
    const zeros = [datum({ key: "a", value: 0 }), datum({ key: "b", value: null })];
    const bars = barGeometry(zeros, W, H, PAD);
    expect(bars.every((b) => b.barHeight === 0 && b.ratio === 0)).toBe(true);
    expect(bars[0]!.y).toBe(H - PAD);
  });
});

describe("horizontalBarGeometry", () => {
  const W = 400;
  const H = 300;
  const PAD = 20;

  it("空数据 → 空数组", () => {
    expect(horizontalBarGeometry([], W, H, PAD)).toEqual([]);
  });

  it("ratio 夹在 0~1，最大值满长，null/零值为 0", () => {
    const bars = horizontalBarGeometry(sample, W, H, PAD);
    expect(bars).toHaveLength(4);
    for (const b of bars) {
      expect(b.ratio).toBeGreaterThanOrEqual(0);
      expect(b.ratio).toBeLessThanOrEqual(1);
    }
    expect(bars[3]!.ratio).toBeCloseTo(1); // |-30| 最大
    expect(bars[2]!.ratio).toBe(0); // null
  });

  it("坐标全部落在绘图框内，条厚为纵向 slot 的 70%，x 恒为左基线", () => {
    const bars = horizontalBarGeometry(sample, W, H, PAD);
    const plotH = H - PAD * 2;
    const slot = plotH / sample.length;
    for (const b of bars) {
      expect(b.x).toBe(PAD);
      expect(b.x + b.barLength).toBeLessThanOrEqual(W - PAD);
      expect(b.y).toBeGreaterThanOrEqual(PAD);
      expect(b.y + b.barHeight).toBeLessThanOrEqual(H - PAD);
      expect(b.barHeight).toBeCloseTo(slot * 0.7);
    }
  });

  it("maxAbs=0 时所有条长度为 0 但仍返回合法坐标", () => {
    const zeros = [datum({ key: "a", value: 0 }), datum({ key: "b", value: null })];
    const bars = horizontalBarGeometry(zeros, W, H, PAD);
    expect(bars.every((b) => b.barLength === 0 && b.ratio === 0)).toBe(true);
    expect(bars[0]!.x).toBe(PAD);
  });
});

describe("pieGeometry", () => {
  it("总和为 0 / 空数组 → 空数组", () => {
    expect(pieGeometry([], 100, 100, 50)).toEqual([]);
    expect(
      pieGeometry([datum({ key: "a", value: 0 }), datum({ key: "b", value: null })], 100, 100, 50),
    ).toEqual([]);
  });

  it("各片角度首尾相接且总和收敛到 2π，path 非空", () => {
    const data: ChartDatum[] = [
      datum({ key: "a", value: 1 }),
      datum({ key: "b", value: 2 }),
      datum({ key: "c", value: 3 }),
    ];
    const slices = pieGeometry(data, 100, 100, 50);
    expect(slices).toHaveLength(3);
    expect(slices[0]!.startAngle).toBeCloseTo(degToRad(-90));
    expect(slices[2]!.endAngle).toBeCloseTo(degToRad(-90) + Math.PI * 2);
    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i]!.startAngle).toBeCloseTo(slices[i - 1]!.endAngle);
    }
    for (const s of slices) {
      expect(s.path).toContain("M 100 100");
      expect(s.path).toContain("A 50 50");
      expect(s.path.endsWith("Z")).toBe(true);
    }
  });

  it("null 值片角度为 0（首尾角相等）但仍占位", () => {
    const data: ChartDatum[] = [
      datum({ key: "a", value: 10 }),
      datum({ key: "b", value: null }),
    ];
    const slices = pieGeometry(data, 50, 50, 25);
    expect(slices[1]!.startAngle).toBeCloseTo(slices[1]!.endAngle);
  });
});

describe("lineGeometry", () => {
  const W = 300;
  const H = 200;
  const PAD = 10;

  it("空数据 → 空数组", () => {
    expect(lineGeometry([], W, H, PAD)).toEqual([]);
  });

  it("null 桶不出点，有效点 x 均布在绘图区内", () => {
    const points = lineGeometry(sample, W, H, PAD);
    expect(points.map((p) => p.index)).toEqual([0, 1, 3]);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(PAD);
      expect(p.x).toBeLessThanOrEqual(W - PAD);
      expect(p.y).toBeGreaterThanOrEqual(PAD);
      expect(p.y).toBeLessThanOrEqual(H - PAD);
    }
  });

  it("单点落在绘图区水平中点，最大值贴近顶部", () => {
    const one = lineGeometry([datum({ key: "a", value: 5 })], W, H, PAD);
    expect(one).toHaveLength(1);
    expect(one[0]!.x).toBeCloseTo(PAD + (W - PAD * 2) / 2);
    expect(one[0]!.y).toBeCloseTo(PAD);
  });

  it("零值点落在底边基线", () => {
    const points = lineGeometry([datum({ key: "a", value: 0 })], W, H, PAD);
    expect(points[0]!.y).toBe(H - PAD);
  });
});
