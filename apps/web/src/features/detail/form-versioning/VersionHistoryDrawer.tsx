// apps/web/src/features/detail/form-versioning/VersionHistoryDrawer.tsx
// 表单布局版本历史抽屉：左列表（按版本号倒序）+ 右只读预览 + 「回退到此版本」。
//
// 预览直接复用详情页的只读渲染器 DetailLayoutRenderer（喂空 values），不另写一套画布。
// 回退的三步语义（先备份当前草稿 → 再填回编辑器 → 不落库）由父级 onRollback 实现，
// 本组件只负责「选版本 / 看预览 / 拿到用户确认」。

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { DetailLayout, FieldDTO, PermissionSet, TabConfig } from "@gx/shared-types";
import { Icon } from "../../../components/icons";
import { Button, Spinner } from "../../../components/ui";
import { confirmAction } from "../../../components/feedback";
import { DetailLayoutRenderer } from "../DetailLayout";
import {
  formatVersionTime,
  formatVersionTimeAgo,
  rollbackBlockReason,
  snapshotStats,
  versionTitle,
  type LayoutSnapshot,
  type LayoutVersionSummary,
} from "./versioning";
import { isEmptyTabsEntry, restoreTabsConfig, TABS_CLEAR_SUPPORTED } from "./tabs-snapshot";
import { useLayoutVersion, useLayoutVersions } from "./useLayoutVersions";

export interface VersionHistoryDrawerProps {
  viewId: string | null;
  tableId: string;
  fields: FieldDTO[];
  permissions: PermissionSet;
  /**
   * 编辑器里**当前**的选项卡配置（tabsFieldId -> TabConfig[]），含未保存改动。
   * 快照只给扁平字段列表时要用它当重建骨架（保住页 id / 页名 / 宽度）；
   * 传它才能保证「预览看到的」与「回退后落到草稿里的」是同一份。
   */
  currentTabs?: Record<string, TabConfig[]>;
  /** 只读身份：隐藏「回退」「存为新版本」两个写入口 */
  readOnly: boolean;
  /** 回退中：禁用按钮防连点 */
  busy?: boolean;
  /** 把当前编辑器草稿存成一个新版本（父级持有草稿，这里只传 label） */
  onCreateVersion?: (label: string) => Promise<void>;
  /** 执行回退三步（父级实现）；reject 时抽屉保持打开 */
  onRollback?: (args: { summary: LayoutVersionSummary; snapshot: LayoutSnapshot }) => Promise<void>;
  onClose: () => void;
}

