// 甘特图纯函数：从 records + 视图配置键提取任务（起止/进度）与前置依赖。
// 无 React/DOM 依赖。起止缺省容错：无开始的任务不渲染任务条（返回 null 任务过滤掉）。

import type {
  CellValue,
  LinkRefDTO,
  RecordDTO,
} from "@gx/shared-types";
import {
  parseDay,
  progressRatio,
  type GanttLayout,
  taskLeftPx,
  taskWidthPx,
} from "./gantt-scale.js";

export interface GanttTask {
  id: string;
  title: string;
  start: Date;
  end: Date;
  progress: number;
  leftPx: number;
  widthPx: number;
  /** 前置任务 id（同表关联）。 */
  dependsOn: string[];
}

export interface GanttFieldKeys {
  startFieldId: string | null;
  endFieldId: string | null;
  progressFieldId: string | null;
  dependencyFieldId: string | null;
  titleFieldId: string | null;
}

function titleOf(r: RecordDTO, titleFieldId: string | null): string {
  const t = titleFieldId ? String(r.fields[titleFieldId] ?? "").trim() : "";
  return t || "未命名";
}

/** 取同表 link 字段上关联的记录 id 列表（跨表关联忽略）。 */
export function dependencyIds(
  value: unknown,
  selfTableId: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const ref = item as Partial<LinkRefDTO> | null;
    if (ref && ref.tableId === selfTableId && ref.recordId) {
      out.push(ref.recordId as string);
    }
  }
  return out;
}

/**
 * 从一批 records 提取甘特任务。
 * - 开始/结束任一缺失：开始缺 -> 跳过；结束缺 -> 结束取开始当天；
 * - 结束早于开始：交换；
 * - 依赖字段可缺。
 */
export function extractTasks(
  records: readonly RecordDTO[],
  keys: GanttFieldKeys,
  layout: GanttLayout,
): GanttTask[] {
  const tasks: GanttTask[] = [];
  for (const r of records) {
    const start = keys.startFieldId
      ? parseDay(r.fields[keys.startFieldId] as CellValue)
      : null;
    if (!start) continue;
    let end = keys.endFieldId
      ? parseDay(r.fields[keys.endFieldId] as CellValue)
      : null;
    if (!end) end = new Date(start);
    let s = start;
    let e = end;
    if (e.getTime() < s.getTime()) {
      [s, e] = [e, s];
    }
    const progress = keys.progressFieldId
      ? progressRatio(r.fields[keys.progressFieldId] as CellValue)
      : 0;
    const dependsOn = keys.dependencyFieldId
      ? dependencyIds(r.fields[keys.dependencyFieldId], r.tableId)
      : [];
    tasks.push({
      id: r.id,
      title: titleOf(r, keys.titleFieldId),
      start: s,
      end: e,
      progress,
      leftPx: taskLeftPx(layout, s),
      widthPx: taskWidthPx(layout, s, e),
      dependsOn,
    });
  }
  return tasks;
}

/** 取全部任务中最早开始与最晚结束（用于确定布局范围）；无任务返回 null。 */
export function taskRange(
  records: readonly RecordDTO[],
  startFieldId: string | null,
  endFieldId: string | null,
): { min: Date; max: Date } | null {
  if (!startFieldId) return null;
  let min: Date | null = null;
  let max: Date | null = null;
  for (const r of records) {
    const s = parseDay(r.fields[startFieldId] as CellValue);
    if (!s) continue;
    const e = endFieldId
      ? parseDay(r.fields[endFieldId] as CellValue)
      : null;
    if (!min || s.getTime() < min.getTime()) min = s;
    const far = e && e.getTime() > s.getTime() ? e : s;
    if (!max || far.getTime() > max.getTime()) max = far;
  }
  if (!min || !max) return null;
  return { min, max };
}
