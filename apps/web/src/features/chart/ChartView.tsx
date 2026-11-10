// 图表视图（BI 刀3）：四图型容器 + 截断/降级诚实提示 + CSV 导出。
//
// hooks 顺序约定（同 KanbanView/GanttView，规避 React #310）：本组件先无条件跑完
// useRecordsBounded / useFields / useTables / useGXMutations / 两个 useMemo，再按
// 「维度字段是否已配置且存在 → isLoading → 有无数据 → 是否全 null」顺序早返回。
// 引导空态抽成文件末尾的独立子组件 ChartSetup，保证父组件 hook 数量在首帧/次帧恒定。

import { useMemo } from "react";
import type { ChartType, FieldDTO } from "@gx/shared-types";
import {
  AGG_FUNC_LABEL,
  CHART_TYPE_LABEL,
  canBeChartDimensionField,
} from "@gx/shared-types";
import { useFields, useGXMutations, useTables } from "../../api/hooks";
import { isComputedInMem } from "../../api/records-paging";
import { useRecordsBounded } from "../../api/records-paging-hooks";
import { Button, EmptyState, SegmentedControl, Select, Spinner, toast } from "../../components/ui";
import { csvFileName } from "../../lib/file-name";
import {
  ResultNotice,
  boundedResultText,
  DEGRADED_RESULT_TEXT,
} from "../common/ResultNotice";
import type { ViewProps } from "../views/field-controls";
import { buildChartData } from "./lib/chart-aggregate.js";
import { chartDataToCsv } from "./lib/chart-csv.js";
import { ChartFigure } from "./chart-figure.js";

