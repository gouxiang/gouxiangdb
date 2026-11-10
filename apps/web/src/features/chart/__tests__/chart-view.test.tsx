// ChartView 组件级回归（node 环境，react-dom/server + vi.mock，沿用 gantt-view.test.tsx 范式：
// apps/web 无 jsdom / @testing-library，禁止新增依赖）。锁渲染契约、hooks 守卫顺序与权限门控，
// 聚合/几何正确性由 chart-aggregate / chart-geometry 纯函数测试覆盖，不在此重复。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultViewConfig } from "@gx/shared-types";
import type {
  FieldDTO,
  RecordDTO,
  ViewDTO,
  ViewConfig,
} from "@gx/shared-types";
import type { ViewProps } from "../../views/field-controls";

// ---- 受控替身：渲染输入（fields/records/loading/bounded/degraded）由各用例改写 ----
let fields: FieldDTO[] = [];
let records: RecordDTO[] = [];
let isLoading = false;
let bounded = false;
let degraded: string[] = [];

vi.mock("../../../api/hooks", () => ({
  useFields: () => ({ data: fields.length ? fields : undefined }),
  // ViewProps 不带表名，ChartView 自行 useTables 取真实表名拼导出文件名。
  useTables: () => ({ data: [{ id: "tbl-1", name: "销售表" }] }),
  useGXMutations: () => ({
    updateView: { mutateAsync: vi.fn(async () => undefined) },
  }),
}));
vi.mock("../../../api/records-paging-hooks", () => ({
  useRecordsBounded: () => ({
    records,
    fields,
    bounded,
    declaredTotal: 2,
    isLoading,
    degraded,
  }),
}));

import ChartView from "../ChartView";

const DIM_FIELD = {
  id: "fld-cat",
  name: "品类",
  type: "singleLineText",
  options: null,
} as unknown as FieldDTO;
const METRIC_FIELD = {
  id: "fld-val",
  name: "销售额",
  type: "number",
  options: null,
} as unknown as FieldDTO;

const rec = (id: string, cat: string, val: number): RecordDTO =>
  ({
    id,
    tableId: "tbl-1",
    fields: { "fld-cat": cat, "fld-val": val },
  }) as unknown as RecordDTO;

// 指标单元格为 null：sum 聚合时各桶 toNum 全过滤为空 → value 全 null，用于 all-null 空态。
const recMetricNull = (id: string, cat: string): RecordDTO =>
  ({
    id,
    tableId: "tbl-1",
    fields: { "fld-cat": cat, "fld-val": null },
  }) as unknown as RecordDTO;

const CHART_RECORDS = [rec("rec-1", "苹果", 10), rec("rec-2", "香蕉", 20)];

function makeProps(
  configOver: Partial<ViewConfig>,
  canManageSchema: boolean,
): ViewProps {
  return {
    baseId: "base-1",
    tableId: "tbl-1",
    viewId: "view-1",
    view: {
      id: "view-1",
      tableId: "tbl-1",
      name: "销售图表",
      type: "chart",
      lockMode: "collaborative",
      order: 0,
      config: defaultViewConfig(configOver),
      createdAt: "2026-01-01T00:00:00.000Z",
    } as ViewDTO,
    permissions: {
      canManageBase: true,
      canManageSchema,
      canEditData: true,
      canComment: true,
      canView: true,
    },
  };
}

const CONFIGURED: Partial<ViewConfig> = {
  chartDimensionFieldId: "fld-cat",
  chartMetricFieldId: "fld-val",
  chartAggFunc: "sum",
};

beforeEach(() => {
  fields = [DIM_FIELD, METRIC_FIELD];
  records = CHART_RECORDS;
  isLoading = false;
  bounded = false;
  degraded = [];
});

const html = (canManageSchema = true, over: Partial<ViewConfig> = CONFIGURED) =>
  renderToStaticMarkup(<ChartView {...makeProps(over, canManageSchema)} />);

