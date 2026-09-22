// apps/web/src/features/kb/KbTrashPage.tsx
// /kb/:kbId/trash —— 回收站：文档/画布找回与彻底删除。
//
// 阶段 4 收敛：
//   - 彻底删除从「自建 Modal」改为 feedback.tsx 的 L4 确认（R-D-23/R-D-24），与库级回收站
//     （features/settings/TrashPage.tsx）共用同一套分级口径；
//   - 加载态 ≥300ms 才显示（R-D-15）、失败走 ErrorState（R-D-16）、空态走 EmptyState（R-D-13）；
//   - 长标题截断带 title（R-I-29）。

import { useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Button, EmptyState, Spinner, toast } from "../../components/ui";
import { ErrorState } from "../../components/states";
import { confirmIrreversible } from "../../components/feedback";
import { TruncatedText, useDelayedFlag, useWriteGuard } from "../../components/interaction";
import type { KbDocDTO } from "../../api/client";
import { useKb, useKbTrash, useRestoreDoc, usePurgeDoc } from "./kb-hooks";
import { DocKindIcon, formatTime } from "./kb-ui";

export default function KbTrashPage() {
  const { kbId } = useParams();
  // PERM-S4：找回需要内容编辑权、彻底删除仅所有者。viewer 打开回收站时（可读列表）
  // 不渲染这两个写按钮——原先可点再吃后端 403 toast，属于假入口。
  const { data: kb } = useKb(kbId);
  const canWrite = kb?.role === "owner" || kb?.role === "editor";
  const canPurge = kb?.role === "owner";
  const trashQ = useKbTrash(kbId);
  const { data: docs, isLoading, isError, error, refetch } = trashQ;
  const restore = useRestoreDoc(kbId!);
  const purge = usePurgeDoc(kbId!);
  // R-I-26：找回 / 彻底删除都在途时禁用按钮并去重，避免双击重复提交
  const guard = useWriteGuard();
  // R-D-15：≥300ms 才显示加载态
  const showLoading = useDelayedFlag(isLoading);

  async function doRestore(d: KbDocDTO) {
    await guard.run(`restore:${d.id}`, async () => {
      try {
        await restore.mutateAsync(d.id);
        toast(`已找回「${d.title || "未命名"}」`, "success");
      } catch (e) {
        toast(e instanceof Error ? e.message : "找回失败", "error");
      }
    });
  }

  // R-D-23 L4（不可恢复）+ R-D-24（主按钮用具体动词，不用「确定」）
  async function askPurge(d: KbDocDTO) {
    const ok = await confirmIrreversible({
      title: `彻底删除「${d.title || "未命名"}」`,
      confirmText: "彻底删除",
      description: "将同时删除其全部版本与授权，且不可恢复。",
    });
    if (!ok) return;
    await guard.run(`purge:${d.id}`, async () => {
      try {
        await purge.mutateAsync(d.id);
        toast("已彻底删除", "success");
      } catch (e) {
        toast(e instanceof Error ? e.message : "彻底删除失败", "error");
      }
    });
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
        {isError ? (
          // R-D-16 就地错误卡片 + 重试，不用全屏错误页
          <ErrorState
            title="回收站加载失败"
            reason={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
            retrying={trashQ.isFetching && !isLoading}
          />
        ) : showLoading ? (
          <div className="flex justify-center py-20"><Spinner size={22} /></div>
        ) : (docs ?? []).length === 0 ? (
          // R-D-13 空态三要素：图标 + 主文案 + 次文案 + 行动入口
          <EmptyState
            icon="trash"
            title="回收站为空"
            description="删除的文档与画布会出现在这里，30 天内可以找回。"
          />
        ) : (
          <div className="overflow-hidden rounded-gx-lg border border-gx-border bg-gx-surface">
            {(docs ?? []).map((d, idx) => {
              const busy = guard.isBusy(`restore:${d.id}`) || guard.isBusy(`purge:${d.id}`);
              return (
                <div
                  key={d.id}
                  className={["flex items-center gap-3 px-3 py-2.5", idx !== 0 ? "border-t border-gx-separator" : ""].join(" ")}
                >
                  <DocKindIcon kind={d.kind} size={16} />
                  {/* R-I-29：截断必须带 title 全文 */}
                  <TruncatedText
                    text={d.title || "未命名"}
                    className="min-w-0 flex-1 text-gx-13 text-gx-text-secondary line-through opacity-70"
                  />
                  <span className="hidden shrink-0 text-gx-11 text-gx-text-hint sm:block">删除于 {formatTime(d.deletedAt)}</span>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="restore"
                      loading={guard.isBusy(`restore:${d.id}`)}
                      disabled={busy}
                      disabledReason="操作进行中，请稍候"
                      onClick={() => void doRestore(d)}
                    >
                      找回
                    </Button>
                  )}
                  {canPurge && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      className="text-gx-danger"
                      loading={guard.isBusy(`purge:${d.id}`)}
                      disabled={busy}
                      disabledReason="操作进行中，请稍候"
                      onClick={() => void askPurge(d)}
                    >
                      彻底删除
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
