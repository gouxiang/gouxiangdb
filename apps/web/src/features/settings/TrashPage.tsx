// apps/web/src/features/settings/TrashPage.tsx
// 回收站：列出已删除项，支持恢复 / 彻底删除（二次确认）
// 权限：canEditData 可恢复；canManageBase 可彻底删除

import { useNavigate, useParams } from "react-router-dom";
import { useBase, useTrash, useGXMutations } from "../../api/hooks";
import { Button, EmptyState, toast } from "../../components/ui";
// 阶段 4：R-D-15 延迟加载态 / R-D-16 错误态 / R-I-29 截断带 title
import { ErrorState, SkeletonList } from "../../components/states";
import { confirmIrreversible } from "../../components/feedback";
import { TruncatedText, useDelayedFlag } from "../../components/interaction";
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
  const navigate = useNavigate();
  const trashQ = useTrash(baseId ?? null);
  const { data: items, isLoading, isError, error, refetch } = trashQ;
  const baseQ = useBase(baseId ?? null);
  const m = useGXMutations();
  // R-D-15：≥300ms 才显示骨架屏，避免「空白 → 骨架 → 内容」的闪烁
  const showSkeleton = useDelayedFlag(isLoading);

  const canEditData = baseQ.data?.permissions?.canEditData ?? false;
  const canManageBase = baseQ.data?.permissions?.canManageBase ?? false;

  async function restore(it: TrashItemDTO) {
    try {
      await m.restoreTrash.mutateAsync({ id: it.id, kind: it.kind, baseId: baseId! });
      toast("已恢复", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "恢复失败", "error");
    }
  }

  // R-D-23/L4 不可恢复 → 红色确认；R-D-24 主按钮用具体动词（不用「确定」）
  async function askPurge(it: TrashItemDTO) {
    const ok = await confirmIrreversible({
      title: "彻底删除",
      confirmText: "彻底删除",
      description: `「${it.name}」（${KIND_LABEL[it.kind]}）会被永久删除，不进回收站、不可恢复。`,
    });
    if (!ok) return;
    try {
      await m.purgeTrash.mutateAsync({ id: it.id, kind: it.kind, baseId: baseId! });
      toast("已彻底删除", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  async function purgeAll() {
    if (!items) return;
    const ok = await confirmIrreversible({
      title: "清空回收站",
      confirmText: "清空回收站",
      description: `回收站里的 ${items.length} 项会被永久删除，不可恢复。`,
    });
    if (!ok) return;
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
        {/* R-D-16 区域加载失败：就地卡片 + 重试（回收站不是路由级失败，不上全屏错误页） */}
        {isError && (
          <ErrorState
            title="回收站加载失败"
            reason={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
            retrying={trashQ.isFetching && !isLoading}
          />
        )}

        {/* R-D-15/25 列表首屏用骨架屏（≥300ms 才显示），不用「加载中…」裸文案 */}
        {!isError && showSkeleton && <SkeletonList rows={5} className="px-0" />}

        {!isError && !isLoading && (!items || items.length === 0) && (
          // R-D-13 空态三要素齐备：图标 + 主文案 + 次文案 + 一个主行动入口
          <EmptyState
            icon="trash"
            title="回收站是空的"
            description="被删除的数据表、字段与记录会暂时保存在这里"
            action={
              <Button variant="primary" size="sm" onClick={() => baseId && navigate(`/base/${baseId}`)}>
                返回该库
              </Button>
            }
          />
        )}

        {!isError && items && items.length > 0 && (
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
                {/* R-I-29 长名称截断必须带 title 全文 */}
                <TruncatedText text={it.name} className="flex-1 text-gx-13 text-gx-text-primary" />
                <TruncatedText text={it.parentName ?? "—"} className="w-40 text-gx-12 text-gx-text-tertiary" />
                <span className="w-44 text-gx-12 text-gx-text-tertiary">{fmt(it.deletedAt)}</span>
                <div className="flex w-32 items-center justify-end gap-1">
                  <button
                    type="button"
                    disabled={!canEditData}
                    onClick={() => restore(it)}
                    className="rounded-gx-lg px-2 py-1 text-gx-12 text-gx-accent hover:bg-gx-accent-bg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    title={canEditData ? "恢复" : "无编辑权限"}
                  >
                    恢复
                  </button>
                  {/* 权限治理第二批：「彻底删除」不可逆，无权限即不渲染。
                      左侧「恢复」是写回数据（数据编辑类），保留 disabled + 原因，不跟着藏。 */}
                  {canManageBase && (
                    <button
                      type="button"
                      onClick={() => void askPurge(it)}
                      className="rounded-gx-lg px-2 py-1 text-gx-12 text-gx-danger hover:bg-gx-danger-bg"
                      title="彻底删除"
                    >
                      彻底删除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
