// apps/web/src/features/kb/DocEditorPage.tsx
// 文档编辑器：Markdown 源码 + 斜杠命令（对标 Obsidian），普通用户可用工具栏/上传插入，
// 高级用户可直接写 Markdown 并一键预览。保存与画布统一走 useDocPersistence：
// 防抖自动存档到云端 + 本地草稿兜底 + 手动"保存"按钮 + 离开/刷新 flush + 草稿恢复提示。

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
import { htmlToInlineMd } from "@gx/blocks";
// 阶段 2 · 协同：会话 + 三个叠加层（在线头像 / 他人光标 / 块占用遮罩）
import { useCollabSession } from "../collab/useCollabSession";
import { PresenceAvatars } from "../collab/PresenceAvatars";
import { CollabCursorLayer } from "../collab/CollabCursorLayer";
import { CollabLeaseLayer } from "../collab/CollabLeaseLayer";
import { cssEscape } from "../collab/block-cursor-locator";
// 阶段 4：409 冲突就地提示（R-D-18），组件在阶段 3 已就绪，此处接上真实调用点
import { ConflictNotice } from "../../components/states";
import { useDoc, useRenameDoc } from "./kb-hooks";
import { DocAccessError } from "./kb-ui";
import { ApiError } from "../../api/client";
import { MarkdownEditor } from "./MarkdownEditor";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import { useDocPersistence } from "./useDocPersistence";
import { clearDraft } from "./draft";
// 阶段 2 · 本地光标/占用的发布口（远端光标的水源；协同关闭时内部零副作用）
import { useDocPresence } from "./collab/useDocPresence";
import { yOfflineEnabled } from "../collab/yOfflineGate";
import { ShareModal } from "./ShareModal";
import { DocOutline } from "./DocOutline";
import { useShortcuts } from "./hooks/useShortcuts";

/**
 * 阶段 2 协同总闸。**默认关闭**：未开启时房间 id 为 null → 连接层不建连、三个叠加层一律返回
 * null，单机行为与引入前逐字一致（D6 UI 冻结的机械判据）。
 *
 * 后端文档冷归结已就绪：`apps/api/src/collab/index.ts` 在模块初始化时即调用
 * registerDocFlusher() 注册 doc flusher。热路径先把房间 Y.Doc 持久化到 collab_docs；
 * 房间空置或进程关闭触发冷归结时，经 Y.Doc → Block[] → blocksToMd（@gx/blocks 唯一真源）
 * → withWriteTx("collab.flush") 内的 saveDocContentTx 并回 kb_docs 正文表（含快照/outbox/nav），
 * 已不存在「看着保存成功、实际没落库」的缺口。前端是否建连仍由本闸 VITE_COLLAB 与下方
 * 离线门 VITE_OFFLINE_Y（Y_OFFLINE）共同决定，普通浏览器构建两者默认皆关、行为与引入前一致。
 */
const COLLAB_ENABLED = import.meta.env.VITE_COLLAB === "1";
/**
 * 离线 Y 累积门控（构建期常量，普通浏览器构建恒 false）。
 * 开启（壳/副本构建）时，即便协同总闸 VITE_COLLAB 未开，也建立本地会话：连接层照常取票建连，
 * 断网/取票失败时进入 connecting/reconnecting/offline，编辑器仍绑定本地 Y.Doc 做字符级累积，
 * 重连自动合并（gx-y）。普通浏览器构建拿不到 VITE_OFFLINE_Y，本值恒 false，行为与引入前一致。
 */
const Y_OFFLINE = yOfflineEnabled();