export function VersionHistoryDrawer({
  viewId,
  tableId,
  fields,
  permissions,
  currentTabs,
  readOnly,
  busy = false,
  onCreateVersion,
  onRollback,
  onClose,
}: VersionHistoryDrawerProps) {
  const { data: versions, isLoading, isError, error } = useLayoutVersions(viewId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const { data: selected, isLoading: loadingDetail } = useLayoutVersion(viewId, selectedId);

  const snapshot = selected?.snapshot ?? null;
  const summary = selected?.detail ?? null;

  // 预览用字段：把该版本的 tabs 配置覆盖进去，否则渲染器读的是当前表上的 tabsConfig，
  // 预览出来的就不是这个历史版本了。
  // 还原策略与**真实回退落库时逐字一致**：同一个纯函数（restoreTabsConfig）+ 同一道
  // 0 页闸门（isEmptyTabsEntry && !TABS_CLEAR_SUPPORTED，见下面的守卫）。少任何一道，
  // 预览就会和真实回退不一致 —— 用户照着预览点回退，结果和看到的不一样，那比没有预览更糟。
  const previewFields = useMemo<FieldDTO[]>(() => {
    if (!snapshot?.tabs) return fields;
    return fields.map((f) => {
      const entry = snapshot.tabs![f.id];
      if (!entry || f.type !== "tabs") return f;
      // 0 页容器：当前后端写不进空数组，真实回退是"保留原样 + 提示不可清空"。
      // 预览必须跟着保留原样，否则预览渲染成"一个页都没有"，回退完却是旧的几页还在。
      if (isEmptyTabsEntry(entry) && !TABS_CLEAR_SUPPORTED) return f;
      return { ...f, tabsConfig: restoreTabsConfig(entry, currentTabs?.[f.id] ?? f.tabsConfig ?? []) };
    });
  }, [fields, snapshot, currentTabs]);

  const previewLayout: DetailLayout | null = snapshot?.layout ?? null;
  // 预览一律只读：不给编辑位，免得用户在历史预览里改到当前数据
  const previewPermissions: PermissionSet = { ...permissions, canEditData: false, canManageSchema: false, canComment: false };

  const blockReason = rollbackBlockReason({
    viewId,
    selectedId,
    snapshot,
    busy,
    readOnly,
  });

  async function saveVersion() {
    if (!onCreateVersion || !label.trim() || busy) return;
    try {
      await onCreateVersion(label.trim());
      setLabel("");
    } catch {
      /* 失败原因由父级 toast，抽屉不重复弹 */
    }
  }

  async function doRollback() {
    if (!onRollback || !snapshot || !summary || blockReason) return;
    const stats = snapshotStats(snapshot);
    const ok = await confirmAction({
      title: `回退到 ${versionTitle(summary)}`,
      confirmText: `回退到 v${summary.version}`,
      cancelText: "继续编辑",
      level: 2,
      description: (
        <div className="space-y-2 text-gx-13 text-gx-text-secondary">
          <p>
            当前编辑器里<b>未保存的改动会被替换掉</b>。替换前会自动把它们存成一个新版本（备注「回退前自动备份」），可随时从历史里找回。
          </p>
          <p className="text-gx-danger">
            同时会一并还原<b>该表单所属数据表上的全部选项卡配置</b>。选项卡配置是数据表级的，不是视图级的 —— 同一张表的其它视图也会跟着变。
          </p>
          <p className="text-gx-text-hint">
            该版本含 {stats.fieldCount} 个顶层字段 / {stats.rowCount} 行、{stats.tabFieldCount} 个选项卡内字段。
            回退只填回编辑器草稿区，<b>不会立即保存</b>，确认无误后再点「保存布局」才真正生效。
          </p>
        </div>
      ),
    });
    if (!ok) return;
    try {
      await onRollback({ summary, snapshot });
    } catch {
      /* 同上：父级负责报错 */
    }
  }

  const drawer = (
    <div className="fixed inset-0 gx-z-drawer flex justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col bg-gx-surface shadow-gx-lg">
        <div className="flex items-center justify-between border-b border-gx-separator px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="history" size={16} className="text-gx-accent" />
            <span className="text-gx-14 font-semibold text-gx-text-primary">布局版本历史</span>
            {/* 与后端留档策略对齐（非 detail 视图不产版本 / 自动版 10 分钟一窗口 / 上限 50 条淘汰最旧的） */}
            <span className="truncate text-gx-12 text-gx-text-hint">保存布局时自动留档，10 分钟内不重复存</span>
          </div>
          <button
            type="button"
            aria-label="关闭版本历史"
            onClick={onClose}
            className="rounded-gx-sm p-1 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：版本列表 */}
          <div className="flex w-64 shrink-0 flex-col border-r border-gx-separator bg-gx-bg">
            {!readOnly && onCreateVersion && (
              <div className="border-b border-gx-separator p-2.5">
                <div className="flex items-center gap-1.5">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveVersion()}
                    placeholder="版本备注，Enter 存当前"
                    className="h-7 min-w-0 flex-1 rounded-gx-sm border border-gx-border bg-gx-surface px-2 text-gx-12 text-gx-text-primary focus:border-gx-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="把当前草稿存为新版本"
                    disabled={!label.trim() || busy}
                    onClick={() => void saveVersion()}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-sm bg-gx-accent text-white hover:brightness-95 disabled:opacity-40"
                  >
                    <Icon name="save" size={14} />
                  </button>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-1.5">
              {isLoading ? (
                <div className="flex justify-center py-10"><Spinner size={18} /></div>
              ) : isError ? (
                <div className="px-2 py-6 text-gx-12 text-gx-danger">{(error as Error)?.message || "版本历史加载失败"}</div>
              ) : (versions ?? []).length === 0 ? (
                <div className="px-2 py-6 text-gx-12 text-gx-text-hint">
                  还没有版本。点「保存布局」会自动留第一版；带备注的手动版本不会被自动清理。
                </div>
              ) : (
                (versions ?? []).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedId(v.id)}
                    className={["mb-1 w-full rounded-gx-sm px-2.5 py-2 text-left transition-colors", selectedId === v.id ? "bg-gx-accent-bg" : "hover:bg-gx-row-hover"].join(" ")}
                  >
                    <div className={["truncate text-gx-13", selectedId === v.id ? "font-medium text-gx-accent" : "text-gx-text-primary"].join(" ")}>
                      {versionTitle(v)}
                    </div>
                    <div className="mt-0.5 text-gx-11 text-gx-text-hint">
                      {formatVersionTimeAgo(v.createdAt, Date.now())} · {formatVersionTime(v.createdAt)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 右：只读预览 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!selectedId ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-gx-text-hint">
                <Icon name="history" size={28} />
                <span className="text-gx-13">选择左侧版本查看预览</span>
              </div>
            ) : loadingDetail ? (
              <div className="flex flex-1 items-center justify-center"><Spinner size={20} /></div>
            ) : !snapshot || !summary ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-gx-13 text-gx-danger">
                该版本的快照无法解析，不能预览或回退。
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-gx-separator px-4 py-2">
                  <div className="min-w-0 truncate text-gx-12 text-gx-text-tertiary">
                    预览 {versionTitle(summary)} · {formatVersionTime(summary.createdAt)}
                    <span className="ml-2 text-gx-text-hint">（只读）</span>
                  </div>
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="primary"
                      icon="rollback"
                      disabled={!!blockReason}
                      disabledReason={blockReason ?? undefined}
                      onClick={() => void doRollback()}
                    >
                      回退到此版本
                    </Button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto bg-gx-bg/50">
                  {previewLayout && previewLayout.rows.length > 0 ? (
                    <DetailLayoutRenderer
                      fields={previewFields}
                      values={{}}
                      layout={previewLayout}
                      tableId={tableId}
                      recordId=""
                      permissions={previewPermissions}
                    />
                  ) : (
                    <div className="p-6 text-gx-13 text-gx-text-hint">这个版本没有排任何字段。</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? drawer : createPortal(drawer, document.body);
}
