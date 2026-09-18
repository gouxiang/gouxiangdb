// apps/web/src/features/kb/PublicSharePage.tsx
// 公开分享页（/s/:token）：匿名可访问，无需登录。
// - 文档：viewer 只读预览；editor 可编辑（防抖保存走 PublicApi）
// - 画布：viewer 只读；editor 可编辑 + 保存按钮
// - 级联分享：左侧文档树，仅展示被分享根节点及其下级，支持展开/收起/点击切换

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
import { PublicApi, type KbTreeItemDTO } from "../../api/client";
import { usePublicShare } from "./kb-hooks";
import { MarkdownEditor } from "./MarkdownEditor";
import { GxCanvas } from "./canvas/GxCanvas";
import { DocKindIcon } from "./kb-ui";
import { DocOutline } from "./DocOutline";

interface TreeNode extends KbTreeItemDTO {
  children: TreeNode[];
}

function buildTree(items: KbTreeItemDTO[], rootId: string): TreeNode[] {
  const map = new Map<string, TreeNode>();
  items.forEach((it) => map.set(it.id, { ...it, children: [] }));
  const roots: TreeNode[] = [];
  items.forEach((it) => {
    const node = map.get(it.id)!;
    if (it.id === rootId || !it.parentId) {
      roots.push(node);
    } else {
      const parent = map.get(it.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  });
  return roots;
}

export default function PublicSharePage() {
  const { token, docId: routeDocId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = usePublicShare(token);

  const [activeDocId, setActiveDocId] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // 当前展示的文档：路由/树选中的子文档，否则根文档
  const effectiveDocId = routeDocId ?? activeDocId ?? data?.doc.id;
  const [remoteDoc, setRemoteDoc] = useState<{ id: string; content: string; title: string; kind: string } | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const docAreaRef = useRef<HTMLDivElement>(null);

  // 根数据加载后初始化
  useEffect(() => {
    if (data) {
      setRemoteDoc({ id: data.doc.id, content: data.doc.content, title: data.doc.title, kind: data.doc.kind });
      setActiveDocId(undefined);
    }
  }, [data?.rootToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换子文档时拉取内容
  useEffect(() => {
    if (!token || !effectiveDocId || !data) return;
    if (effectiveDocId === data.doc.id) {
      setRemoteDoc({ id: data.doc.id, content: data.doc.content, title: data.doc.title, kind: data.doc.kind });
      return;
    }
    let alive = true;
    setDocLoading(true);
    PublicApi.getDoc(token, effectiveDocId)
      .then((r) => {
        if (alive) setRemoteDoc({ id: r.doc.id, content: r.doc.content, title: r.doc.title, kind: r.doc.kind });
      })
      .catch((e) => {
        if (alive) toast(e instanceof Error ? e.message : "无法加载该内容", "error");
      })
      .finally(() => alive && setDocLoading(false));
    return () => {
      alive = false;
    };
  }, [effectiveDocId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const tree = useMemo(() => (data ? buildTree(data.tree, data.doc.id) : []), [data]);
  const canEdit = data?.canEdit ?? false;

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gx-bg text-center">
        <Icon name="link" size={32} className="text-gx-text-hint" />
        <div className="text-gx-15 font-semibold text-gx-text-primary">分享链接已失效或被取消</div>
        <div className="text-gx-13 text-gx-text-tertiary">该链接可能已被分享者关闭，或内容已被删除。</div>
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="mt-2 rounded-gx-lg bg-gx-accent px-4 py-2 text-gx-13 font-medium text-white hover:brightness-95"
        >
          返回构想工作台
        </button>
      </div>
    );
  }

  const showTree = data.includeChildren && data.tree.length > 0;

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openDoc(id: string) {
    setActiveDocId(id);
  }

  return (
    <div className="flex h-screen bg-gx-bg">
      {/* 左侧分享文档树 */}
      {showTree && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-gx-separator bg-gx-surface">
          <div className="border-b border-gx-separator px-3 py-2.5 text-gx-12 font-medium text-gx-text-secondary">分享内容</div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {tree.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                activeId={effectiveDocId}
                collapsed={collapsed}
                onToggle={toggle}
                onOpen={openDoc}
              />
            ))}
          </div>
        </aside>
      )}

      {/* 主内容区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="flex items-center gap-2 border-b border-gx-separator bg-gx-surface px-4 py-2.5">
          <DocKindIcon kind={remoteDoc?.kind as "doc" | "canvas"} />
          <span className="min-w-0 flex-1 truncate text-gx-14 font-semibold text-gx-text-primary">
            {remoteDoc?.title ?? "加载中…"}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-gx-sm px-2 py-0.5 text-gx-11 ${
              canEdit ? "bg-gx-accent-bg text-gx-accent" : "bg-gx-bg text-gx-text-tertiary"
            }`}
          >
            <Icon name={canEdit ? "edit" : "eye"} size={12} />
            {canEdit ? "可编辑" : "仅可见"}
          </span>
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 py-1 text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
          >
            在构想工作台中打开
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {docLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : remoteDoc?.kind === "canvas" ? (
            <PublicCanvas doc={remoteDoc} canEdit={canEdit} token={token!} />
          ) : (
            <div className="relative flex h-full min-h-0 flex-1 flex-col bg-gx-surface" ref={docAreaRef}>
              <div className="min-h-0 flex-1 overflow-y-auto" data-outline-scroll>
                <div className="mx-auto max-w-3xl px-6 py-6">
                  <MarkdownEditor
                    key={remoteDoc?.id}
                    initialMarkdown={remoteDoc?.content ?? ""}
                    readOnly={!canEdit}
                    publicToken={token}
                    onChange={(md) => scheduleSaveDoc(token!, remoteDoc!.id, md)}
                  />
                </div>
              </div>
              <DocOutline rootRef={docAreaRef} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// 文档防抖保存（匿名 editor）
let docSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveDoc(token: string, docId: string, content: string) {
  if (docSaveTimer) clearTimeout(docSaveTimer);
  docSaveTimer = setTimeout(() => {
    PublicApi.saveContent(token, docId, content).catch(() => {
      toast("自动保存失败，请检查网络", "error");
    });
  }, 1200);
}

// 画布公开查看/编辑
function PublicCanvas({
  doc,
  canEdit,
  token,
}: {
  doc: { id: string; content: string; title: string; kind: string };
  canEdit: boolean;
  token: string;
}) {
  const [content, setContent] = useState(doc.content);
  const [saving, setSaving] = useState(false);
  const latest = useRef(content);
  latest.current = content;

  useEffect(() => {
    setContent(doc.content);
  }, [doc.id, doc.content]);

  async function save() {
    setSaving(true);
    try {
      await PublicApi.saveContent(token, doc.id, latest.current);
      toast("画布已保存", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative h-full">
      {canEdit && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-12 font-medium text-white hover:brightness-95 disabled:opacity-50"
          >
            <Icon name="save" size={14} />
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      )}
      <GxCanvas
        docId={doc.id}
        content={content}
        canEdit={canEdit}
        publicToken={token}
        onContentChange={(json) => setContent(json)}
        onSave={() => void save()}
      />
    </div>
  );
}

function TreeRow({
  node,
  depth,
  activeId,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activeId?: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const active = activeId === node.id;
  return (
    <div>
      <div
        className={`group flex h-8 cursor-pointer items-center gap-1 pr-2 ${active ? "bg-gx-accent-bg" : "hover:bg-gx-bg"}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onOpen(node.id)}
      >
        <button
          type="button"
          className="flex h-4 w-4 shrink-0 items-center justify-center text-gx-text-hint"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          {hasChildren ? (
            <Icon name="chevronRight" size={12} className={isCollapsed ? "" : "rotate-90 transition-transform"} />
          ) : null}
        </button>
        <DocKindIcon kind={node.kind} />
        <span className={`min-w-0 flex-1 truncate text-gx-13 ${active ? "font-medium text-gx-accent" : "text-gx-text-secondary"}`}>
          {node.title}
        </span>
      </div>
      {hasChildren && !isCollapsed && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
