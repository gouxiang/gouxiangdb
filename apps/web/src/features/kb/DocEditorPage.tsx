// apps/web/src/features/kb/DocEditorPage.tsx
// 文档编辑器：Markdown 源码 + 斜杠命令（对标 Obsidian），普通用户可用工具栏/上传插入，
// 高级用户可直接写 Markdown 并一键预览。保存与画布统一走 useDocPersistence：
// 防抖自动存档到云端 + 本地草稿兜底 + 手动"保存"按钮 + 离开/刷新 flush + 草稿恢复提示。

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
import { useDoc, useRenameDoc } from "./kb-hooks";
import { DocAccessError } from "./kb-ui";
import { ApiError } from "../../api/client";
import { MarkdownEditor } from "./MarkdownEditor";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { useDocPersistence } from "./useDocPersistence";
import { ShareModal } from "./ShareModal";
import { DocOutline } from "./DocOutline";
import { useShortcuts } from "./hooks/useShortcuts";

export default function DocEditorPage() {
  const { kbId, docId } = useParams();
  const navigate = useNavigate();
  const { data: doc, isLoading, isError, error, refetch } = useDoc(docId);
  const rename = useRenameDoc(docId!, kbId!);

  const [title, setTitle] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [overrideContent, setOverrideContent] = useState<string | null>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const pendingRafRef = useRef<number[]>([]);

  const canEdit = doc?.canEdit ?? true;
  const persist = useDocPersistence(docId!, kbId!, doc?.content, canEdit, doc?.contentVersion);

  // 跨平台快捷键 Cmd/Ctrl+S：触发立即云端保存（跳过 1200ms 防抖）。
  // 作用域限定在 editorAreaRef 内，避免劫持搜索对话框 / 版本历史抽屉 / 标题输入框。
  // preventDefault 阻止浏览器原生"另存为"弹窗（Win）/ 替换当前页（macOS Safari）。
  useShortcuts(
    [{ id: "save", combos: [{ key: "s", meta: true }], preventDefault: true }],
    { save: () => void persist.saveNow() },
    { rootRef: editorAreaRef },
  );

  useEffect(() => {
    if (doc) {
      setTitle(doc.title);
      setOverrideContent(null);
    }
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // B3: 标题锚点 hash 滚动 + 高亮闪烁（URL 形如 /kb/.../doc/...#h-abc123）
  // 触发时机：① 文档加载/内容变更（doc.id / content 依赖）② 同文档内 hash 变化
  // （点锚点链接 / 大纲跳转后再点同一锚点——useEffect 依赖不含 hash，须监听 hashchange）
  // 注意：浏览器会把 hash 里的非 ASCII（如中文）按 percent-encoding 读出；data-heading-id 存的是原样 slug（中文原样），
  // 因此要 decodeURIComponent 后再 querySelector。slugify 产物仅含 [a-z0-9-中文]，无须对选择器再做转义。
  useEffect(() => {
    const scrollToHash = (rawHash: string) => {
      let hash = "";
      try {
        hash = decodeURIComponent(rawHash);
      } catch {
        hash = rawHash;
      }
      if (!hash || !hash.startsWith("h-")) return;
      // 等内容渲染完：双 rAF 兜底，确保 Editable 已挂载
      const id1 = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = editorAreaRef.current?.querySelector(`[data-heading-id="${hash}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
            el.classList.add("md-heading-flash");
            setTimeout(() => el.classList.remove("md-heading-flash"), 2000);
          }
        });
      });
      pendingRafRef.current.push(id1);
    };
    scrollToHash(window.location.hash.slice(1));
    const onHashChange = () => scrollToHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      pendingRafRef.current.forEach((id) => cancelAnimationFrame(id));
      pendingRafRef.current = [];
    };
  }, [doc?.id, doc?.content]);

  // 编辑器每次内容变更实时上抛 → 防抖自动保存 + 草稿
  function handleChange(md: string) {
    persist.markDirty(md);
  }

  async function commitTitle() {
    if (!doc || title.trim() === doc.title) {
      if (doc) setTitle(doc.title);
      return;
    }
    try {
      await rename.mutateAsync(title.trim() || "未命名文档");
      toast("标题已更新", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  }

  function recoverDraft() {
    const c = persist.recoverDraft();
    if (c != null) {
      setOverrideContent(c);
      setEditorKey((k) => k + 1);
      toast("已恢复未保存的本地草稿，将自动保存到云端", "success");
    }
  }

  async function handleRolledBack() {
    const r = await refetch();
    if (r.data) {
      setTitle(r.data.title);
      setOverrideContent(null);
      setEditorKey((k) => k + 1);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }
  // 无权限 / 已删除 / 不存在 / 加载失败：明确错误态（@引用跳转的目标页兜底），避免 doc 为空时白屏
  if (isError || !doc) {
    const status = error instanceof ApiError ? error.status : undefined;
    return (
      <div className="h-full">
        <DocAccessError
          status={status}
          kind="doc"
          onBack={() => navigate(`/kb/${kbId}`)}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const initialContent = overrideContent ?? doc.content ?? "";

  return (
    <div className="kb-page flex h-full flex-col bg-gx-bg">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-gx-separator bg-gx-surface px-3 py-2">
        <button
          type="button"
          onClick={() => navigate(`/kb/${kbId}`)}
          className="rounded-gx-sm p-1.5 text-gx-text-tertiary hover:bg-gx-bg"
          title="返回"
        >
          <Icon name="chevronLeft" size={16} />
        </button>
        <Icon name="doc" size={16} className="ml-1 text-gx-accent" />
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
            className="inline-flex h-8 items-center gap-1.5 rounded-gx-md bg-gx-accent px-3 text-gx-12 font-medium text-white hover:brightness-95 disabled:opacity-50"
          >
            <Icon name="save" size={14} />
            保存
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowShare(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-gx-md border border-gx-border bg-gx-surface px-3 text-gx-12 font-medium text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="share" size={14} />
          分享
        </button>
        <button
          type="button"
          onClick={() => setShowVersions(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-gx-md border border-gx-border bg-gx-surface px-2.5 text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="history" size={14} />
          版本历史
        </button>
      </div>

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

      {/* Markdown 编辑器 */}
      <div className="relative min-h-0 flex-1 bg-gx-surface" ref={editorAreaRef}>
        <MarkdownEditor
          key={`${doc.id}-${editorKey}`}
          initialMarkdown={initialContent}
          onChange={handleChange}
          onSave={() => void persist.saveNow()}
          readOnly={!canEdit}
          docId={doc.id}
        />
        <DocOutline rootRef={editorAreaRef} />
      </div>

      {showVersions && (
        <VersionHistoryDrawer doc={doc} canEdit={canEdit} onClose={() => setShowVersions(false)} onRolledBack={handleRolledBack} />
      )}

      {showShare && (
        <ShareModal docId={doc.id} kbId={kbId!} open={showShare} onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}
