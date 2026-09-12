// apps/web/src/features/kb/KbTrashPage.tsx
// /kb/:kbId/trash —— 回收站：文档/画布找回与彻底删除。

import { useState } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Modal, Spinner, toast } from "../../components/ui";
import type { KbDocDTO } from "../../api/client";
import { useKbTrash, useRestoreDoc, usePurgeDoc } from "./kb-hooks";
import { DocKindIcon, formatTime } from "./kb-ui";

export default function KbTrashPage() {
  const { kbId } = useParams();
  const { data: docs, isLoading } = useKbTrash(kbId);
  const restore = useRestoreDoc(kbId!);
  const purge = usePurgeDoc(kbId!);
  const [purgeTarget, setPurgeTarget] = useState<KbDocDTO | null>(null);

  async function doRestore(d: KbDocDTO) {
    try {
      await restore.mutateAsync(d.id);
      toast("已找回", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "找回失败", "error");
    }
  }

  async function doPurge() {
    if (!purgeTarget) return;
    try {
      await purge.mutateAsync(purgeTarget.id);
      toast("已彻底删除", "success");
      setPurgeTarget(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "彻底删除失败", "error");
    }
  }

  return (
    <div className="flex h-full flex-col bg-gx-bg">
      <div className="border-b border-gx-separator bg-gx-surface px-6 py-4">
        <div className="flex items-center gap-2">
          <Icon name="trash" size={17} className="text-gx-text-tertiary" />
          <h1 className="text-gx-16 font-semibold text-gx-text-primary">回收站</h1>
        </div>
        <p className="mt-1 text-gx-12 text-gx-text-tertiary">删除的文档与画布会保留在此，可找回；彻底删除后不可恢复。</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="flex justify-center py-20"><Spinner size={22} /></div>
        ) : (docs ?? []).length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-gx-text-hint">
            <Icon name="trash" size={28} />
            <span className="text-gx-13">回收站为空</span>
          </div>
        ) : (
          <div className="overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface">
            {(docs ?? []).map((d, idx) => (
              <div
                key={d.id}
                className={["flex items-center gap-3 px-3 py-2.5", idx !== 0 ? "border-t border-gx-separator" : ""].join(" ")}
              >
                <DocKindIcon kind={d.kind} size={16} />
                <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-secondary line-through opacity-70">
                  {d.title || "未命名"}
                </span>
                <span className="hidden text-gx-11 text-gx-text-hint sm:block">删除于 {formatTime(d.deletedAt)}</span>
                <button
                  type="button"
                  onClick={() => doRestore(d)}
                  className="inline-flex h-7 items-center gap-1 rounded-gx-sm border border-gx-border px-2 text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
                >
                  <Icon name="restore" size={13} />
                  找回
                </button>
                <button
                  type="button"
                  onClick={() => setPurgeTarget(d)}
                  className="inline-flex h-7 items-center gap-1 rounded-gx-sm px-2 text-gx-12 text-gx-danger hover:bg-gx-danger-bg"
                >
                  <Icon name="trash" size={13} />
                  彻底删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
              onClick={doPurge}
              disabled={purge.isPending}
            >
              彻底删除
            </button>
          </>
        }
      >
        <p className="text-gx-13 text-gx-text-secondary">
          彻底删除「{purgeTarget?.title}」将同时删除其全部版本与授权，且<b>不可恢复</b>。确定继续吗？
        </p>
      </Modal>
    </div>
  );
}
