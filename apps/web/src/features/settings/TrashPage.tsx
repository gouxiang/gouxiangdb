// apps/web/src/features/settings/TrashPage.tsx
// 回收站：列出已删除项，支持恢复 / 彻底删除（二次确认）
// 权限：canEditData 可恢复；canManageBase 可彻底删除

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBase, useTrash, useGXMutations } from "../../api/hooks";
import { Button, EmptyState, Modal, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { TrashItemDTO } from "@gx/shared-types";

const KIND_ICON: Record<TrashItemDTO["kind"], "table" | "field" | "detail"> = {
  table: "table",
  field: "field",
  record: "detail",
};

const KIND_LABEL: Record<TrashItemDTO["kind"], string> = {
  table: "数据表",
  field: "字段",
  record: "记录",
};

function fmt(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("zh-CN", { hour12: false });
}

export default function TrashPage() {
  const { baseId } = useParams();
  const { data: items, isLoading } = useTrash(baseId ?? null);
  const baseQ = useBase(baseId ?? null);
  const m = useGXMutations();

  const canEditData = baseQ.data?.permissions?.canEditData ?? false;
  const canManageBase = baseQ.data?.permissions?.canManageBase ?? false;

  const [purgeTarget, setPurgeTarget] = useState<TrashItemDTO | null>(null);

  async function restore(it: TrashItemDTO) {
    try {
      await m.restoreTrash.mutateAsync({ id: it.id, kind: it.kind, baseId: baseId! });
      toast("已恢复", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "恢复失败", "error");
    }
  }

  async function confirmPurge() {
    if (!purgeTarget) return;
    try {
      await m.purgeTrash.mutateAsync({ id: purgeTarget.id, kind: purgeTarget.kind, baseId: baseId! });
      setPurgeTarget(null);
      toast("已彻底删除", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  async function purgeAll() {
    if (!items) return;
    try {
      for (const it of items) {
        await m.purgeTrash.mutateAsync({ id: it.id, kind: it.kind, baseId: baseId! });
      }
      toast("回收站已清空", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败", "error");
    }
  }

  return (
    <div className="flex h-full flex-col bg-gx-surface">
      <div className="flex h-12 items-center justify-between border-b border-gx-separator px-4">
        <span className="text-gx-14 font-semibold text-gx-text-primary">回收站</span>
        {canManageBase && items && items.length > 0 && (
          <Button size="sm" variant="ghost" className="text-gx-danger" onClick={purgeAll}>
            清空回收站
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && <div className="py-10 text-center text-gx-13 text-gx-text-hint">加载中…</div>}

        {!isLoading && (!items || items.length === 0) && (
          <EmptyState icon="trash" title="回收站是空的" description="被删除的数据表、字段与记录会暂时保存在这里" />
        )}

        {items && items.length > 0 && (
          <div className="overflow-hidden rounded-gx-lg border border-gx-border">
            <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
              <span className="w-16">类型</span>
              <span className="flex-1">名称</span>
              <span className="w-40">所属</span>
              <span className="w-44">删除时间</span>
              <span className="w-32 text-right">操作</span>
            </div>
            {items.map((it) => (
              <div key={`${it.kind}-${it.id}`} className="flex items-center gap-3 border-b border-gx-separator px-3 py-2 last:border-0">
                <span className="flex w-16 items-center gap-1 text-gx-12 text-gx-text-tertiary">
                  <Icon name={KIND_ICON[it.kind]} size={14} />
                  {KIND_LABEL[it.kind]}
                </span>
                <span className="flex-1 truncate text-gx-13 text-gx-text-primary">{it.name}</span>
                <span className="w-40 truncate text-gx-12 text-gx-text-tertiary">{it.parentName ?? "—"}</span>
                <span className="w-44 text-gx-12 text-gx-text-tertiary">{fmt(it.deletedAt)}</span>
                <div className="flex w-32 items-center justify-end gap-1">
                  <button
                    type="button"
                    disabled={!canEditData}
                    onClick={() => restore(it)}
                    className="rounded-gx-sm px-2 py-1 text-gx-12 text-gx-accent hover:bg-gx-accent-bg disabled:cursor-not-allowed disabled:text-gx-text-hint disabled:hover:bg-transparent"
                    title={canEditData ? "恢复" : "无编辑权限"}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    disabled={!canManageBase}
                    onClick={() => setPurgeTarget(it)}
                    className="rounded-gx-sm px-2 py-1 text-gx-12 text-gx-danger hover:bg-gx-danger-bg disabled:cursor-not-allowed disabled:text-gx-text-hint disabled:hover:bg-transparent"
                    title={canManageBase ? "彻底删除" : "仅所有者可彻底删除"}
                  >
                    彻底删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 彻底删除二次确认 */}
      <Modal
        open={!!purgeTarget}
        title="彻底删除"
        onClose={() => setPurgeTarget(null)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setPurgeTarget(null)}>
              取消
            </button>
            <button
              className="rounded-gx-md bg-gx-danger px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
              onClick={confirmPurge}
            >
              彻底删除
            </button>
          </>
        }
      >
        <div className="text-gx-13 text-gx-text-secondary">
          确定要彻底删除「{purgeTarget?.name}」吗？此操作不可恢复。
        </div>
      </Modal>
    </div>
  );
}
