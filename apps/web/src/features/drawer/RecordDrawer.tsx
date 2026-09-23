// apps/web/src/features/drawer/RecordDrawer.tsx
// 记录抽屉：所有视图共用的右侧详情/编辑面板
//  - 从右侧滑出（transition-transform + translate-x-full/0）
//  - 逐字段内联编辑，失焦即保存
//  - 评论面板（useComments + addComment/removeComment）
//  - 系统信息 + 上一条/下一条 + 删除/新建
//  - Esc 关闭

import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { useRecord, useRecords, useFields, useTables, useViews, useComments, useGXMutations } from "../../api/hooks";
import { useAuthStore } from "../../store/auth";
import type { CellValue, FieldDTO, PermissionSet } from "@gx/shared-types";
import {
  Button,
  FieldIcon,
  IconButton,
  Spinner,
  Textarea,
  toast,
} from "../../components/ui";
import { DetailLayoutEditor, DetailLayoutRenderer } from "../detail/DetailLayout";
import { Icon } from "../../components/icons";
// 阶段 4：删除走 L2 确认 + 统一撤销 toast；写操作走在途守卫（R-D-23 / R-I-08 / R-I-26）
import { confirmSoftDelete } from "../../components/feedback";
import { toastDeleted, useWriteGuard } from "../../components/interaction";

export interface RecordDrawerProps {
  open: boolean;
  recordId: string | null;
  tableId: string;
  baseId: string;
  viewId: string | null;
  permissions: PermissionSet;
  onClose: () => void;
  onCreateNew?: () => void;
}

// 抽屉宽度持久化的 localStorage key（与 v1 DrawerLayout 一致，便于跨端同步）
const DRAWER_WIDTH_KEY = "gx.drawerWidth.v1";
const DEFAULT_DRAWER_WIDTH = 560;
const MIN_DRAWER_WIDTH = 340;
const MAX_DRAWER_WIDTH = 960;

function getStoredDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_DRAWER_WIDTH;
  const raw = window.localStorage.getItem(DRAWER_WIDTH_KEY);
  if (!raw) return DEFAULT_DRAWER_WIDTH;
  const v = Number(raw);
  return Number.isFinite(v) && v >= MIN_DRAWER_WIDTH && v <= MAX_DRAWER_WIDTH
    ? v
    : DEFAULT_DRAWER_WIDTH;
}

function saveDrawerWidth(w: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAWER_WIDTH_KEY, String(w));
  } catch {
    // 隐私模式或 storage 不可用时静默忽略
  }
}

