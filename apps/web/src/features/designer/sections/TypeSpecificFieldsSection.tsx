// apps/web/src/features/designer/sections/TypeSpecificFieldsSection.tsx
// 右栏「数据展示」中的类型专属字段（除 form 外按 view.type 渲染对应选择器）。
//
// 这些是视图 config（普通视图通道 commitConfig / PATCH /api/views/:id），
// 候选字段按各数据视图自身的同一口径过滤，保证设置面板与视图运行时不会分叉：
//   grid     → groupByFieldId            kanban  → kanbanFieldId(singleSelect)
//   calendar → dateFieldId               tree    → treeParentFieldId(同表自引用 link)
//   gantt    → start/end/progress/dependency + ganttZoom

import { useMemo } from "react";
import type { FieldDTO, ViewDTO } from "@gx/shared-types";
import {
  AGG_FUNC_LABEL,
  GANTT_ZOOM_LABEL,
  canBeChartDimensionField,
  canBeChartMetricField,
  type AggFunc,
  type GanttZoom,
} from "@gx/shared-types";
import { SegmentedControl, Select } from "../../../components/ui";

export interface TypeSpecificFieldsSectionProps {
  view: ViewDTO;
  tableId: string;
  fields: FieldDTO[];
  canEdit: boolean;
  commitConfig: (config: Record<string, unknown>) => Promise<void>;
}

type Opt = { value: string; label: string };

function fieldSelect(
  label: string,
  value: string | null,
  options: FieldDTO[],
  canEdit: boolean,
  onChange: (id: string | null) => void,
  noneLabel = "不设置",
) {
  const opts: Opt[] = [
    { value: "", label: noneLabel },
    ...options.map((f) => ({ value: f.id, label: f.name })),
  ];
  return (
    <div key={label} className="flex flex-col gap-1.5">
      <label className="text-gx-12 font-medium text-gx-text-secondary">{label}</label>
      <Select
        value={value ?? ""}
        disabled={!canEdit}
        options={opts}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </div>
  );
}

export default function TypeSpecificFieldsSection({
  view,
  tableId,
  fields,
  canEdit,
  commitConfig,
}: TypeSpecificFieldsSectionProps) {
  const c = view.config;
  const set = (key: string) => (id: string | null) => void commitConfig({ [key]: id });

  const groupable = useMemo(
    () =>
      fields.filter((f) =>
        [
          "singleSelect",
          "multiSelect",
          "checkbox",
          "links",
          "singleLineText",
          "longText",
          "email",
          "phone",
          "url",
        ].includes(f.type),
      ),
    [fields],
  );
  const singleSelects = useMemo(() => fields.filter((f) => f.type === "singleSelect"), [fields]);
  const dateFields = useMemo(
    () =>
      fields.filter((f) =>
        ["date", "datetime", "createdTime", "lastModifiedTime"].includes(f.type),
      ),
    [fields],
  );
  const selfLinks = useMemo(
    () =>
      fields.filter(
        (f) => f.type === "links" && !f.isReverse && f.relatedTableId === tableId,
      ),
    [fields, tableId],
  );
  const ganttDates = useMemo(
    () => fields.filter((f) => f.type === "date" || f.type === "datetime"),
    [fields],
  );
  const progressFields = useMemo(
    () => fields.filter((f) => f.type === "number" || f.type === "percent"),
    [fields],
  );
  // 图表维度 / 指标候选：资格判定复用 shared-types 单源，不在这里手写类型清单。
  const chartDimensions = useMemo(
    () => fields.filter((f) => !f.isReverse && canBeChartDimensionField(f.type)),
    [fields],
  );
  const chartMetrics = useMemo(
    () => fields.filter((f) => !f.isReverse && canBeChartMetricField(f.type)),
    [fields],
  );

  return (
    <div className="flex flex-col gap-3 border-t border-gx-separator pt-3">
      <div className="text-gx-12 font-semibold text-gx-text-primary">类型设置</div>

      {view.type === "grid" &&
        fieldSelect("分组字段", c.groupByFieldId, groupable, canEdit, set("groupByFieldId"), "不分组")}
      {view.type === "kanban" &&
        fieldSelect("看板分组字段", c.kanbanFieldId, singleSelects, canEdit, set("kanbanFieldId"))}
      {view.type === "calendar" &&
        fieldSelect("日期字段", c.dateFieldId, dateFields, canEdit, set("dateFieldId"))}
      {view.type === "tree" &&
        fieldSelect("父级关联字段", c.treeParentFieldId, selfLinks, canEdit, set("treeParentFieldId"))}

      {view.type === "gantt" && (
        <>
          {fieldSelect("开始日期", c.ganttStartFieldId, ganttDates, canEdit, set("ganttStartFieldId"))}
          {fieldSelect("结束日期", c.ganttEndFieldId, ganttDates, canEdit, set("ganttEndFieldId"))}
          {fieldSelect("进度字段", c.ganttProgressFieldId, progressFields, canEdit, set("ganttProgressFieldId"))}
          {fieldSelect("依赖字段", c.ganttDependencyFieldId, selfLinks, canEdit, set("ganttDependencyFieldId"))}
          <div className="flex flex-col gap-1.5">
            <label className="text-gx-12 font-medium text-gx-text-secondary">时间刻度</label>
            <SegmentedControl
              value={c.ganttZoom}
              onChange={(z) => void commitConfig({ ganttZoom: z })}
              options={(Object.keys(GANTT_ZOOM_LABEL) as GanttZoom[]).map((z) => ({
                value: z,
                label: GANTT_ZOOM_LABEL[z],
              }))}
            />
          </div>
        </>
      )}

      {view.type === "chart" && (
        <>
          {fieldSelect(
            "维度字段",
            c.chartDimensionFieldId,
            chartDimensions,
            canEdit,
            set("chartDimensionFieldId"),
            "不设置（请选择维度）",
          )}
          {fieldSelect(
            "指标字段",
            c.chartMetricFieldId,
            chartMetrics,
            canEdit,
            set("chartMetricFieldId"),
            "不设置（按计数）",
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-gx-12 font-medium text-gx-text-secondary">聚合方式</label>
            <Select
              value={c.chartAggFunc}
              disabled={!canEdit}
              options={(Object.entries(AGG_FUNC_LABEL) as [AggFunc, string][]).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(e) => void commitConfig({ chartAggFunc: e.target.value as AggFunc })}
            />
          </div>
        </>
      )}
    </div>
  );
}
