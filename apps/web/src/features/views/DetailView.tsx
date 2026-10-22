// apps/web/src/features/views/DetailView.tsx
// 详情视图：每条记录一张卡片，按 detailLayout（detailLayout）自由布局
//  - 无 layout 时：走 deriveDefaultDetailLayout（与设计器首次打开同源，按字段类型默认宽度自动切行）
//  - 有 layout 时：按 rows 渲染（每行 colCount 决定 1-4 列，长字段跨整行）
//  - 顶部工具栏：编辑布局按钮（可拖拽换序、行内分栏）

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useFields, useTables, useGXMutations } from "../../api/hooks";
import { useRecordsInfinite } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import type { DetailLayout, FieldDTO, RecordDTO } from "@gx/shared-types";
import { Button, EmptyState, IconButton, Menu, MenuItem, Popover, Spinner, toast } from "../../components/ui";
// 阶段 4：删除统一走 L2 确认 + 撤销 toast（R-D-23 / R-I-08 / R-D-22）
import { confirmSoftDelete } from "../../components/feedback";
import { toastDeleted } from "../../components/interaction";
import { ResultNotice, DEGRADED_RESULT_TEXT } from "../common/ResultNotice";
import { DetailLayoutEditor, DetailLayoutRenderer } from "../detail/DetailLayout";
import type { ViewProps } from "./field-controls";

