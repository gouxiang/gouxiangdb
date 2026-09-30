// 甘特图视图：起止日期画任务条、数字/百分比画进度、同表 link 画前置依赖。
//
// hooks 顺序约定（同 KanbanView，规避 React #310）：本组件先无条件跑完全部 hooks，
// 再按「开始字段是否已配置且存在、taskRange 是否非空」早返回引导空态。空态抽成文件
// 末尾的独立子组件 GanttSetup——否则首帧 useFields 未返回（少跑 hook）、次帧字段到达
// （多跑 hook）会命中「Rendered more hooks than during the previous render」整块崩溃。
// 时间刻度表头 / 依赖线 / 任务行展示子件在 ./gantt-parts.tsx，本文件负责取数、
// 缩放配置写回与原生指针拖拽改期。

import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  GANTT_ZOOM_LABEL,
  type GanttZoom,
  type FieldDTO,
} from "@gx/shared-types";
import { useFields, useGXMutations } from "../../api/hooks";
import { useRecordsBounded } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import {
  EmptyState,
  SegmentedControl,
  Select,
  Spinner,
} from "../../components/ui";
import {
  ResultNotice,
  boundedResultText,
  DEGRADED_RESULT_TEXT,
} from "../common/ResultNotice";
import type { ViewProps } from "../views/field-controls";
import {
  DAY_MS,
  buildGanttLayout,
  dateFromPx,
} from "./gantt-scale.js";
import {
  extractTasks,
  taskRange,
  type GanttTask,
} from "./gantt-tasks.js";
import {
  GanttTimelineHeader,
  GanttTaskBody,
  NAME_COL_PX,
} from "./gantt-parts.js";

const ZOOM_ORDER: GanttZoom[] = ["day", "week", "month", "quarter", "year"];

