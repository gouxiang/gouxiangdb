import { describe, expect, it } from "vitest";
import type { ChartDatum } from "./chart-aggregate.js";
import { chartDataToCsv } from "./chart-csv.js";

function datum(key: string, label: string, value: number | null): ChartDatum {
  return { key, label, value, count: 1, recordIds: [] };
}

const BOM = "\uFEFF";

describe("chartDataToCsv", () => {
  it("以 BOM 开头且行分隔为 CRLF", () => {
    const csv = chartDataToCsv([datum("a", "苹果", 10)], "品类", "销售额求和");
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.includes("\r\n")).toBe(true);
    expect(csv.includes("\n")).toBe(true);
    expect(csv.endsWith("\n")).toBe(false); // 末尾不额外加空行
  });

  it("表头取传入的维度/指标名，数据行两列对齐", () => {
    const csv = chartDataToCsv([datum("a", "苹果", 10)], "品类", "销售额求和");
    const lines = csv.slice(BOM.length).split("\r\n");
    expect(lines[0]).toBe("品类,销售额求和");
    expect(lines[1]).toBe("苹果,10");
  });

  it("null 指标输出空单元格而非 null/0", () => {
    const csv = chartDataToCsv([datum("a", "(空白)", null)], "品类", "均值");
    const lines = csv.slice(BOM.length).split("\r\n");
    expect(lines[1]).toBe("(空白),");
  });

  it("公式注入字符（= + - @ Tab CR）前导补单引号", () => {
    const csv = chartDataToCsv(
      [
        datum("1", "=1+1", 1),
        datum("2", "+1", 1),
        datum("3", "-1", 1),
        datum("4", "@cmd", 1),
        datum("5", "\tTab", 1),
        datum("6", "\rCR", 1),
      ],
      "品类",
      "v",
    );
    const body = csv.slice(BOM.length);
    expect(body).toContain("'=1+1");
    expect(body).toContain("'+1");
    expect(body).toContain("'-1");
    expect(body).toContain("'@cmd");
    expect(body).toContain("'\tTab");
    expect(body).toContain("'\rCR");
  });

  it("内嵌双引号双写并用引号包裹，含逗号同样包裹", () => {
    const csv = chartDataToCsv(
      [
        datum("1", '他说"你好"', 1),
        datum("2", "甲,乙", 2),
      ],
      "品类",
      "v",
    );
    const body = csv.slice(BOM.length);
    expect(body).toContain('"他说""你好"""');
    expect(body).toContain('"甲,乙"');
  });

  it("中文不转义、不加引号", () => {
    const csv = chartDataToCsv([datum("a", "华南大区", 42)], "区域", "计数");
    const lines = csv.slice(BOM.length).split("\r\n");
    expect(lines[1]).toBe("华南大区,42");
  });
});
