// apps/web/src/features/designer/ViewSettingPreview.tsx
// 宽布局左栏：轻量静态预览（不渲染重型数据视图，避免设置弹窗里再挂整套 grid/gantt）。
//
// 按 view.type switch：用字段名占位，画出该视图最具辨识度的骨架。
// 顶部显示视图名 + 类型标签。预览只反映「字段范围/顺序 + 类型专属字段」的当前配置。

import { useMemo } from "react";
import type { FieldDTO, ViewDTO } from "@gx/shared-types";
import { VIEW_TYPE_LABEL } from "@gx/shared-types";
import { Icon, VIEW_ICON } from "../../components/icons";

export interface ViewSettingPreviewProps {
  view: ViewDTO;
  fields: FieldDTO[];
}

/** 取前 n 个字段名做占位（最少给一个占位符）。 */
function previewNames(fields: FieldDTO[], n: number): string[] {
  const names = fields.slice(0, n).map((f) => f.name);
  return names.length > 0 ? names : ["字段"];
}

export default function ViewSettingPreview({ view, fields }: ViewSettingPreviewProps) {
  const typeIcon = VIEW_ICON[view.type] ?? "grid";
  return (
    <div className="flex h-full flex-col gap-3 rounded-gx-lg border border-gx-border bg-gx-bg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-gx-13 font-semibold text-gx-text-primary">
            {view.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-gx-11 text-gx-text-hint">
            <Icon name={typeIcon} size={11} />
            {VIEW_TYPE_LABEL[view.type]}预览
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-gx-accent-bg px-2 py-0.5 text-gx-11 text-gx-accent">
          {VIEW_TYPE_LABEL[view.type]}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PreviewBody view={view} fields={fields} />
      </div>
    </div>
  );
}

function PreviewBody({ view, fields }: { view: ViewDTO; fields: FieldDTO[] }) {
  switch (view.type) {
    case "grid":
      return <GridSkeleton fields={fields} />;
    case "gallery":
      return <GallerySkeleton view={view} fields={fields} />;
    case "kanban":
      return <KanbanSkeleton fields={fields} />;
    case "calendar":
      return <CalendarSkeleton />;
    case "gantt":
      return <GanttSkeleton />;
    case "tree":
      return <TreeSkeleton fields={fields} />;
    case "form":
      return <FormSkeleton fields={fields} />;
    case "detail":
      return <DetailSkeleton fields={fields} />;
    default:
      return <GridSkeleton fields={fields} />;
  }
}

const cell = "truncate px-1.5 py-1 text-gx-11 text-gx-text-secondary";

function GridSkeleton({ fields }: { fields: FieldDTO[] }) {
  const names = previewNames(fields, 5);
  return (
    <div className="flex h-full flex-col gap-px">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${names.length}, minmax(0,1fr))` }}>
        {names.map((n) => (
          <div key={n} className="truncate border-b border-gx-separator px-1.5 py-1 text-gx-11 font-medium text-gx-text-secondary">
            {n}
          </div>
        ))}
      </div>
      {[0, 1, 2].map((r) => (
        <div key={r} className="grid" style={{ gridTemplateColumns: `repeat(${names.length}, minmax(0,1fr))` }}>
          {names.map((n) => (
            <div key={n} className={cell}>
              <div className="h-1.5 rounded-full bg-gx-separator" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function GallerySkeleton({ view, fields }: { view: ViewDTO; fields: FieldDTO[] }) {
  const cardNames = useMemo(() => {
    const ids = view.adminConfig?.cardFieldIds ?? [];
    const byId = new Map<string, string>(fields.map((f) => [f.id as string, f.name]));
    const mapped = ids.map((id) => byId.get(id)).filter((x): x is string => Boolean(x));
    return mapped.length > 0 ? mapped.slice(0, 3) : previewNames(fields, 2);
  }, [view.adminConfig, fields]);
  return (
    <div className="grid h-full grid-cols-2 gap-2">
      {[0, 1, 2, 3].map((c) => (
        <div key={c} className="flex flex-col overflow-hidden rounded-gx-sm border border-gx-border">
          <div className="h-8 bg-gx-separator" />
          <div className="flex flex-col gap-1 p-1.5">
            {cardNames.map((n) => (
              <div key={n} className="h-1.5 rounded-full bg-gx-separator" title={n} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function KanbanSkeleton({ fields }: { fields: FieldDTO[] }) {
  const cols = previewNames(fields.filter((f) => f.type === "singleSelect"), 3);
  const labels = cols.length > 1 ? cols : ["待处理", "进行中", "已完成"];
  return (
    <div className="grid h-full grid-cols-3 gap-2">
      {labels.map((l) => (
        <div key={l} className="flex flex-col gap-1.5 rounded-gx-sm bg-gx-surface p-1.5">
          <div className="truncate text-gx-11 font-medium text-gx-text-secondary">{l}</div>
          {[0, 1].map((c) => (
            <div key={c} className="h-6 rounded-gx-sm border border-gx-border bg-gx-bg" />
          ))}
        </div>
      ))}
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="grid h-full grid-cols-7 grid-rows-5 gap-px">
      {Array.from({ length: 35 }, (_, i) => (
        <div key={i} className="rounded-gx-sm bg-gx-surface p-0.5">
          {i % 7 === 1 && <div className="h-1.5 w-3/4 rounded-full bg-gx-accent-bg" />}
        </div>
      ))}
    </div>
  );
}

function GanttSkeleton() {
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {[
        "w-1/2",
        "w-2/3",
        "w-2/5",
      ].map((w, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="h-2 w-10 rounded-full bg-gx-separator" />
          <div className={`h-2.5 rounded-gx-sm bg-gx-accent-bg ${w}`} />
        </div>
      ))}
    </div>
  );
}

function TreeSkeleton({ fields }: { fields: FieldDTO[] }) {
  const names = previewNames(fields, 3);
  return (
    <div className="flex flex-col gap-1.5">
      {names.map((n, i) => (
        <div
          key={n}
          className="flex items-center gap-1 text-gx-11 text-gx-text-secondary"
          style={{ paddingLeft: i * 10 }}
        >
          <Icon name="cornerDownRight" size={11} />
          {n}
        </div>
      ))}
    </div>
  );
}

function FormSkeleton({ fields }: { fields: FieldDTO[] }) {
  const names = previewNames(fields, 4);
  return (
    <div className="flex flex-col gap-2">
      <div className="h-3 w-1/2 rounded-full bg-gx-separator" />
      {names.map((n) => (
        <div key={n} className="flex flex-col gap-1">
          <div className="text-gx-11 text-gx-text-hint">{n}</div>
          <div className="h-5 rounded-gx-sm border border-gx-border bg-gx-surface" />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton({ fields }: { fields: FieldDTO[] }) {
  const names = previewNames(fields, 4);
  return (
    <div className="flex flex-col gap-2">
      {names.map((n) => (
        <div key={n} className="flex items-center gap-2">
          <div className="w-12 shrink-0 text-gx-11 text-gx-text-hint">{n}</div>
          <div className="h-1.5 flex-1 rounded-full bg-gx-separator" />
        </div>
      ))}
    </div>
  );
}
