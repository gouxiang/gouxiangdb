// apps/web/src/features/kb/CanvasEditorPage.tsx
// 画布编辑器：Drawnix 全屏编辑。保存完全由我方接管——
//  - Drawnix 自带"保存为 .drawnix 文件"的 app 菜单在编辑态通过 CSS 隐藏，杜绝"点保存触发本地下载"
//  - 内容变更 → 防抖自动保存到云端 + 本地草稿兜底；顶栏"保存"按钮立即云端存档并 toast 成功
//  - 离开/刷新/切换：keepalive flush + beforeunload 提示，绝不丢内容
//  - 加载时若发现比服务端更新的本地草稿，提示恢复
//  标题重命名 + 版本历史（只读预览/回滚）。

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { colors } from "@gx/design-tokens";
import { Spinner, toast } from "../../components/ui";
// 阶段 4：409 冲突就地提示（R-D-18）
import { ConflictNotice } from "../../components/states";
import { useDoc, useRenameDoc } from "./kb-hooks";
import { DocAccessError } from "./kb-ui";
import { ApiError } from "../../api/client";
import { GxCanvas } from "./canvas/GxCanvas";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { useDocPersistence } from "./useDocPersistence";
import { ShareModal } from "./ShareModal";

export default function CanvasEditorPage() {
  const { kbId, docId } = useParams();
  const navigate = useNavigate();
  const { data: doc, isLoading, isError, error, refetch } = useDoc(docId);
  const rename = useRenameDoc(docId!, kbId!);

  const [title, setTitle] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [contentKey, setContentKey] = useState(0); // 回滚/恢复后强制重建画布
  const [overrideContent, setOverrideContent] = useState<string | null>(null); // 恢复草稿时的初始内容

  const canEdit = doc?.canEdit ?? true;
  const persist = useDocPersistence(docId!, kbId!, doc?.content, canEdit, doc?.contentVersion);

  useEffect(() => {
    if (doc) setTitle(doc.title);
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawnix 每次编辑同步上抛 → 防抖自动保存 + 草稿
  function handleContentChange(json: string) {
    persist.markDirty(json);
  }

  async function commitTitle() {
    if (!doc || title.trim() === doc.title) {
      if (doc) setTitle(doc.title);
      return;
    }
    try {
      await rename.mutateAsync(title.trim() || "未命名画布");
      toast("标题已更新", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  }

  function recoverDraft() {
    const c = persist.recoverDraft();
    if (c != null) {
      setOverrideContent(c);
      setContentKey((k) => k + 1);
      toast("已恢复未保存的本地草稿，将自动保存到云端", "success");
    }
  }

  async function handleRolledBack() {
    await refetch();
    setOverrideContent(null);
    setContentKey((k) => k + 1);
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }
  // 无权限 / 已删除 / 不存在 / 加载失败：明确错误态，避免 doc 为空时访问 doc.id 崩溃
  if (isError || !doc) {
    const status = error instanceof ApiError ? error.status : undefined;
    return (
      <div className="h-full">
        <DocAccessError
          status={status}
          kind="canvas"
          onBack={() => navigate(`/kb/${kbId}`)}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const initialContent = overrideContent ?? doc.content;

  return (
    <div className="flex h-full flex-col bg-gx-bg">
      <div className="flex items-center gap-2 border-b border-gx-separator bg-gx-surface px-3 py-2">
        <button
          type="button"
          onClick={() => navigate(`/kb/${kbId}`)}
          className="rounded-gx-sm p-1.5 text-gx-text-tertiary hover:bg-gx-bg"
          title="返回"
        >
          <Icon name="chevronLeft" size={16} />
        </button>
        <Icon name="canvas" size={16} className="ml-1" style={{ color: colors.secondaryAlt }} />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          disabled={!canEdit}
          className="min-w-0 flex-1 rounded-gx-sm bg-transparent px-1 py-0.5 text-gx-14 font-medium text-gx-text-primary hover:bg-gx-bg focus:bg-gx-bg focus:outline-none disabled:opacity-60"
        />
        <span className="flex items-center gap-1 text-gx-11 text-gx-text-hint">
          {persist.status === "saving" && (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gx-border border-t-gx-accent" />
              保存中…
            </>
          )}
          {persist.status === "saved" && (
            <>
              <Icon name="check" size={13} className="text-gx-success" />
              已保存到云端
            </>
          )}
          {persist.status === "unsaved" && (
            <>
              <span className="kb-tree-unsaved" />
              <span className="text-gx-warning">有未保存更改</span>
            </>
          )}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={() => void persist.saveNow()}
            disabled={persist.status === "saving"}
            className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-12 font-medium text-white hover:brightness-95 disabled:opacity-50"
          >
            <Icon name="save" size={14} />
            保存
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowShare(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-3 text-gx-12 font-medium text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="share" size={14} />
          分享
        </button>
        <button
          type="button"
          onClick={() => setShowVersions(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="history" size={14} />
          版本历史
        </button>
      </div>

      {/* R-D-18 保存冲突（409）：就地二选一，不静默覆盖 */}
      {persist.conflict && (
        <div className="shrink-0 border-b border-gx-separator px-4 py-2">
          <ConflictNotice
            description="保存时发现服务端版本比你的更新。选择「查看最新版本」会丢弃本地未保存内容；选择「保留我的版本」会以你的内容覆盖服务端。"
            onViewLatest={() => {
              persist.takeLatestVersion();
              void refetch().then((r) => {
                if (r.data) {
                  setTitle(r.data.title);
                  setOverrideContent(r.data.content ?? "[]");
                  setContentKey((k) => k + 1);
                }
              });
            }}
            onKeepMine={() => void persist.keepMineVersion()}
          />
        </div>
      )}

      {/* 草稿恢复提示 */}
      {persist.recovered && canEdit && (
        <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-accent-bg px-4 py-2 text-gx-12 text-gx-text-secondary">
          <Icon name="alertCircle" size={15} className="text-gx-warning" />
          <span>检测到上次有未保存到云端的本地草稿（{new Date(persist.recovered.savedAt).toLocaleString()}）</span>
          <button type="button" className="rounded-gx-sm bg-gx-accent px-2.5 py-1 text-gx-12 font-medium text-white hover:brightness-95" onClick={recoverDraft}>
            恢复草稿
          </button>
          <button type="button" className="text-gx-12 text-gx-text-tertiary hover:text-gx-text-primary" onClick={persist.discardDraft}>
            丢弃
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <GxCanvas
          key={`${doc.id}-${contentKey}`}
          docId={doc.id}
          content={initialContent}
          canEdit={canEdit}
          kbId={kbId}
          onContentChange={handleContentChange}
          onSave={() => void persist.saveNow()}
        />
      </div>

      {showVersions && (
        <VersionHistoryDrawer doc={doc} canEdit={canEdit} onClose={() => setShowVersions(false)} onRolledBack={handleRolledBack} />
      )}

      {showShare && (
        <ShareModal docId={doc.id} kbId={kbId!} kind="canvas" open={showShare} onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}
