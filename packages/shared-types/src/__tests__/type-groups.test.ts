// packages/shared-types/src/__tests__/type-groups.test.ts
import { describe, it, expect } from "vitest";
import {
  fieldTypeGroup,
  isTypeAssignable,
  isTypeComparable,
  checkSubtableCompatibility,
  rollupAggOptions,
} from "../type-groups.js";

describe("fieldTypeGroup", () => {
  it("文本类字段归入 text", () => {
    for (const t of ["singleLineText", "longText", "richText", "email", "url", "phone", "json", "autoNumber"] as const) {
      expect(fieldTypeGroup(t)).toBe("text");
    }
  });
  it("数字类归入 number", () => {
    for (const t of ["number", "currency", "percent", "duration", "rating"] as const) {
      expect(fieldTypeGroup(t)).toBe("number");
    }
  });
  it("日期类归入 date", () => {
    for (const t of ["date", "datetime", "createdTime", "lastModifiedTime"] as const) {
      expect(fieldTypeGroup(t)).toBe("date");
    }
  });
  it("选项归 select，布尔归 bool", () => {
    expect(fieldTypeGroup("singleSelect")).toBe("select");
    expect(fieldTypeGroup("multiSelect")).toBe("select");
    expect(fieldTypeGroup("checkbox")).toBe("bool");
  });
  it("关联/计算/容器归各自组", () => {
    expect(fieldTypeGroup("links")).toBe("link");
    expect(fieldTypeGroup("subtable")).toBe("link");
    expect(fieldTypeGroup("attachment")).toBe("attachment");
    expect(fieldTypeGroup("tabs")).toBe("container");
  });
});

describe("isTypeAssignable（默认值/查阅取值兼容）", () => {
  it("同组兼容", () => {
    expect(isTypeAssignable("singleLineText", "email")).toBe(true);
    expect(isTypeAssignable("number", "currency")).toBe(true);
    expect(isTypeAssignable("date", "datetime")).toBe(true);
    expect(isTypeAssignable("checkbox", "checkbox")).toBe(true);
  });
  it("跨组不兼容：文本字段不能关联数字/日期", () => {
    expect(isTypeAssignable("singleLineText", "number")).toBe(false);
    expect(isTypeAssignable("singleLineText", "date")).toBe(false);
    expect(isTypeAssignable("number", "singleLineText")).toBe(false);
  });
  it("选项不与文本互通（选项存 id）", () => {
    expect(isTypeAssignable("singleSelect", "singleLineText")).toBe(false);
    expect(isTypeAssignable("singleLineText", "singleSelect")).toBe(false);
    expect(isTypeAssignable("singleSelect", "multiSelect")).toBe(false);
  });
  it("关联/子表格/附件/容器不能作为标量取值源（杜绝子表格关联文本字段类 bug）", () => {
    expect(isTypeAssignable("singleLineText", "links")).toBe(false);
    expect(isTypeAssignable("singleLineText", "subtable")).toBe(false);
    expect(isTypeAssignable("singleLineText", "attachment")).toBe(false);
    expect(isTypeAssignable("number", "tabs")).toBe(false);
  });
});

describe("isTypeComparable（筛选匹配字段）", () => {
  it("同组可比较", () => {
    expect(isTypeComparable("number", "currency")).toBe(true);
    expect(isTypeComparable("date", "datetime")).toBe(true);
  });
  it("跨组不可比较", () => {
    expect(isTypeComparable("number", "singleLineText")).toBe(false);
    expect(isTypeComparable("checkbox", "number")).toBe(false);
  });
  it("关联/容器不可比较", () => {
    expect(isTypeComparable("singleLineText", "subtable")).toBe(false);
    expect(isTypeComparable("singleLineText", "tabs")).toBe(false);
  });
});

describe("checkSubtableCompatibility（子表格整表抓取结构兼容）", () => {
  it("存在同名同类型字段即可兼容", () => {
    const r = checkSubtableCompatibility(
      [
        { name: "项目名", type: "singleLineText" },
        { name: "金额", type: "number" },
      ],
      [
        { name: "项目名", type: "singleLineText" },
        { name: "金额", type: "number" },
        { name: "备注", type: "longText" },
      ],
    );
    expect(r.ok).toBe(true);
    expect(r.compatible).toContain("项目名");
    expect(r.compatible).toContain("金额");
    expect(r.missingInTarget).toEqual([]);
  });
  it("无同名字段 → 不兼容", () => {
    const r = checkSubtableCompatibility(
      [{ name: "A", type: "singleLineText" }],
      [{ name: "B", type: "singleLineText" }],
    );
    expect(r.ok).toBe(false);
    expect(r.missingInTarget).toContain("A");
  });
  it("同名但类型不匹配 → 标记 typeMismatch 且不算兼容字段", () => {
    const r = checkSubtableCompatibility(
      [{ name: "金额", type: "number" }],
      [{ name: "金额", type: "singleLineText" }],
    );
    expect(r.ok).toBe(false);
    expect(r.typeMismatch).toHaveLength(1);
  });
  it("关联/计算字段不作为克隆依据（跳过）", () => {
    const r = checkSubtableCompatibility(
      [
        { name: "标题", type: "singleLineText" },
        { name: "关联", type: "links" },
      ],
      [{ name: "标题", type: "singleLineText" }],
    );
    expect(r.ok).toBe(true);
    expect(r.compatible).toEqual(["标题"]);
  });
});

describe("rollupAggOptions", () => {
  it("数值字段全部可用", () => {
    const opts = rollupAggOptions("number");
    expect(opts.find((o) => o.value === "sum")?.disabled).toBe(false);
    expect(opts.find((o) => o.value === "avg")?.disabled).toBe(false);
  });
  it("文本字段求和/平均禁用，计数可用", () => {
    const opts = rollupAggOptions("singleLineText");
    expect(opts.find((o) => o.value === "sum")?.disabled).toBe(true);
    expect(opts.find((o) => o.value === "avg")?.disabled).toBe(true);
    expect(opts.find((o) => o.value === "count")?.disabled).toBe(false);
  });
  it("日期字段 min/max 可用、sum 禁用", () => {
    const opts = rollupAggOptions("date");
    expect(opts.find((o) => o.value === "sum")?.disabled).toBe(true);
    expect(opts.find((o) => o.value === "min")?.disabled).toBe(false);
    expect(opts.find((o) => o.value === "max")?.disabled).toBe(false);
  });
  it("未选字段时全部可用（不预设限制）", () => {
    const opts = rollupAggOptions(undefined);
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });
});
