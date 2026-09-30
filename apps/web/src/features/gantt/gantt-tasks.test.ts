import { describe, expect, it } from "vitest";
import type { RecordDTO } from "@gx/shared-types";
import { buildGanttLayout } from "./gantt-scale.js";
import {
  dependencyIds,
  extractTasks,
  taskRange,
  type GanttFieldKeys,
} from "./gantt-tasks.js";

function rec(id: string, fields: Record<string, unknown>): RecordDTO {
  return { id, tableId: "t1", fields, createdAt: "" } as unknown as RecordDTO;
}

const records: RecordDTO[] = [
  rec("r1", {
    f_title: "设计",
    f_start: "2026-03-01",
    f_end: "2026-03-03",
    f_prog: 50,
    f_dep: [],
  }),
  rec("r2", {
    f_title: "开发",
    f_start: "2026-03-04",
    f_end: "2026-03-08",
    f_prog: 0,
    f_dep: [{ tableId: "t1", recordId: "r1" }],
  }),
  rec("r3", {
    f_title: "无开始",
    f_start: "",
    f_end: "2026-03-09",
    f_prog: 0,
    f_dep: [],
  }),
];

const keys: GanttFieldKeys = {
  startFieldId: "f_start",
  endFieldId: "f_end",
  progressFieldId: "f_prog",
  dependencyFieldId: "f_dep",
  titleFieldId: "f_title",
};

describe("dependencyIds", () => {
  it("只取同表关联 recordId", () => {
    const v = [
      { tableId: "t1", recordId: "r1" },
      { tableId: "other", recordId: "r9" },
    ];
    expect(dependencyIds(v, "t1")).toEqual(["r1"]);
  });
});

describe("taskRange", () => {
  it("最早开始/最晚结束", () => {
    const range = taskRange(records, "f_start", "f_end");
    expect(range).not.toBeNull();
    expect(range!.min.getDate()).toBe(1);
    expect(range!.max.getDate()).toBe(8);
  });

  it("无开始字段 -> null", () => {
    expect(taskRange(records, null, null)).toBeNull();
  });
});

describe("extractTasks", () => {
  const layout = buildGanttLayout(
    new Date("2026-03-01T00:00"),
    new Date("2026-03-08T00:00"),
    "day",
  );
  const tasks = extractTasks(records, keys, layout);

  it("跳过无开始任务", () => {
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id)).not.toContain("r3");
  });

  it("解析标题/进度/依赖", () => {
    const t1 = tasks.find((t) => t.id === "r1")!;
    expect(t1.title).toBe("设计");
    expect(t1.progress).toBeCloseTo(0.5);
    expect(t1.dependsOn).toEqual([]);

    const t2 = tasks.find((t) => t.id === "r2")!;
    expect(t2.dependsOn).toEqual(["r1"]);
  });

  it("几何宽度为正", () => {
    for (const t of tasks) {
      expect(t.leftPx).toBeGreaterThanOrEqual(0);
      expect(t.widthPx).toBeGreaterThan(0);
    }
  });

  it("结束早于开始时交换", () => {
    const weird = [
      rec("w1", {
        f_start: "2026-03-10",
        f_end: "2026-03-05",
        f_title: "x",
      }),
    ];
    const out = extractTasks(weird, keys, layout);
    expect(out[0].start.getDate()).toBe(5);
    expect(out[0].end.getDate()).toBe(10);
  });
});