export default function ChartView({
  baseId,
  tableId,
  viewId,
  view,
  permissions,
}: ViewProps) {
  const bounded = useRecordsBounded({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);
  // ViewProps 不带表名，导出文件名需要真实表名，自行按 baseId 拉表清单后 find。
  const { data: tablesRes } = useTables(baseId);
  const m = useGXMutations();
  const fields = fieldsRes ?? [];

  const cfg = view.config;

  // 维度字段可能已被删除或当前 schema 尚未到达：find 落空时按「未配置」走引导空态。
  const dimensionField = useMemo<FieldDTO | null>(
    () => fields.find((f) => f.id === cfg.chartDimensionFieldId) ?? null,
    [fields, cfg.chartDimensionFieldId],
  );

  // 指标字段用于 CSV 表头拼「字段名·聚合函数」；未配置时表头只留聚合函数名。
  const metricField = useMemo<FieldDTO | null>(
    () => fields.find((f) => f.id === cfg.chartMetricFieldId) ?? null,
    [fields, cfg.chartMetricFieldId],
  );

  // 即使首帧 dimensionField 为 null 也照常算出空数组，保证 hook 数量恒定。
  const data = useMemo(
    () =>
      buildChartData({
        records: bounded.records,
        dimensionField,
        metricFieldId: cfg.chartMetricFieldId,
        aggFunc: cfg.chartAggFunc,
      }),
    [bounded.records, dimensionField, cfg.chartMetricFieldId, cfg.chartAggFunc],
  );

  const tableName = tablesRes?.find((t) => t.id === tableId)?.name ?? null;
  const truncated = bounded.bounded;
  const degraded = isComputedInMem(bounded.degraded);
  const allNull = data.length > 0 && data.every((d) => d.value === null);

  // 守卫必须晚于上面全部 hooks —— 其结果会随 useFields 首帧空 / 次帧到达翻转。
  if (!dimensionField) {
    return (
      <ChartSetup
        tableId={tableId}
        viewId={viewId}
        fields={fields}
        canManageSchema={permissions.canManageSchema}
      />
    );
  }

  if (bounded.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-gx-bg p-gx-lg">
        <EmptyState
          icon="chart"
          title="暂无可绘制数据"
          description="当前维度下还没有可聚合的记录，先添加几条记录，图表会自动生成。"
        />
      </div>
    );
  }

  if (allNull) {
    return (
      <div className="flex h-full items-center justify-center bg-gx-bg p-gx-lg">
        <EmptyState
          icon="chart"
          title="当前指标没有可聚合的数值"
          description="该指标字段在各维度下都没有有效数值，换一个指标字段或聚合方式试试。"
        />
      </div>
    );
  }

  const changeType = (v: ChartType) => {
    // 浅合并：只下发 chartType，viewServiceTx 合并不动维度/指标/聚合三键。
    void m.updateView.mutateAsync({
      viewId,
      tableId,
      data: { config: { chartType: v } },
    });
  };

  // 导出是读操作，能看即可导，不接 canManageSchema。
  const exportCsv = () => {
    // SSR / 无 Blob URL 能力环境直接放弃，避免 node 下触碰 document 崩溃。
    if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return;
    try {
      const dimHeader = dimensionField.name;
      const metricHeader = metricField
        ? `${metricField.name}·${AGG_FUNC_LABEL[cfg.chartAggFunc]}`
        : AGG_FUNC_LABEL[cfg.chartAggFunc];
      const csv = chartDataToCsv(data, dimHeader, metricHeader);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFileName(tableName, tableId, { name: view.name, id: viewId });
      a.click();
      URL.revokeObjectURL(url);
      toast("已导出图表 CSV", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导出失败", "error");
    }
  };

  // 图型选项一律由枚举真源派生，零手写清单（新增图型自动出现）。
  const typeOptions = (Object.entries(CHART_TYPE_LABEL) as [ChartType, string][]).map(
    ([value, label]) => ({ value, label }),
  );

  return (
    <div className="h-full overflow-auto bg-gx-bg p-gx-lg">
      <div className="flex h-full flex-col gap-gx-md">
        {(degraded || truncated) && (
          <div className="shrink-0">
            {degraded ? (
              <ResultNotice tone="warning" role="alert">
                {DEGRADED_RESULT_TEXT}
              </ResultNotice>
            ) : (
              <ResultNotice tone="warning">
                {boundedResultText(bounded.declaredTotal, bounded.records.length)}
              </ResultNotice>
            )}
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-gx-sm">
          {permissions.canManageSchema ? (
            <SegmentedControl value={cfg.chartType} options={typeOptions} onChange={changeType} />
          ) : (
            // SegmentedControl 无 disabled：只读用户改渲染静态文本，避免触发必被后端拒的写。
            <span className="text-gx-13 font-medium text-gx-text-secondary">
              {CHART_TYPE_LABEL[cfg.chartType]}
            </span>
          )}
          <Button variant="ghost" size="sm" icon="download" onClick={exportCsv}>
            导出 CSV
          </Button>
        </div>

        <div className="min-h-0 flex-1">
          <ChartFigure type={cfg.chartType} data={data} />
        </div>
      </div>
    </div>
  );
}

/**
 * 未配置维度字段时的引导空态（独立组件）。
 * 拆出来让父组件 ChartView 的 hooks 无条件跑完：守卫早返回留在父组件里会让
 * 「首帧字段未到 / 次帧字段到达」两次渲染的 hook 数量不一致，命中 React #310。
 */
function ChartSetup({
  tableId,
  viewId,
  fields,
  canManageSchema,
}: {
  tableId: string;
  viewId: string;
  fields: FieldDTO[];
  canManageSchema: boolean;
}) {
  const m = useGXMutations();
  // 候选资格复用 shared-types 单源判定，不在这里手写字段类型清单；反向关联不参与分桶。
  const candidates = fields.filter(
    (f) => !f.isReverse && canBeChartDimensionField(f.type),
  );

  return (
    <div className="flex h-full items-center justify-center bg-gx-bg p-gx-lg">
      <EmptyState
        icon="chart"
        title="设置图表维度字段"
        description="请选择一个字段作为图表的分桶维度，记录将按该字段的值聚合成柱。"
        action={
          <div className="mt-3 flex items-center gap-2">
            <span className="text-gx-13 text-gx-text-secondary">维度字段：</span>
            <Select
              value=""
              options={
                candidates.length === 0
                  ? [{ value: "", label: "暂无可用维度字段" }]
                  : [
                      { value: "", label: "请选择…" },
                      ...candidates.map((f) => ({ value: f.id, label: f.name })),
                    ]
              }
              disabled={candidates.length === 0 || !canManageSchema}
              onChange={(e) => {
                if (e.target.value) {
                  // 部分合并：只下发维度键，viewServiceTx 浅合并不动其它 config。
                  void m.updateView.mutateAsync({
                    viewId,
                    tableId,
                    data: { config: { chartDimensionFieldId: e.target.value } },
                  });
                }
              }}
            />
          </div>
        }
      />
    </div>
  );
}
