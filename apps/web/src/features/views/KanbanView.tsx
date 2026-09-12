// apps/web/src/features/views/KanbanView.tsx
// 看板视图：按 singleSelect 字段分列，支持 HTML5 拖拽换列

import { useMemo, useState } from "react";
import { useRecords, useFields, useGXMutations } from "../../api/hooks";
import type { FieldDTO, RecordDTO } from "@gx/shared-types";
import { Button, EmptyState, Spinner, Select, toast } from "../../components/ui";
import { FieldValue, resolveSelectOption, type ViewProps } from "./field-controls";

export default function KanbanView({
  tableId,
  viewId,
  view,
  permissions,
  onOpenRecord,
}: ViewProps) {
  const { data: recordsRes, isLoading } = useRecords({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);
  const m = useGXMutations();

  const fields = fieldsRes ?? [];
  const records = recordsRes?.records ?? [];
  const kanbanField = fields.find((f) => f.id === view.config.kanbanFieldId);

  // 未配置分组字段：引导用户选择一个 singleSelect 字段
  if (!kanbanField || kanbanField.type !== "singleSelect") {
    const selectable = fields.filter((f) => f.type === "singleSelect");
    return (
      <div className="flex h-full items-center justify-center bg-gx-card-bg p-gx-lg">
        <EmptyState
          icon="kanban"
          title="设置看板分组字段"
          description="请选择一个「单选」字段作为看板的分组依据。"
          action={
            <div className="mt-3 flex items-center gap-2">
              <span className="text-gx-13 text-gx-text-secondary">分组字段：</span>
              <Select
                value=""
                options={
                  selectable.length === 0
                    ? [{ value: "", label: "暂无可用的单选字段" }]
                    : [{ value: "", label: "请选择…" }, ...selectable.map((f) => ({ value: f.id, label: f.name }))]
                }
                disabled={selectable.length === 0 || !permissions.canManageSchema}
                onChange={(e) => {
                  if (e.target.value) {
                    void m.updateView.mutateAsync({
                      viewId,
                      tableId,
                      data: { config: { kanbanFieldId: e.target.value } },
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

  const options = kanbanField.options ?? [];
  // 列：每个选项 + 一个「未分类」
  const columns = [
    ...options.map((o) => ({ key: o.id, label: o.name, color: o.color, value: o.name })),
    { key: "__none__", label: "未分类", color: null as string | null, value: null as string | null },
  ];

  const [dragId, setDragId] = useState<string | null>(null);

  // 按列分组记录
  const grouped = useMemo(() => {
    const map = new Map<string, RecordDTO[]>();
    columns.forEach((c) => map.set(c.key, []));
    records.forEach((r) => {
      const opt = resolveSelectOption(kanbanField, r.fields[kanbanField.id] as never);
      const key = opt ? opt.id : "__none__";
      map.get(key)?.push(r);
    });
    return map;
  }, [records, kanbanField, columns]);

  const primaryField = fields.find((f) => f.id === view.config.cardFieldIds?.[0]) ?? fields[0];

  const moveTo = async (recordId: string, value: string | null) => {
    if (!permissions.canEditData) return;
    try {
      await m.updateRecord.mutateAsync({
        recordId,
        fields: { [kanbanField.id]: value },
        tableId,
        viewId,
      });
    } catch {
      /* 错误由全局 toast 处理 */
    }
  };

  const addInColumn = async (value: string | null) => {
    if (!permissions.canEditData) return;
    try {
      const { record: rec } = await m.createRecord.mutateAsync({
        tableId,
        fields: value ? { [kanbanField.id]: value } : {},
        viewId,
        draft: true,
      });
      if (rec) onOpenRecord?.({ tableId, recordId: rec.id, title: "新记录" });
    } catch (err) {
      toast((err as Error)?.message || "新建记录失败", "error");
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-full overflow-x-auto bg-gx-card-bg p-gx-lg">
      <div className="flex h-full gap-3" style={{ minWidth: columns.length * 280 }}>
        {columns.map((col) => {
          const colRecords = grouped.get(col.key) ?? [];
          return (
            <div
              key={col.key}
              className="flex h-full w-[280px] flex-shrink-0 flex-col rounded-gx-lg border border-gx-border bg-gx-bg"
              onDragOver={(e) => permissions.canEditData && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) void moveTo(dragId, col.value);
                setDragId(null);
              }}
            >
              {/* 列头 */}
              <div className="flex items-center gap-2 border-b border-gx-separator px-3 py-2">
                {col.color ? (
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: col.color }} />
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full bg-gx-text-hint" />
                )}
                <span className="text-gx-13 font-medium text-gx-text-primary">{col.label}</span>
                <span className="ml-auto rounded-full bg-gx-surface px-1.5 text-gx-11 text-gx-text-tertiary">
                  {colRecords.length}
                </span>
              </div>

              {/* 卡片 */}
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {colRecords.map((r) => {
                  const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "";
                  const subFields = fields
                    .filter((f) => f.id !== primaryField?.id && f.id !== kanbanField.id && !f.isReverse)
                    .slice(0, 3);
                  return (
                    <div
                      key={r.id}
                      draggable={permissions.canEditData}
                      onDragStart={() => setDragId(r.id)}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => onOpenRecord?.({ tableId, recordId: r.id, title: title || "未命名" })}
                      className="cursor-pointer rounded-gx-md border border-gx-border bg-gx-surface p-2.5 transition-shadow hover:shadow-sm"
                    >
                      <div className="text-gx-13 font-medium text-gx-text-primary">{title || "未命名"}</div>
                      {subFields.map((f) => (
                        <div key={f.id} className="mt-1 flex items-start gap-1.5">
                          <span className="text-gx-11 text-gx-text-tertiary">{f.name}</span>
                          <FieldValue field={f} value={r.fields[f.id] as never} />
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* 列底新增 */}
              {permissions.canEditData && (
                <div className="border-t border-gx-separator p-2">
                  <Button
                    variant="ghost"
                    icon="plus"
                    size="sm"
                    block
                    onClick={() => void addInColumn(col.value)}
                  >
                    添加
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
