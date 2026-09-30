// 甘特图展示子件：时间刻度表头、依赖连线 SVG 层、任务行（任务名 + 任务条）。
// 从 GanttView 拆出以满足「单文件 ≤300 行」。本文件只做渲染，不含数据 hooks；
// 拖拽判定/写回逻辑留在 GanttView，经 props 传入。

import {
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clsx } from "clsx";
import { type GanttZoom } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import {
  DAY_MS,
  ZOOM_COLUMN_PX,
  ZOOM_UNIT_DAYS,
  type GanttLayout,
} from "./gantt-scale.js";
import type { GanttTask } from "./gantt-tasks.js";

export const NAME_COL_PX = 224;
export const HEADER_H = 32;
export const ROW_H = 40;
const BAR_H = 24;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 日期字段写值/标题统一口径 'YYYY-MM-DD'。 */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 按缩放档生成每列的简单日期标签。 */
function tickLabel(zoom: GanttZoom, d: Date): string {
  if (zoom === "day" || zoom === "week") {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (zoom === "month") return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  if (zoom === "quarter") {
    return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
  }
  return `${d.getFullYear()}`;
}

/** 顶部表头：任务名格 + 按列生成的时间刻度。随横向滚动，纵向 sticky。 */
export function GanttTimelineHeader({ layout }: { layout: GanttLayout }) {
  const columnPx = ZOOM_COLUMN_PX[layout.zoom];
  const unitDays = ZOOM_UNIT_DAYS[layout.zoom];
  return (
    <div className="sticky top-0 z-20 flex" style={{ height: HEADER_H }}>
      <div
        className="sticky left-0 z-30 flex shrink-0 items-center border-b border-r border-gx-border bg-gx-table-header px-gx-sm text-gx-12 font-medium text-gx-text-secondary"
        style={{ width: NAME_COL_PX }}
      >
        任务名
      </div>
      <div
        className="relative shrink-0 border-b border-gx-border bg-gx-table-header"
        style={{ width: layout.widthPx }}
      >
        {Array.from({ length: layout.columns }, (_u, i) => {
          const d = new Date(layout.origin.getTime() + i * unitDays * DAY_MS);
          return (
            <div
              key={i}
              className="absolute top-0 h-full border-l border-gx-hairline"
              style={{ left: i * columnPx }}
            >
              <span className="ml-1 whitespace-nowrap text-gx-11 text-gx-text-tertiary">
                {tickLabel(layout.zoom, d)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 依赖连线层：从前置任务条右端画折线（带箭头）指向后继任务条左端。
 * pointer-events-none：只作视觉层，不挡任务条/行的指针与点击。
 */
function DependencyLayer({
  layout,
  tasks,
}: {
  layout: GanttLayout;
  tasks: GanttTask[];
}) {
  const indexById = new Map(tasks.map((t, i) => [t.id, i]));
  return (
    <svg
      className="pointer-events-none absolute top-0"
      style={{ left: NAME_COL_PX }}
      width={layout.widthPx}
      height={tasks.length * ROW_H}
      aria-hidden="true"
    >
      <defs>
        <marker markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" id="gx-gantt-dep-arrow">
          <path d="M0,0 L8,4 L0,8 Z" className="fill-gx-text-tertiary" />
        </marker>
      </defs>
      {tasks.map((t, ti) =>
        t.dependsOn.map((dep) => {
          const pi = indexById.get(dep);
          const p = pi === undefined ? undefined : tasks[pi];
          if (!p || pi === undefined) return null;
          const x1 = p.leftPx + p.widthPx;
          const y1 = pi * ROW_H + ROW_H / 2;
          const x2 = t.leftPx;
          const y2 = ti * ROW_H + ROW_H / 2;
          return (
            <path
              key={`${t.id}-${dep}`}
              d={`M${x1} ${y1} H${x1 + 10} V${y2} H${x2 - 6}`}
              className="fill-none stroke-gx-text-tertiary"
              strokeWidth={1}
              markerEnd="url(#gx-gantt-dep-arrow)"
            />
          );
        }),
      )}
    </svg>
  );
}

/**
 * 任务区主体：依赖连线层 + 全部任务行。时间轴单元宽度由 layout 决定。
 * 拖拽会话（id + 实时跟手位移）与指针回调由 GanttView 持有，这里只做绑定。
 */
export function GanttTaskBody({
  layout,
  tasks,
  dragId,
  dragShiftPx,
  canEdit,
  onOpenName,
  onBarDown,
  onBarMove,
  onBarUp,
}: {
  layout: GanttLayout;
  tasks: GanttTask[];
  dragId: string | null;
  dragShiftPx: number;
  canEdit: boolean;
  onOpenName: (t: GanttTask) => void;
  onBarDown: (e: ReactPointerEvent<HTMLDivElement>, t: GanttTask) => void;
  onBarMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onBarUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="relative">
      <DependencyLayer layout={layout} tasks={tasks} />
      {tasks.map((t) => (
        <div key={t.id} className="flex" style={{ height: ROW_H }}>
          <button
            type="button"
            onClick={() => onOpenName(t)}
            className="sticky left-0 z-10 flex shrink-0 items-center truncate border-b border-r border-gx-hairline bg-gx-surface px-gx-sm text-left text-gx-13 text-gx-text-primary transition-colors hover:bg-gx-row-hover focus:outline-none focus-visible:bg-gx-row-hover"
            style={{ width: NAME_COL_PX }}
          >
            {t.title}
          </button>
          <div
            className="relative shrink-0 border-b border-gx-hairline"
            style={{ width: layout.widthPx }}
          >
            {t.dependsOn.length > 0 && (
              <span
                className="absolute flex items-center text-gx-text-tertiary"
                style={{ left: t.leftPx - 18, top: (ROW_H - 14) / 2 }}
                title={`${t.dependsOn.length} 个前置任务`}
              >
                <Icon name="cornerDownRight" size={13} />
              </span>
            )}
            <div
              role="button"
              aria-label={`任务 ${t.title}，${ymd(t.start)} 至 ${ymd(t.end)}，可拖拽改期`}
              aria-disabled={canEdit ? undefined : true}
              data-gx-draggable={canEdit ? "true" : undefined}
              onPointerDown={canEdit ? (e) => onBarDown(e, t) : undefined}
              onPointerMove={canEdit ? onBarMove : undefined}
              onPointerUp={canEdit ? onBarUp : undefined}
              className={clsx(
                "absolute overflow-hidden rounded-gx-lg bg-gx-accent-bg",
                canEdit
                  ? "cursor-grab touch-none active:cursor-grabbing"
                  : "cursor-default",
              )}
              style={{
                left: t.leftPx + (dragId === t.id ? dragShiftPx : 0),
                width: t.widthPx,
                top: (ROW_H - BAR_H) / 2,
                height: BAR_H,
              }}
              title={`${ymd(t.start)} → ${ymd(t.end)}`}
            >
              <div
                className="h-full rounded-gx-lg bg-gx-accent"
                style={{ width: `${Math.round(t.progress * 100)}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