export default function GanttView({
  tableId,
  viewId,
  view,
  permissions,
  onOpenRecord,
}: ViewProps) {
  const bounded = useRecordsBounded({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);
  const m = useGXMutations();

  const cfg = view.config;
  const fields = fieldsRes ?? [];
  const defaultTitleFieldId = fieldsRes?.[0]?.id ?? null;
  const startField = fields.find((f) => f.id === cfg.ganttStartFieldId);
  const endField = fields.find((f) => f.id === cfg.ganttEndFieldId);
  const degraded = isComputedInMem(bounded.degraded);

  // 以下布局派生即使在「未配置」首帧也照常计算（占位用），保证 hooks/memo 数量恒定。
  const range = useMemo(
    () => taskRange(bounded.records, cfg.ganttStartFieldId, cfg.ganttEndFieldId),
    [bounded.records, cfg.ganttStartFieldId, cfg.ganttEndFieldId],
  );
  const layout = useMemo(
    () =>
      range
        ? buildGanttLayout(range.min, range.max, cfg.ganttZoom)
        : buildGanttLayout(new Date(), new Date(), cfg.ganttZoom),
    [range, cfg.ganttZoom],
  );
  const tasks = useMemo<GanttTask[]>(
    () =>
      extractTasks(
        bounded.records,
        {
          startFieldId: cfg.ganttStartFieldId,
          endFieldId: cfg.ganttEndFieldId,
          progressFieldId: cfg.ganttProgressFieldId,
          dependencyFieldId: cfg.ganttDependencyFieldId,
          titleFieldId: cfg.cardFieldIds?.[0] ?? defaultTitleFieldId,
        },
        layout,
      ),
    [bounded.records, cfg, defaultTitleFieldId, layout],
  );

  // 拖拽改期会话：ref 存会话真值，state 仅用于任务条实时跟手位移。
  const dragRef = useRef<{ id: string; startX: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; px: number } | null>(null);

  // 守卫必须晚于上面全部 hooks —— 其结果会随 useFields 首帧空 / 次帧到达翻转。
  if (!startField) {
    return (
      <GanttSetup
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
  if (!range) {
    return (
      <div className="flex h-full items-center justify-center bg-gx-bg p-gx-lg">
        <EmptyState
          icon="gantt"
          title="暂无带日期的任务"
          description="为记录填写开始日期后，任务条会显示在时间轴上。"
        />
      </div>
    );
  }

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>, t: GanttTask) => {
    if (!permissions.canEditData) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { id: t.id, startX: e.clientX };
    setDrag({ id: t.id, px: 0 });
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({
      id: d.id,
      px: Math.round((e.clientX - d.startX) / layout.pxPerDay) * layout.pxPerDay,
    });
  };
  const commitDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    const t = tasks.find((x) => x.id === d.id);
    if (!t) return;
    const dxPx = e.clientX - d.startX;
    if (Math.abs(dxPx) < layout.pxPerDay / 2) return; // 不足一天视为误触，不写回
    const newStart = dateFromPx(layout, Math.max(0, t.leftPx + dxPx));
    const durationDays = Math.round(
      (t.end.getTime() - t.start.getTime()) / DAY_MS,
    );
    const newEnd = new Date(newStart.getTime() + durationDays * DAY_MS);
    const fieldsToWrite: Record<string, string> = {
      [startField.id]: toYmd(newStart),
    };
    if (endField) fieldsToWrite[endField.id] = toYmd(newEnd);
    void m.updateRecord
      .mutateAsync({ recordId: t.id, fields: fieldsToWrite, tableId, viewId })
      .catch(() => undefined); // 错误提示由全局 mutation 兜底
  };

  const onZoom = (next: GanttZoom) => {
    if (next === cfg.ganttZoom) return;
    void m.updateView.mutateAsync({
      viewId,
      tableId,
      data: { config: { ...cfg, ganttZoom: next } },
    });
  };

  return (
    <div className="flex h-full flex-col bg-gx-bg">
      {(bounded.bounded || degraded) && (
        <div className="shrink-0 px-gx-md pt-gx-sm">
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

      <div className="flex shrink-0 items-center gap-2 border-b border-gx-border px-gx-md py-gx-sm">
        <span className="text-gx-12 text-gx-text-secondary">时间刻度</span>
        <SegmentedControl<GanttZoom>
          size="sm"
          value={cfg.ganttZoom}
          options={ZOOM_ORDER.map((z) => ({
            value: z,
            label: GANTT_ZOOM_LABEL[z],
          }))}
          onChange={onZoom}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="relative"
          style={{ width: NAME_COL_PX + layout.widthPx }}
        >
          <GanttTimelineHeader layout={layout} />
          <GanttTaskBody
            layout={layout}
            tasks={tasks}
            dragId={drag?.id ?? null}
            dragShiftPx={drag?.px ?? 0}
            canEdit={permissions.canEditData}
            onOpenName={(t) =>
              onOpenRecord?.({ tableId, recordId: t.id, title: t.title })
            }
            onBarDown={beginDrag}
            onBarMove={onDragMove}
            onBarUp={commitDrag}
          />
        </div>
      </div>
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 格式化为日期字段写值口径 'YYYY-MM-DD'。 */
function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 未配置开始日期字段时的引导空态（独立组件）。
 * 拆出来让父组件 GanttView 的 hooks 无条件跑完：守卫早返回留在父组件里会让
 * 「首帧字段未到 / 次帧字段到达」两次渲染的 hook 数量不一致，命中 React #310。
 */
function GanttSetup({
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
  const dateFields = fields.filter(
    (f) => f.type === "date" || f.type === "datetime",
  );
  return (
    <div className="flex h-full items-center justify-center bg-gx-bg p-gx-lg">
      <EmptyState
        icon="gantt"
        title="设置甘特图开始日期字段"
        description="请选择一个「日期」字段作为任务条的开始时间。"
        action={
          <div className="mt-3 flex items-center gap-2">
            <span className="text-gx-13 text-gx-text-secondary">开始字段：</span>
            <Select
              value=""
              disabled={dateFields.length === 0 || !canManageSchema}
              options={
                dateFields.length === 0
                  ? [{ value: "", label: "暂无可用的日期字段" }]
                  : [{ value: "", label: "请选择…" }, ...dateFields.map((f) => ({ value: f.id, label: f.name }))]
              }
              onChange={(e) => {
                if (e.target.value) {
                  void m.updateView.mutateAsync({
                    viewId,
                    tableId,
                    data: { config: { ganttStartFieldId: e.target.value } },
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
