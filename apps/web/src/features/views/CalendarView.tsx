// apps/web/src/features/views/CalendarView.tsx
// 日历视图：月/周视图，按配置的日期字段把记录铺到日期格子里（周日作为一周起点，对齐 NocoDB）
//
// hooks 顺序约定：本组件先无条件跑完全部 hooks，再按「日期字段是否已配置」早返回引导空态。
// 空态已抽成独立子组件 CalendarSetup（见文件末尾）——早返回若发生在 hooks 之前，首帧
// useFields 尚未返回（fields 空 → 走空态少跑 hook）、次帧字段到达（走主分支多跑 hook）
// 会命中 React #310「Rendered more hooks than during the previous render」整块崩溃。

import { useMemo, useState } from "react";
import { useFields, useGXMutations } from "../../api/hooks";
import { useRecordsBounded } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import type { FieldDTO, RecordDTO } from "@gx/shared-types";
import { Button, EmptyState, IconButton, SegmentedControl, Spinner, Select } from "../../components/ui";
import { ResultNotice, boundedResultText, DEGRADED_RESULT_TEXT } from "../common/ResultNotice";
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
  const bounded = useRecordsBounded({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);

  const fields = fieldsRes ?? [];
  const records = bounded.records;
  const isLoading = bounded.isLoading;
  const truncated = bounded.bounded;
  const shownCount = bounded.records.length;
  const degraded = isComputedInMem(bounded.degraded);
  const dateField = fields.find((f) => f.id === view.config.dateFieldId);

  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [mode, setMode] = useState<"month" | "week">("month");

  // 按日期分组记录
  const grouped = useMemo(() => {
    const map = new Map<string, RecordDTO[]>();
    if (!dateField) return map;
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

  // 未配置日期字段：引导选择。
  // 必须晚于上面全部 hooks —— 守卫结果会随 useFields 首帧空/次帧到达而翻转。
  if (!dateField) {
    return (
      <CalendarSetup
        tableId={tableId}
        viewId={viewId}
        fields={fields}
        canManageSchema={permissions.canManageSchema}
      />
    );
  }

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
    <div className="flex h-full flex-col">
      {(truncated || degraded) && (
        <div className="shrink-0 px-4 pt-2">
          <ResultNotice tone="warning" role={degraded ? "alert" : "status"}>
            {degraded
              ? DEGRADED_RESULT_TEXT
              : boundedResultText(bounded.declaredTotal, shownCount)}
          </ResultNotice>
        </div>
      )}
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
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-1.5 text-center text-gx-12 font-medium text-gx-text-tertiary">
            {w}
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

/**
 * 未配置日期字段时的引导空态（独立组件）。
 * 拆出来是为了让父组件 CalendarView 的 hooks 无条件跑完：守卫早返回留在父组件里会让
 * 「首帧字段未到 / 次帧字段到达」两次渲染的 hook 数量不一致，命中 React #310。
 */
function CalendarSetup({
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
  const dateFields = fields.filter((f) =>
    ["date", "datetime", "createdTime", "lastModifiedTime"].includes(f.type),
  );
  return (
    <div className="flex h-full items-center justify-center p-gx-lg">
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
              disabled={!canManageSchema}
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
