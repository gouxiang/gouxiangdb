// apps/web/src/features/views/GalleryView.tsx
// 画廊视图：响应式卡片流，封面 + 标题 + 配置字段，点击打开记录抽屉

import { useMemo } from "react";
import { useFields, useTables, useGXMutations } from "../../api/hooks";
import { useRecordsBounded } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import type { FieldDTO, RecordDTO } from "@gx/shared-types";
import { colors } from "@gx/design-tokens";
import { Button, EmptyState, Spinner, toast } from "../../components/ui";
import { ResultNotice, boundedResultText, DEGRADED_RESULT_TEXT } from "../common/ResultNotice";
import { FieldValue, type ViewProps } from "./field-controls";

// 卡片占位封面：accent + secondary 的低饱和渐变，沿用 v1 视觉语言
const COVER_GRADIENT = `linear-gradient(135deg, ${colors.secondaryAlt}33, ${colors.accent}22)`;

export default function GalleryView({
  baseId,
  tableId,
  viewId,
  view,
  permissions,
  onOpenRecord,
}: ViewProps) {
  const bounded = useRecordsBounded({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);
  const { data: tables } = useTables(baseId);
  const m = useGXMutations();

  const table = tables?.find((t) => t.id === tableId);
  const primaryFieldId = table?.primaryFieldId;
  const fields = fieldsRes ?? [];
  const records = bounded.records;
  const isLoading = bounded.isLoading;
  const truncated = bounded.bounded;
  const shownCount = bounded.records.length;
  const degraded = isComputedInMem(bounded.degraded);

  const fieldMap = useMemo(() => {
    const map = new Map<string, FieldDTO>();
    fields.forEach((f) => map.set(f.id, f));
    return map;
  }, [fields]);

  const primaryField = primaryFieldId ? fieldMap.get(primaryFieldId) : undefined;
  const coverField = view.config.coverFieldId ? fieldMap.get(view.config.coverFieldId) : undefined;
  const cardFields = (view.config.cardFieldIds ?? [])
    .map((id) => fieldMap.get(id))
    .filter((f): f is FieldDTO => !!f);

  const openRecord = (r: RecordDTO) => {
    const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "未命名";
    onOpenRecord?.({ tableId, recordId: r.id, title });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // 新建卡片：创建空记录后打开抽屉
  const handleNew = async () => {
    try {
      const { record: rec } = await m.createRecord.mutateAsync({ tableId, fields: {}, viewId, draft: true });
      if (rec) onOpenRecord?.({ tableId, recordId: rec.id, title: "新记录" });
    } catch (err) {
      toast((err as Error)?.message || "新建记录失败", "error");
    }
  };

  return (
    <div className="h-full overflow-auto p-gx-lg">
      {(truncated || degraded) && (
        <div className="mb-3">
          <ResultNotice tone="warning" role={degraded ? "alert" : "status"}>
            {degraded
              ? DEGRADED_RESULT_TEXT
              : boundedResultText(bounded.declaredTotal, shownCount)}
          </ResultNotice>
        </div>
      )}
      {records.length === 0 ? (
        <EmptyState
          icon="gallery"
          title="还没有卡片"
          description="点击下方按钮创建第一张卡片"
          action={
            permissions.canEditData ? (
              <Button variant="primary" icon="plus" onClick={handleNew} className="mt-2">
                新建卡片
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
        >
          {records.map((r) => {
            const title = primaryField ? (r.fields[primaryField.id] as string) ?? "" : "";
            const coverVal = coverField ? (r.fields[coverField.id] as unknown) : null;
            const coverFiles =
              coverField && Array.isArray(coverVal)
                ? (coverVal as Array<{ url: string }>)
                : [];
            return (
              <div
                key={r.id}
                className="group relative flex cursor-pointer flex-col overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface transition-shadow hover:shadow-md"
                onClick={() => openRecord(r)}
              >
                {/* 封面 */}
                <div className="relative h-32 w-full overflow-hidden bg-gx-bg">
                  {coverFiles.length > 0 ? (
                    <img src={coverFiles[0]!.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div
                      className="flex h-full w-full items-center justify-center"
                      style={{ background: COVER_GRADIENT }}
                    >
                      <span className="text-gx-12 text-gx-text-hint">无封面</span>
                    </div>
                  )}
                  {permissions.canEditData && (
                    <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRecord(r);
                        }}
                        className="rounded-gx-sm bg-gx-surface/90 px-1.5 py-0.5 text-gx-12 text-gx-text-secondary shadow"
                      >
                        编辑
                      </button>
                    </div>
                  )}
                </div>

                {/* 标题 */}
                <div className="px-3 pt-2">
                  <div className="text-gx-14 font-semibold text-gx-text-primary">
                    {title || "未命名"}
                  </div>
                </div>

                {/* 配置字段 */}
                <div className="flex flex-col gap-1.5 px-3 pb-3 pt-2">
                  {cardFields.map((f) => (
                    <div key={f.id} className="flex flex-col gap-0.5">
                      <span className="text-gx-11 text-gx-text-tertiary">{f.name}</span>
                      <FieldValue field={f} value={r.fields[f.id] as never} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {permissions.canEditData && records.length > 0 && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" icon="plus" onClick={handleNew}>
            新建卡片
          </Button>
        </div>
      )}
    </div>
  );
}
