// 甘特图纯函数：日期解析、日期↔px 换算、时间刻度生成、任务条几何与进度。
// 无 React/DOM 依赖，便于 vitest 单测。日期单位为"天"（整数），px 换算纯算术。

import type { CellValue, GanttZoom } from "@gx/shared-types";

/** 一天的毫秒数。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 把字段值解析为本地日期 00:00 的 Date。
 * - 'YYYY-MM-DD' 按本地午夜（避免 UTC 解析跨日，与 CalendarView 同口径）；
 * - 其它 ISO 串取其日期部分；非法/空 -> null。
 */
export function parseDay(value: CellValue | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 把 Date 规整到本地日期 00:00。 */
export function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 两个日期相差的整天数（a 相对 b）。 */
export function diffDays(a: Date, b: Date): number {
  return Math.round((dayStart(a).getTime() - dayStart(b).getTime()) / DAY_MS);
}

/**
 * 解析进度值为 0~1：
 * - percent：0~100 -> /100；
 * - number：按 0~100 口径处理（>1 视为百分数）；
 * - 空 -> 0；非法 -> 0。
 */
export function progressRatio(
  value: CellValue | null | undefined,
): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!isFinite(n)) return 0;
  const ratio = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, ratio));
}

/** 每个缩放档下一“列”代表的天数。 */
export const ZOOM_UNIT_DAYS: Record<GanttZoom, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
};

/** 每列（一个时间单位）的像素宽。 */
export const ZOOM_COLUMN_PX: Record<GanttZoom, number> = {
  day: 40,
  week: 28,
  month: 24,
  quarter: 20,
  year: 16,
};

export interface GanttLayout {
  /** 时间轴原点（第 0 列起始）日期。 */
  origin: Date;
  zoom: GanttZoom;
  /** 每像素代表的天数（= 单位天数 / 单位像素）。 */
  pxPerDay: number;
  /** 时间轴总列数（刻度）。 */
  columns: number;
  /** 时间轴总像素宽。 */
  widthPx: number;
}

/**
 * 由数据范围（最早开始、最晚结束）与缩放档计算时间轴布局。
 * 两端各留 PAD_UNITS 个单位的留白；起点对齐到单位边界。
 */
export function buildGanttLayout(
  minStart: Date,
  maxEnd: Date,
  zoom: GanttZoom,
): GanttLayout {
  const unitDays = ZOOM_UNIT_DAYS[zoom];
  const columnPx = ZOOM_COLUMN_PX[zoom];
  const padUnits = 2;

  const originRaw = dayStart(minStart).getTime() - padUnits * unitDays * DAY_MS;
  // 对齐到单位边界（向下取整到单位天数的整数倍，基准取 1970-01-01）。
  const origin = new Date(
    Math.floor(originRaw / (unitDays * DAY_MS)) * unitDays * DAY_MS,
  );

  const spanDays =
    diffDays(maxEnd, minStart) + 1 + padUnits * 2 * unitDays;
  const columns = Math.max(1, Math.ceil(spanDays / unitDays) + padUnits * 2);
  const widthPx = columns * columnPx;
  return {
    origin,
    zoom,
    pxPerDay: columnPx / unitDays,
    columns,
    widthPx,
  };
}

/** 某日期距原点的天数。 */
export function dayOffset(layout: GanttLayout, d: Date): number {
  return diffDays(d, layout.origin);
}

/** 任务条的左偏移 px。 */
export function taskLeftPx(layout: GanttLayout, start: Date): number {
  return dayOffset(layout, start) * layout.pxPerDay;
}

/** 任务条宽度 px（至少 1 天）。 */
export function taskWidthPx(
  layout: GanttLayout,
  start: Date,
  end: Date,
): number {
  const days = Math.max(1, diffDays(end, start) + 1);
  return days * layout.pxPerDay;
}

/**
 * 从像素位置（相对时间轴）反推日期：用于拖拽改期。
 * 吸附到天（按 pxPerDay 四舍五入）。
 */
export function dateFromPx(layout: GanttLayout, xPx: number): Date {
  const days = Math.round(xPx / layout.pxPerDay);
  return new Date(layout.origin.getTime() + days * DAY_MS);
}