describe("ChartView 引导空态", () => {
  it("未配置维度字段时显示 Setup 引导与 select，不渲染柱图", () => {
    const out = html(true, { chartDimensionFieldId: null });
    expect(out).toContain("设置图表维度字段");
    expect(out).toContain("<select");
    expect(out).not.toContain("苹果");
  });

  it("canManageSchema=false 时引导 select 带 disabled", () => {
    const out = html(false, { chartDimensionFieldId: null });
    expect(out).toContain("设置图表维度字段");
    expect(out).toMatch(/<select[^>]*disabled/);
  });
});

describe("ChartView 主体渲染", () => {
  it("配置维度且有记录时渲染维度标签与聚合数值，不再出现 Setup", () => {
    const out = html();
    expect(out).toContain("苹果");
    expect(out).toContain("香蕉");
    // sum：苹果=10 / 香蕉=20（柱顶 <text> 数值）
    expect(out).toContain("10");
    expect(out).toContain("20");
    expect(out).not.toContain("设置图表维度字段");
  });

  it("加载中渲染 Spinner 而非柱图", () => {
    isLoading = true;
    const out = html();
    expect(out).toContain("animate-spin");
    expect(out).not.toContain("苹果");
  });

  it("有维度但零记录时渲染空态而非柱图", () => {
    records = [];
    const out = html();
    expect(out).toContain("暂无可绘制数据");
    expect(out).not.toContain("苹果");
  });
});

describe("ChartView 刀3 图型切换权限", () => {
  it("canManageSchema=true 时工具行列齐四个图型名", () => {
    const out = html(true);
    expect(out).toContain("柱图");
    expect(out).toContain("条形图");
    expect(out).toContain("折线图");
    expect(out).toContain("饼图");
  });

  it("canManageSchema=false 时只显示当前型名静态文本，不渲染切换器的其余型名", () => {
    // 默认 chartType=bar → 静态文本「柱图」。导出 CSV 按钮是读操作仍在，故用型名排他而非禁全 button。
    const out = html(false);
    expect(out).toContain("柱图");
    expect(out).not.toContain("条形图");
    expect(out).not.toContain("折线图");
    expect(out).not.toContain("饼图");
  });
});

describe("ChartView 刀3 四图型分发", () => {
  it("chartType 覆写为各型时渲染对应 aria-label 的图表", () => {
    expect(html(true, { ...CONFIGURED, chartType: "bar" })).toContain('aria-label="柱图"');
    expect(html(true, { ...CONFIGURED, chartType: "horizontalBar" })).toContain(
      'aria-label="条形图"',
    );
    expect(html(true, { ...CONFIGURED, chartType: "line" })).toContain('aria-label="折线图"');
    expect(html(true, { ...CONFIGURED, chartType: "pie" })).toContain('aria-label="饼图"');
  });
});

describe("ChartView 刀3 截断/降级提示", () => {
  it("bounded=true 时渲染有界截断文案", () => {
    bounded = true;
    const out = html();
    expect(out).toContain("当前仅显示前");
  });

  it("degraded 含 computedInMem 时渲染受限结果文案（优先级高于截断）", () => {
    degraded = ["computedInMem"];
    const out = html();
    expect(out).toContain("受限结果");
    expect(out).toContain("role=\"alert\"");
  });
});

describe("ChartView 刀3 全 null 指标与导出", () => {
  it("指标聚合值全 null 时渲染引导空态且不绘制图表", () => {
    // 两个维度桶、每桶指标单元格为 null：sum 过滤后无数值 → value 全 null → allNull 空态。
    records = [recMetricNull("rec-1", "苹果"), recMetricNull("rec-2", "香蕉")];
    const out = html();
    expect(out).toContain("没有可聚合的数值");
    // EmptyState 的装饰图标是 aria-hidden 无 role 的 svg；四个图型 svg 均带 role="img"，
    // 故以「无 role=img 图表」精确判定图表未渲染（而非笼统不含 <svg，否则与装饰图标冲突）。
    expect(out).not.toContain('role="img"');
  });

  it("数据态渲染导出 CSV 按钮", () => {
    const out = html();
    expect(out).toContain("导出 CSV");
  });
});