export default function DetailView({
  baseId,
  tableId,
  viewId,
  view,
  permissions,
  onOpenRecord,
}: ViewProps) {
  const infinite = useRecordsInfinite({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);
  const { data: tables } = useTables(baseId);
  const m = useGXMutations();

  const table = tables?.find((t) => t.id === tableId);
  const fields = (fieldsRes ?? []).filter((f) => !f.isReverse);
  const records = infinite.records;
  const isLoading = infinite.isLoading;
  const degraded = isComputedInMem(infinite.degraded);
  const primaryField = table?.primaryFieldId
    ? fields.find((f) => f.id === table.primaryFieldId)
    : undefined;

  // 详情显示的字段：detailFieldIds 优先；为空则显示全部非隐藏字段
  const visibleFields = useMemo(() => {
    const hidden = new Set(view.config.hiddenFieldIds ?? []);
    const ids = view.config.detailFieldIds ?? [];
    if (ids.length > 0) {
      return ids.map((id) => fields.find((f) => f.id === id)).filter((f): f is FieldDTO => !!f);
    }
    return fields.filter((f) => !hidden.has(f.id));
  }, [fields, view.config.detailFieldIds, view.config.hiddenFieldIds]);

  const layout = (view.config.detailLayout as DetailLayout | null) ?? null;

  const [editingLayout, setEditingLayout] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);

  // URL ?design=1 自动进入表单设计器（Sidebar 数据表 ⋮「编辑表单」入口用）
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("design") === "1" && permissions.canManageSchema) {
      setEditingLayout(true);
      // 去掉 query 参数，避免刷新反复进入
      const next = new URLSearchParams(searchParams);
      next.delete("design");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, permissions.canManageSchema]);

  const openRecord = (r: RecordDTO) => {
    const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "未命名";
    onOpenRecord?.({ tableId, recordId: r.id, title: title || "未命名" });
  };

  // 阶段 4 · R-D-23 L2（软删除进回收站，可恢复）+ R-I-08（toast 带撤销）
  const handleDelete = async (r: RecordDTO) => {
    if (!permissions.canEditData) return;
    const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "";
    const name = title || "未命名";
    const ok = await confirmSoftDelete({
      title: `删除记录「${name}」`,
      confirmText: "删除记录",
      description: "记录会移入回收站，30 天内可恢复。",
    });
    if (!ok) return;
    try {
      await m.deleteRecord.mutateAsync({ recordId: r.id, tableId, viewId });
      toastDeleted({
        message: `已删除记录「${name}」`,
        restoredMessage: `已恢复记录「${name}」`,
        onUndo: () => m.restoreTrash.mutateAsync({ id: r.id, kind: "record", baseId }),
      });
    } catch (err) {
      toast((err as Error).message || "删除失败", "error");
    }
  };

  const handleNew = async () => {
    if (!permissions.canEditData) return;
    try {
      const { record: rec } = await m.createRecord.mutateAsync({ tableId, fields: {}, viewId, draft: true });
      onOpenRecord?.({ tableId, recordId: rec.id, title: "新记录" });
    } catch (err) {
      toast((err as Error)?.message || "新建记录失败", "error");
    }
  };

  const canEditLayout = permissions.canEditData || permissions.canManageSchema;

  if (editingLayout) {
    return (
      <div className="flex h-full flex-col">
        <DetailLayoutEditor
          inline
          open
          fields={fields}
          layout={layout}
          tableId={tableId}
          baseId={baseId}
          tables={tables ?? []}
          permissions={permissions}
          viewId={viewId}
          onClose={() => setEditingLayout(false)}
          // 必须是 mutateAsync 并让 reject 冒泡：失败时 FormDesigner 会保持面板打开
          // 并展示真实错误；这里不能再无条件 setEditingLayout(false)（P1 静默数据丢失）。
          onSave={async (next) => {
            await m.updateView.mutateAsync({ viewId, tableId, data: { config: { detailLayout: next } } });
          }}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-gx-lg">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {degraded && (
          <ResultNotice tone="warning" role="alert">
            {DEGRADED_RESULT_TEXT}
          </ResultNotice>
        )}
        {/* 顶部工具栏：齿轮菜单（编辑表单 / 重置布局） */}
        {canEditLayout && records.length > 0 && (
          <div className="flex items-center justify-end">
            <Popover open={gearOpen} onClose={() => setGearOpen(false)} align="right" width={200}>
              <Menu width={200}>
                <MenuItem
                  icon="edit"
                  label="编辑表单"
                  description="拖拽排列字段"
                  onClick={() => {
                    setGearOpen(false);
                    setEditingLayout(true);
                  }}
                />
                <MenuItem
                  icon="refresh"
                  label="重置为默认布局"
                  description="清空 detailLayout"
                  onClick={async () => {
                    setGearOpen(false);
                    if (!permissions.canManageSchema) {
                      toast("需要表结构管理权限", "error");
                      return;
                    }
                    // 同 P1 缺陷形态：mutate 不抛错，失败也会 toast「已重置布局」。
                    // 改 mutateAsync，只有 await 成功才提示成功。
                    try {
                      await m.updateView.mutateAsync({ viewId, tableId, data: { config: { detailLayout: null } } });
                      toast("已重置布局", "success");
                    } catch (err) {
                      toast((err as Error).message || "重置布局失败，请重试", "error");
                    }
                  }}
                />
              </Menu>
            </Popover>
            <IconButton icon="settings" label="字段设置" onClick={() => setGearOpen((v) => !v)} />
          </div>
        )}

        {records.length === 0 ? (
          <EmptyState
            icon="detail"
            title="暂无记录"
            description="点击右下角新建记录开始添加数据。"
          />
        ) : (
          records.map((r) => {
            const title = primaryField ? String(r.fields[primaryField.id] ?? "") : "未命名";
            return (
              <div
                key={r.id}
                className="overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface"
              >
                {/* 卡片头 */}
                <div className="flex items-center gap-2 border-b border-gx-separator px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => openRecord(r)}
                    className="flex-1 truncate text-left text-gx-14 font-semibold text-gx-text-primary hover:underline"
                  >
                    {title || "未命名"}
                  </button>
                  {permissions.canEditData && (
                    <div className="flex items-center gap-1">
                      <IconButton icon="edit" label="编辑" onClick={() => openRecord(r)} />
                      <IconButton icon="trash" label="删除" danger onClick={() => void handleDelete(r)} />
                    </div>
                  )}
                </div>

                {/* 字段行（按 detailLayout）。用全量字段：选项卡内字段靠 field.tabsConfig 解析，
                    若按 visibleFields/detailFieldIds 白名单过滤，tab 内字段会找不到而不显示。 */}
                <DetailLayoutRenderer
                  fields={fields}
                  values={(r.fields as Record<string, never>) ?? {}}
                  layout={layout}
                  tableId={tableId}
                  recordId={r.id}
                  permissions={permissions}
                />
              </div>
            );
          })
        )}

        {records.length > 0 && (infinite.hasNextPage || permissions.canEditData) && (
          <div className="mx-auto mt-2 flex max-w-5xl items-center justify-center gap-2">
            {infinite.hasNextPage && (
              <Button
                variant="secondary"
                size="sm"
                loading={infinite.isFetchingNextPage}
                onClick={() => infinite.loadMore()}
              >
                加载更多
              </Button>
            )}
            {permissions.canEditData && (
              <Button variant="secondary" icon="plus" onClick={handleNew}>
                新建记录
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}