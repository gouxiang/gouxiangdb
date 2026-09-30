import { describe, expect, it } from "vitest";
import {
  buildGanttLayout,
  dateFromPx,
  diffDays,
  parseDay,
  progressRatio,
  taskLeftPx,
  taskWidthPx,
} from "./gantt-scale.js";

describe("parseDay", () => {
  it("YYYY-MM-DD 按本地午夜", () => {
    const d = parseDay("2026-03-18");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getHours()).toBe(0);
  });

  it("非法/空 -> null", () => {
    expect(parseDay("")).toBeNull();
    expect(parseDay("not-a-date")).toBeNull();
    expect(parseDay(null)).toBeNull();
  });

  it("带时间 ISO 取日期部分", () => {
    const d = parseDay("2026-03-18T15:30:00");
    expect(d!.getDate()).toBe(18);
  });
});

describe("diffDays", () => {
  it("整天差", () => {
    expect(diffDays(new Date("2026-03-20T00:00"), new Date("2026-03-18T00:00"))).toBe(2);
  });
});

describe("progressRatio", () => {
  it("百分数 /100", () => {
    expect(progressRatio(50)).toBeCloseTo(0.5);
  });
  it("number<=1 原样", () => {
    expect(progressRatio(0.3)).toBeCloseTo(0.3);
  });
  it("夹到 0~1，空为 0", () => {
    expect(progressRatio(200)).toBe(1);
    expect(progressRatio("")).toBe(0);
  });
});

describe("layout geometry", () => {
  const layout = buildGanttLayout(
    new Date("2026-03-01T00:00"),
    new Date("2026-03-10T00:00"),
    "day",
  );

  it("原点早于最早开始（留白），总宽为正", () => {
    expect(layout.origin.getTime()).toBeLessThan(
      new Date("2026-03-01T00:00").getTime(),
    );
    expect(layout.widthPx).toBeGreaterThan(0);
  });

  it("任务条左/宽随日期", () => {
    const start = new Date("2026-03-01T00:00");
    const end = new Date("2026-03-03T00:00");
    const left = taskLeftPx(layout, start);
    const width = taskWidthPx(layout, start, end);
    expect(left).toBeGreaterThanOrEqual(0);
    // 3 天宽（1~3 号）。
    expect(width / layout.pxPerDay).toBeCloseTo(3);
  });

  it("dateFromPx 与 taskLeftPx 互逆（按天吸附）", () => {
    const start = new Date("2026-03-05T00:00");
    const x = taskLeftPx(layout, start);
    const back = dateFromPx(layout, x);
    expect(diffDays(back, start)).toBe(0);
  });
});