// 抽屉左缘宽度拖拽手柄：8px 命中区，平时透明，hover/drag 时显示蓝色高亮条。
// 使用 Pointer Events 同时支持鼠标和触摸；监听挂在 window 上以支持自由拖拽。
function WidthResizeHandle({
  width,
  onChange,
  onCommit,
}: {
  width: number;
  onChange: (w: number) => void;
  onCommit: (w: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(width);
  const handleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      // 抽屉贴右缘：鼠标向左（clientX 减小，dx 为正）= 抽屉变宽
      const dx = startX.current - e.clientX;
      const next = Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, startW.current + dx));
      onChange(next);
    };
    const onUp = (e: PointerEvent) => {
      const dx = startX.current - e.clientX;
      const next = Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, startW.current + dx));
      onCommit(next);
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, onChange, onCommit]);

  return (
    <div
      ref={handleRef}
      onPointerDown={(e) => {
        e.preventDefault();
        startX.current = e.clientX;
        startW.current = width;
        handleRef.current?.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={clsx(
        "absolute left-0 top-0 z-10 h-full w-2 cursor-col-resize",
        (hovered || dragging) && "bg-gx-accent",
      )}
      title="拖拽调整宽度"
      aria-label="调整抽屉宽度"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

function RecordDrawer({
  open,
  recordId,
  tableId,
  baseId,
  viewId,
  permissions,
  onClose,
  onCreateNew,
}: RecordDrawerProps) {
  // 本地维护当前记录（支持上一条/下一条在抽屉内切换）
  const [currentId, setCurrentId] = useState<string | null>(recordId);
  useEffect(() => setCurrentId(recordId), [recordId]);

  const { data: recordRes, isLoading } = useRecord(open ? currentId : null);
  const { data: fieldsRes } = useFields(tableId);
  const { data: recordsRes } = useRecords({ tableId });
  const { data: tables } = useTables(baseId);
  const { data: views } = useViews(tableId);
  const { data: comments } = useComments(open ? currentId : null);
  const m = useGXMutations();

  // 当前 view：优先用 props.viewId，否则取第一个
  const currentView = viewId ? views?.find((v) => v.id === viewId) : views?.[0];
  const [layoutEditing, setLayoutEditing] = useState(false);

  const user = useAuthStore((s) => s.user);
  const [draftComment, setDraftComment] = useState("");
  const [showComments, setShowComments] = useState(true);
  // R-I-26 写操作在途守卫：删除 / 发评论 / 删评论各按 key 去重，防双击重复提交
  const guard = useWriteGuard();

  // 抽屉宽度：localStorage 持久化，clamp 到 [340, 960]
  const [drawerWidth, setDrawerWidth] = useState<number>(() => getStoredDrawerWidth());
  const commitDrawerWidth = useCallback((w: number) => {
    setDrawerWidth(w);
    saveDrawerWidth(w);
  }, []);

  const table = tables?.find((t) => t.id === tableId);
  const fields = (fieldsRes ?? []).filter((f) => !f.isReverse);
  const record = recordRes?.record ?? null;
  const primaryField = table?.primaryFieldId ? fields.find((f) => f.id === table.primaryFieldId) : undefined;
  const title = record && primaryField ? String(record.fields[primaryField.id] ?? "") : "未命名";

  // 上一条/下一条索引
  const allRecords = recordsRes?.records ?? [];
  const idx = allRecords.findIndex((r) => r.id === currentId);
  const prevId = idx > 0 ? allRecords[idx - 1]!.id : null;
  const nextId = idx >= 0 && idx < allRecords.length - 1 ? allRecords[idx + 1]!.id : null;

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submitComment = async () => {
    const body = draftComment.trim();
    if (!body || !currentId) return;
    await guard.run("comment:add", async () => {
      try {
        await m.addComment.mutateAsync({ recordId: currentId, body });
        setDraftComment("");
      } catch (err) {
        toast((err as Error).message || "评论失败", "error");
      }
    });
  };

  const removeComment = async (commentId: string) => {
    if (!currentId) return;
    await guard.run(`comment:del:${commentId}`, async () => {
      try {
        await m.removeComment.mutateAsync({ commentId, recordId: currentId });
      } catch (err) {
        toast((err as Error).message || "删除失败", "error");
      }
    });
  };

  const handleDelete = async () => {
    if (!currentId || !permissions.canEditData) return;
    const deletedId = currentId;
    const name = title || "未命名";
    // R-D-23 L2：软删除是可恢复操作，走普通确认（不是 L4——记录进回收站可找回）
    const ok = await confirmSoftDelete({
      title: `删除记录「${name}」`,
      confirmText: "删除记录",
      description: "记录会移入回收站，30 天内可恢复。",
    });
    if (!ok) return;
    await guard.run("record:delete", async () => {
      try {
        await m.deleteRecord.mutateAsync({ recordId: deletedId, tableId });
        // R-D-22 删除类成功 toast 必须带「撤销」，窗口 6 秒（记录进回收站，30 天内可恢复）
        toastDeleted({
          message: `已删除记录「${name}」`,
          restoredMessage: `已恢复记录「${name}」`,
          onUndo: () => m.restoreTrash.mutateAsync({ id: deletedId, kind: "record", baseId }),
        });
        onClose();
      } catch (err) {
        toast((err as Error).message || "删除失败", "error");
      }
    });
  };

  // 抽屉内联编辑后刷新当前记录展示
  const refreshRecord = () => {
    /* useRecord 会自动随 mutation 失效刷新，无需手动操作 */
  };

  const canDeleteComment = (commentUserId: string) =>
    permissions.canManageSchema || permissions.canManageBase || commentUserId === user?.id;

  return (
    <>
      {/* 背景遮罩 */}
      {open && <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />}

      {/* 抽屉面板 */}
      <div
        className={
          "fixed right-0 top-0 z-40 flex h-full max-w-full flex-col bg-gx-surface shadow-2xl transition-transform duration-200 " +
          (open ? "translate-x-0" : "translate-x-full pointer-events-none")
        }
        style={{ width: drawerWidth }}
      >
        {/* 左缘宽度拖拽手柄 */}
        <WidthResizeHandle
          width={drawerWidth}
          onChange={setDrawerWidth}
          onCommit={commitDrawerWidth}
        />

        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-gx-separator px-4 py-2.5">
          <IconButton icon="chevronLeft" label="上一条" disabled={!prevId} onClick={() => prevId && setCurrentId(prevId)} />
          <IconButton icon="chevronRight" label="下一条" disabled={!nextId} onClick={() => nextId && setCurrentId(nextId)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-gx-11 text-gx-text-tertiary">{table?.name ?? "记录"}</span>
            <span className="truncate text-gx-14 font-semibold text-gx-text-primary">{title || "未命名"}</span>
          </div>
          {/* 编辑字段布局按钮 */}
          {currentView && (
            <button
              type="button"
              aria-label="编辑字段布局"
              title="编辑字段布局（拖拽换序 / 行内 1-4 列）"
              onClick={() => setLayoutEditing(true)}
              className="flex h-6 w-6 items-center justify-center rounded border border-gx-border bg-gx-surface text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
            >
              <Icon name="grid" size={14} />
            </button>
          )}
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto">
          {isLoading || !record ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner />
            </div>
          ) : layoutEditing && currentView ? (
            <div className="p-4">
              <DetailLayoutEditor
                open
                // 必须传：布局版本是**视图级**的，编辑器拿不到 viewId 时历史入口会被
                // 兜底分支正确拦成禁用（用户可见），但结果是这条入口完全没有版本功能。
                // 这里传的必须和下面 onSave 写入的视图一致（currentView.id），
                // 否则版本会被记到另一个视图上，回退时按错的视图取历史。
                viewId={currentView?.id ?? null}
                fields={fields}
                layout={currentView.config.detailLayout ?? null}
                tableId={tableId}
                baseId={baseId}
                tables={tables ?? []}
                permissions={permissions}
                onClose={() => setLayoutEditing(false)}
                // 必须是 mutateAsync 并让 reject 冒泡：保存失败时面板保持打开
                // 并展示真实错误，不再无条件退出编辑态（P1 静默数据丢失）。
                onSave={async (next) => {
                  await m.updateView.mutateAsync({
                    viewId: currentView.id,
                    tableId,
                    data: { config: { detailLayout: next } },
                  });
                }}
              />
            </div>
          ) : (
            <DetailLayoutRenderer
              fields={fields}
              values={(record.fields as Record<string, CellValue>) ?? {}}
              layout={currentView?.config.detailLayout ?? null}
              tableId={tableId}
              recordId={record.id}
              permissions={permissions}
            />
          )}

          {/* 系统信息 */}
          {record && (
            <div className="border-t border-gx-separator px-4 py-2 text-gx-11 text-gx-text-hint">
              <div>创建：{new Date(record.createdAt).toLocaleString("zh-CN")}</div>
              <div>最后修改：{new Date(record.updatedAt).toLocaleString("zh-CN")}</div>
              {record.createdBy && <div>创建人：{record.createdBy}</div>}
            </div>
          )}

          {/* 评论面板 */}
          <div className="border-t border-gx-separator">
            <button
              type="button"
              onClick={() => setShowComments((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-2 text-gx-13 font-medium text-gx-text-secondary hover:bg-gx-bg"
            >
              <FieldIcon type="comment" size={14} />
              评论 {comments ? `(${comments.length})` : ""}
              <span className="ml-auto text-gx-text-hint">{showComments ? "收起" : "展开"}</span>
            </button>
            {showComments && (
              <div className="px-4 pb-4">
                {permissions.canComment && (
                  <div className="mb-3 flex flex-col gap-2">
                    <Textarea
                      value={draftComment}
                      onChange={(e) => setDraftComment(e.target.value)}
                      placeholder="写下评论…"
                      rows={2}
                      disabled={!currentId}
                    />
                    {!currentId && (
                      <div className="flex items-center gap-1.5 text-gx-12 text-gx-text-hint">
                        <Icon name="alertCircle" size={13} />
                        请先选择一条记录后再发表评论
                      </div>
                    )}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!currentId || !draftComment.trim()}
                        loading={guard.isBusy("comment:add")}
                        onClick={() => void submitComment()}
                      >
                        发表
                      </Button>
                    </div>
                  </div>
                )}
                {!comments || comments.length === 0 ? (
                  <div className="py-2 text-gx-12 text-gx-text-hint">暂无评论</div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {comments.map((c) => (
                      <div key={c.id} className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-gx-12 font-medium text-gx-text-primary">{c.displayName}</span>
                          <span className="text-gx-11 text-gx-text-hint">
                            {new Date(c.createdAt).toLocaleString("zh-CN")}
                          </span>
                          {canDeleteComment(c.userId) && (
                            <button
                              type="button"
                              onClick={() => void removeComment(c.id)}
                              disabled={guard.isBusy(`comment:del:${c.id}`)}
                              className="ml-auto text-gx-11 text-gx-text-hint hover:text-gx-danger"
                            >
                              删除
                            </button>
                          )}
                        </div>
                        <div className="text-gx-13 text-gx-text-primary">{c.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center gap-2 border-t border-gx-separator px-4 py-2.5">
          {permissions.canEditData && (
            <Button
              variant="danger"
              size="sm"
              icon="trash"
              loading={guard.isBusy("record:delete")}
              onClick={() => void handleDelete()}
            >
              删除记录
            </Button>
          )}
          <div className="flex-1" />
          {onCreateNew && (
            <Button variant="secondary" size="sm" icon="plus" onClick={onCreateNew}>
              新建记录
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

export default RecordDrawer;
export { RecordDrawer };
