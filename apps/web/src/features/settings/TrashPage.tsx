// apps/web/src/features/settings/TrashPage.tsx
// 回收站：**双选项卡**列出已删除项，支持恢复 / 彻底删除（二次确认）
// 权限：canEditData 可恢复；canManageBase 可彻底删除
//
// 双选项卡（2026-09-20 补做）：
//   A「数据表删除与恢复」= 表与字段（结构类，原有能力）
//   B「数据删除与恢复」  = 记录（数据类）
// 后端 `POST /trash/:id/restore` 的 record 分支一直存在（apps/api/src/routes/records.ts:810
// 起，是三个分支里的第一个），删除-恢复链路本就打通；此前只是前端把三种 kind 混在
// 一个列表里展示，结构类与数据类互相干扰。本页改动=呈现层拆分，未新增任何接口。

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBase, useTrash, useGXMutations } from "../../api/hooks";
import { Button, EmptyState, SegmentedControl, toast } from "../../components/ui";
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

/** A = 结构类（表 / 字段）；B = 数据类（记录）。 */
type TrashTab = "schema" | "record";

const TABS: readonly { value: TrashTab; label: string; empty: string }[] = [
  { value: "schema", label: "数据表删除与恢复", empty: "被删除的数据表与字段会暂时保存在这里" },
  { value: "record", label: "数据删除与恢复", empty: "被删除的记录会暂时保存在这里" },
];

/** 按选项卡过滤（纯函数，便于单测直接覆盖三种 kind × 两个选项卡）。 */
export function filterTrashByTab(items: TrashItemDTO[], tab: TrashTab): TrashItemDTO[] {
  return items.filter((it) => (tab === "record" ? it.kind === "record" : it.kind !== "record"));
}

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

  const [tab, setTab] = useState<TrashTab>("schema");
  const activeTab = TABS.find((t) => t.value === tab)!;
  /** 按选项卡过滤：A 只留结构类，B 只留记录。恢复 / 彻底删除逐项走同一个 kind 分派的接口。 */
  const visible = filterTrashByTab(items ?? [], tab);

  const canEditData = baseQ.data?.permissions?.canEditData ?? false;
  const canManageBase = baseQ.data?.permissions?.canManageBase ?? false;

  async function restore(it: TrashItemDTO) {
    try {
      const res = await m.restoreTrash.mutateAsync({ id: it.id, kind: it.kind, baseId: baseId! });
      // 后端恢复字段/表时若同名活实体已存在会自动改名（T-1），此处按契约把最终名字告知用户；
      // 恢复出来的实体名字以 res.name 为准（列表/侧栏由 invalidateAll 重新拉取，不做乐观写入）。
      if ("renamed" in res && res.renamed) {
        toast(`「${it.name}」这个名字已被占用，已恢复为「${res.name}」`, "success");
      } else {
        toast("已恢复", "success");
      }
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

  /** 只清空**当前选项卡**里的项：另一个选项卡的内容不该被顺手清掉。 */
  async function purgeAll() {
    if (visible.length === 0) return;
    const ok = await confirmIrreversible({
      title: "清空回收站",
      confirmText: "清空回收站",
      description: `「${activeTab.label}」里的 ${visible.length} 项会被永久删除，不可恢复。`,
    });
    if (!ok) return;
    try {
      for (const it of visible) {
        await m.purgeTrash.mutateAsync({ id: it.id, kind: it.kind, baseId: baseId! });
      }
      toast("回收站已清空", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败", "error");
    }
  }

  return (
    // v6 #985：灰页底（--bg），顶条/选项卡条为白底发丝线，列表为白卡（r12 + sh-card）。
    <div className="flex h-full flex-col bg-gx-bg">
      <div className="flex h-12 items-center justify-between border-b border-gx-hairline bg-gx-surface px-4">
        <span className="text-gx-14 font-semibold text-gx-text-primary">回收站</span>
        {canManageBase && visible.length > 0 && (
          <Button size="sm" variant="ghost" className="text-gx-danger" onClick={purgeAll}>
            清空回收站
          </Button>
        )}
      </div>

      {/* 选项卡行：结构类与数据类分开，各自独立的空态 / 计数 / 清空范围 */}
      <div className="flex items-center gap-2 border-b border-gx-hairline bg-gx-surface px-4 py-2">
        <SegmentedControl
          value={tab}
          options={TABS.map((t) => ({ value: t.value, label: t.label }))}
          onChange={setTab}
        />
        {visible.length > 0 && (
          <span className="text-gx-12 text-gx-text-hint">{visible.length} 项</span>
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

        {!isError && !isLoading && visible.length === 0 && (
          // R-D-13 空态三要素齐备：图标 + 主文案 + 次文案 + 一个主行动入口
          <EmptyState
            icon="trash"
            title="回收站是空的"
            description={activeTab.empty}
            action={
              <Button variant="primary" size="sm" onClick={() => baseId && navigate(`/base/${baseId}`)}>
                返回该库
              </Button>
            }
          />
        )}

        {!isError && visible.length > 0 && (
          <div className="overflow-hidden rounded-gx-2xl border border-gx-hairline bg-gx-surface shadow-gx-card">
            <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
              <span className="w-16">类型</span>
              <span className="flex-1">名称</span>
              <span className="w-40">所属</span>
              <span className="w-44">删除时间</span>
              <span className="w-32 text-right">操作</span>
            </div>
            {visible.map((it) => (
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
