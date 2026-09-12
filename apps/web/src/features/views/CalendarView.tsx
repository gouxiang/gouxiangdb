// apps/web/src/features/views/CalendarView.tsx
// 日历视图：月/周视图，按配置的日期字段把记录铺到日期格子里（周日作为一周起点，对齐 NocoDB）

import { useMemo, useState } from "react";
import { useRecords, useFields, useGXMutations } from "../../api/hooks";
import type { FieldDTO, RecordDTO } from "@gx/shared-types";
import { Button, EmptyState, IconButton, SegmentedControl, Spinner, Select } from "../../components/ui";
import { type ViewProps } from "./field-controls";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function CalendarView({
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
  const dateField = fields.find((f) => f.id === view.config.dateFieldId);

  // 未配置日期字段：引导选择
  if (!dateField) {
    const dateFields = fields.filter((f) =>
      ["date", "datetime", "createdTime", "lastModifiedTime"].includes(f.type),
    );
    return (
      <div className="flex h-full items-center justify-center bg-gx-card-bg p-gx-lg">
        <EmptyState
          icon="calendar"
          title="设置日历日期字段"
          description="请选择一个日期字段，用于把记录铺到日历上。"
          action={
            <div className="mt-3 flex items-center gap-2">
              <span className="text-gx-13 text-gx-text-secondary">日期字段：</span>
              <Select
                value=""
                options={[
                  { value: "", label: "请选择…" },
                  ...dateFields.map((f) => ({ value: f.id, label: f.name })),
                ]}
                disabled={!permissions.canManageSchema}
                onChange={(e) => {
                  if (e.target.value) {
                    void m.updateView.mutateAsync({
                      viewId,
                      tableId,
                      data: { config: { dateFieldId: e.target.value } },
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

  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [mode, setMode] = useState<"month" | "week">("month");

  // 按日期分组记录
  const grouped = useMemo(() => {
    const map = new Map<string, RecordDTO[]>();
    records.forEach((r) => {
      const v = r.fields[dateField.id];
      if (v == null || v === "") return;
      // 纯日期 'YYYY-MM-DD' 必须按本地午夜解析：new Date('YYYY-MM-DD') 会被当作 UTC 00:00，
      // 在负时区（西半球）落到前一天导致日历错位；带时间的 ISO 串保持原解析。
      const s = String(v);
      const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
      if (isNaN(d.getTime())) return;
      const k = dayKey(d);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    });
    return map;
  }, [records, dateField]);

  const primaryField = fields.find((f) => f.id === view.config.cardFieldIds?.[0]) ?? fields[0];

  // 生成日期格子
  const cells: Date[] = useMemo(() => {
    const out: Date[] = [];
    if (mode === "month") {
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      const first = new Date(year, month, 1);
      const startOffset = first.getDay(); // 0 = 周日
      const start = new Date(year, month, 1 - startOffset);
      for (let i = 0; i < 42; i++) {
        out.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      }
    } else {
      // 周视图：包含 cursor 的这周（周日开头）
      const dow = cursor.getDay();
      const start = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - dow);
      for (let i = 0; i < 7; i++) {
        out.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
      }
    }
    return out;
  }, [cursor, mode]);

  const curY = cursor.getFullYear();
  const curM = cursor.getMonth();

  const goPrev = () => {
    setCursor(mode === "month" ? new Date(curY, curM - 1, 1) : new Date(curY, curM, cursor.getDate() - 7));
  };
  const goNext = () => {
    setCursor(mode === "month" ? new Date(curY, curM + 1, 1) : new Date(curY, curM, cursor.getDate() + 7));
  };
  const goToday = () => setCursor(new Date());

  const openRecord = (r: RecordDTO) => {
    const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "";
    onOpenRecord?.({ tableId, recordId: r.id, title: title || "未命名" });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const titleText = mode === "month" ? `${curY} 年 ${curM + 1} 月` : `第 ${WEEKDAYS[cursor.getDay()]} 周`;

  return (
    <div className="flex h-full flex-col bg-gx-card-bg">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-surface px-4 py-2">
        <div className="text-gx-16 font-semibold text-gx-text-primary">{titleText}</div>
        <div className="flex items-center gap-1">
          <IconButton icon="chevronLeft" label="上一月/周" onClick={goPrev} />
          <IconButton icon="chevronRight" label="下一月/周" onClick={goNext} />
          <Button variant="ghost" size="sm" onClick={goToday} className="ml-1">
            今天
          </Button>
        </div>
        <div className="ml-auto">
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: "month", label: "月" },
              { value: "week", label: "周" },
            ]}
          />
        </div>
      </div>

      {/* 星期表头 */}
      <div className="grid grid-cols-7 border-b border-gx-separator bg-gx-surface">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className="px-2 py-1.5 text-center text-gx-12 font-medium text-gx-text-tertiary">
            {w}
            {i === 0 && <span className="ml-1 text-gx-text-hint">日</span>}
          </div>
        ))}
      </div>

      {/* 日期格 */}
      <div className="grid flex-1 grid-cols-7 grid-rows-6 overflow-hidden">
        {cells.map((d, idx) => {
          const inMonth = d.getMonth() === curM;
          const isToday = dayKey(d) === dayKey(new Date());
          const dayRecords = grouped.get(dayKey(d)) ?? [];
          return (
            <div
              key={idx}
              className="flex flex-col gap-1 overflow-hidden border-b border-r border-gx-separator p-1.5"
              style={{ borderRightColor: "transparent" }}
            >
              <div
                className={
                  "flex h-5 w-5 items-center justify-center rounded-full text-gx-12 " +
                  (isToday ? "bg-gx-accent-bg font-semibold text-gx-accent" : inMonth ? "text-gx-text-primary" : "text-gx-text-hint")
                }
              >
                {d.getDate()}
              </div>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayRecords.slice(0, 3).map((r) => {
                  const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "";
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => openRecord(r)}
                      className="truncate rounded-gx-sm bg-gx-accent-bg px-1.5 py-0.5 text-left text-gx-11 font-medium text-gx-accent hover:brightness-95"
                      title={title}
                    >
                      {title || "未命名"}
                    </button>
                  );
                })}
                {dayRecords.length > 3 && (
                  <span className="text-gx-11 text-gx-text-hint">+{dayRecords.length - 3}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