export default function DocEditorPage() {
  const { kbId, docId } = useParams();
  const navigate = useNavigate();
  const { data: doc, isLoading, isError, error, refetch } = useDoc(docId);
  const rename = useRenameDoc(docId!, kbId!);
  // 会话建在页面层：三态切换会重挂载编辑器，会话跟着建断会频繁掉线
  // 协同总闸开 → 协同会话；关但离线 Y 门控开 → 仍建会话（离线累积）；两者皆关 → null（零变化）。
  const collabRoom = docId && (COLLAB_ENABLED || Y_OFFLINE) ? `doc:${docId}` : null;
  const collab = useCollabSession(collabRoom);
  const collabActive = collab.status === "connected";

  const [title, setTitle] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [overrideContent, setOverrideContent] = useState<string | null>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const pendingRafRef = useRef<number[]>([]);
  /** 当前整篇 Markdown：源码态下把 textarea 的字符偏移换算成块坐标要用（只写 ref，不触发重渲染）。 */
  const mdRef = useRef("");
  const getMarkdown = useCallback(() => mdRef.current, []);

  const canEdit = doc?.canEdit ?? true;
  const persist = useDocPersistence(docId!, kbId!, doc?.content, canEdit, doc?.contentVersion, collabActive);

  // gx-y 字符级更新已被服务端确认合并（首连或断线重连）：整篇 Markdown 草稿降级为纯崩溃兜底，
  // 此刻清掉对应 gx-kb-draft，避免下次进文档还弹"恢复草稿"（内容已走 CRDT 上线，无需二选一）。
  // 只清草稿键，不碰 useDocPersistence 的 pending（门控开但 VITE_COLLAB 关时保存仍走 REST，
  // 待防抖内容不能被清空）。门控关时 localMergedTick 恒为 0，本 effect 不产生任何行为。
  useEffect(() => {
    if (collab.localMergedTick > 0) clearDraft(docId!);
    // 仅以合并次数为触发源。
  }, [collab.localMergedTick, docId]);

  /**
   * 协同光标层要的是「块正文的行内 Markdown **源码**」（正文存的是 `**粗**` 这种带标记的原文，
   * 屏幕上是渲染后的样子，两者偏移不一样）。源码由宿主从编辑器 DOM 现场反解：不新增任何
   * 编辑器对外接口，也不改编辑器内部结构（D6）。
   */
  const getBlockSource = useCallback((blockId: string): string | null => {
    const el = editorAreaRef.current?.querySelector<HTMLElement>(`[data-editable="${cssEscape(blockId)}"]`);
    return el ? htmlToInlineMd(el) : null;
  }, []);

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

  /**
   * 阶段 2：广播本地光标与占用。**协同未开启 / 未连通时 hook 内部直接返回**（不挂监听、
   * 不发包），单机模式与引入前逐元素一致（D6）。
   */
  useDocPresence({
    containerRef: editorAreaRef,
    publish: collab.publish,
    enabled: COLLAB_ENABLED && collabActive,
    doc: collab.doc,
    getMarkdown,
    // 文档切换 / 版本回滚会换掉整棵编辑器，用它触发重新绑定
    revision: `${docId ?? ""}:${editorKey}`,
  });

  // 编辑器每次内容变更实时上抛 → 防抖自动保存 + 草稿
  function handleChange(md: string) {
    mdRef.current = md;
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
  mdRef.current = initialContent; // 首次进源码态、还没敲过字时也要有基准正文

  return (
    <div className="kb-page flex h-full flex-col bg-gx-bg">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-gx-hairline bg-gx-surface px-3 py-2">
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
          {persist.status === "synced" && (
            <>
              <Icon name="check" size={13} className="text-gx-success" />
              已同步（协同中）
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

      {/* R-D-18 保存冲突（409）：就地二选一，不静默覆盖、也不只用 toast 打发 */}
      {persist.conflict && (
        <div className="shrink-0 border-b border-gx-hairline px-4 py-2">
          <ConflictNotice
            description="保存时发现服务端版本比你的更新。选择「查看最新版本」会丢弃本地未保存内容；选择「保留我的版本」会以你的内容覆盖服务端。"
            onViewLatest={() => {
              persist.takeLatestVersion();
              void refetch().then((r) => {
                if (r.data) {
                  setTitle(r.data.title);
                  setOverrideContent(r.data.content ?? "");
                  setEditorKey((k) => k + 1);
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

      {/* Markdown 编辑器 */}
      <div className="relative min-h-0 flex-1 bg-gx-surface" ref={editorAreaRef}>
        <MarkdownEditor
          key={`${doc.id}-${editorKey}`}
          initialMarkdown={initialContent}
          onChange={handleChange}
          onSave={() => void persist.saveNow()}
          readOnly={!canEdit}
          docId={doc.id}
          collab={collab}
        />
        {/* 阶段 2 叠加层：都是编辑器的**兄弟节点**，不进编辑器内部 DOM（D6）。
            三者在没有他人时一律返回 null，单机模式下零 DOM 增量。 */}
        <PresenceAvatars
          entries={collab.entries}
          selfId={collab.selfId}
          className="absolute right-3 top-2 z-30"
        />
        <CollabCursorLayer
          containerRef={editorAreaRef}
          entries={collab.entries}
          selfId={collab.selfId}
          getBlockSource={getBlockSource}
        />
        <CollabLeaseLayer containerRef={editorAreaRef} entries={collab.entries} selfId={collab.selfId} />
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
