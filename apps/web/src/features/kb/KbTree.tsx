// apps/web/src/features/kb/KbTree.tsx
// 知识库内容导航：
//  - 顶部「文档 / 画布」选项卡切换（数量多时承载优化）
//  - 文档：按 parentId 组装成不限层级的缩进树，支持展开/收起、拖拽建立父子级联、新建子文档
//  - 画布：平铺列表（不参与级联）
//  - 内联新建/重命名/删除（软删除进回收站）

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Menu, MenuItem, Popover, toast } from "../../components/ui";
import type { KbDocDTO, KbDocKind } from "../../api/client";
import { useKb, useKbDocs, useCreateDoc, useRenameDoc, useDeleteDoc, useMoveDoc } from "./kb-hooks";
import { DocKindIcon } from "./kb-ui";

interface TreeNode extends KbDocDTO {
  children: TreeNode[];
}

function buildDocTree(docs: KbDocDTO[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  docs.forEach((d) => map.set(d.id, { ...d, children: [] }));
  const roots: TreeNode[] = [];
  docs.forEach((d) => {
    const node = map.get(d.id)!;
    if (d.parentId && map.has(d.parentId)) {
      map.get(d.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

export function KbTree({ kbId }: { kbId: string }) {
  const navigate = useNavigate();
  const { docId: activeDocId } = useParams();
  const { data: kb } = useKb(kbId);
  const { data: docs, isLoading } = useKbDocs(kbId, "all");
  const createDoc = useCreateDoc(kbId);
  const deleteDoc = useDeleteDoc(kbId);
  const moveDoc = useMoveDoc(kbId);

  const [tab, setTab] = useState<"doc" | "canvas">(
    () => (localStorage.getItem(`gx-kb-tab-${kbId}`) as "doc" | "canvas") || "doc",
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(`gx-kb-collapsed-${kbId}`) || "[]")),
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 「更多操作」弹层的定位锚点：深层级节点缩进后按钮贴近右缘，absolute 弹层会被
  // .kb-tree(overflow:auto) 裁剪，故用 fixed portal 弹层并按触发按钮视口坐标定位。
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string | null; zone: "into" | "root" } | null>(null);

  const renameDoc = useRenameDoc(renamingId ?? "__none__", kbId);

  useEffect(() => {
    localStorage.setItem(`gx-kb-tab-${kbId}`, tab);
  }, [tab, kbId]);
  useEffect(() => {
    localStorage.setItem(`gx-kb-collapsed-${kbId}`, JSON.stringify([...collapsed]));
  }, [collapsed, kbId]);

  const canEdit = useMemo(() => {
    const r = kb?.role ?? "owner";
    return r === "owner" || r === "editor";
  }, [kb?.role]);

  const docsList = useMemo(() => (docs ?? []).filter((d) => !d.deletedAt), [docs]);
  const docTree = useMemo(() => buildDocTree(docsList.filter((d) => d.kind === "doc")), [docsList]);
  const canvases = useMemo(() => docsList.filter((d) => d.kind === "canvas"), [docsList]);

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create(kind: KbDocKind, parentId?: string) {
    if (createDoc.isPending) return;
    try {
      const r = await createDoc.mutateAsync({
        kind,
        title: kind === "canvas" ? "未命名画布" : "未命名文档",
        ...(kind === "doc" && parentId ? { parentId } : {}),
      });
      const d = r.doc;
      navigate(kind === "canvas" ? `/kb/${kbId}/canvas/${d.id}` : `/kb/${kbId}/doc/${d.id}`);
      if (parentId) setCollapsed((prev) => { const n = new Set(prev); n.delete(parentId); return n; });
      setRenamingId(d.id);
      setRenameVal(d.title);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建失败", "error");
    }
  }

  function openDoc(d: KbDocDTO) {
    navigate(d.kind === "canvas" ? `/kb/${kbId}/canvas/${d.id}` : `/kb/${kbId}/doc/${d.id}`);
  }

  function startRename(d: KbDocDTO) {
    setMenuFor(null);
    setRenamingId(d.id);
    setRenameVal(d.title);
  }

  async function submitRename() {
    if (!renamingId || !renameVal.trim() || renameDoc.isPending) {
      setRenamingId(null);
      return;
    }
    try {
      await renameDoc.mutateAsync(renameVal.trim());
      toast("已重命名", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    } finally {
      setRenamingId(null);
    }
  }

  async function doDelete(d: KbDocDTO) {
    setMenuFor(null);
    if (!window.confirm(`确定删除「${d.title}」吗？其下级文档将保留在回收站，可在 30 天内找回。`)) return;
    try {
      await deleteDoc.mutateAsync(d.id);
      toast("已移入回收站", "success");
      if (activeDocId === d.id) navigate(`/kb/${kbId}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  // 是否为拖动节点的后代（禁止拖入自己的子树）
  function isDescendantOfDrag(targetId: string): boolean {
    if (!dragId) return false;
    let cur = docsList.find((d) => d.id === targetId);
    const seen = new Set<string>();
    while (cur && cur.parentId && !seen.has(cur.id)) {
      if (cur.parentId === dragId) return true;
      seen.add(cur.id);
      cur = docsList.find((d) => d.id === cur!.parentId);
    }
    return false;
  }

  async function handleDrop() {
    if (!dragId || !dropTarget) {
      setDragId(null);
      setDropTarget(null);
      return;
    }
    const targetParent = dropTarget.zone === "root" ? null : dropTarget.id;
    // 非法落点：拖到自己 / 自己的后代
    if (targetParent && (targetParent === dragId || isDescendantOfDrag(targetParent))) {
      toast("无法移动：不能将文档放到它自己或它的子级中", "error");
      setDragId(null);
      setDropTarget(null);
      return;
    }
    try {
      await moveDoc.mutateAsync({ docId: dragId, parentId: targetParent });
      toast(targetParent ? "已移到目标文档下" : "已移到顶级", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "移动失败", "error");
    } finally {
      setDragId(null);
      setDropTarget(null);
    }
  }

  function openMenu(id: string, el: HTMLElement) {
    setMenuAnchor(el);
    setMenuFor(menuFor === id ? null : id);
  }

  function renderDocNode(node: TreeNode, depth: number): React.ReactNode {
    const active = activeDocId === node.id;
    const renaming = renamingId === node.id;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const isDropInto = dropTarget?.zone === "into" && dropTarget.id === node.id;
    const isDrag = dragId === node.id;

    return (
      <div key={node.id}>
        <div
          draggable={canEdit && !renaming}
          onDragStart={() => setDragId(node.id)}
          onDragEnd={() => { setDragId(null); setDropTarget(null); }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id || isDescendantOfDrag(node.id)) return;
            e.preventDefault();
            setDropTarget({ id: node.id, zone: "into" });
          }}
          onDrop={(e) => { e.preventDefault(); void handleDrop(); }}
          className={`kb-tree-item${active ? " active" : ""}${isDropInto ? " kb-tree-drop-into" : ""}${isDrag ? " opacity-40" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            type="button"
            className="flex h-4 w-4 shrink-0 items-center justify-center text-gx-text-hint"
            onClick={() => hasChildren && toggleCollapse(node.id)}
          >
            {hasChildren ? (
              <Icon name="chevronRight" size={12} className={isCollapsed ? "" : "rotate-90 transition-transform"} />
            ) : (
              <span className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => !renaming && openDoc(node)}
            className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent text-left"
            style={{ border: "none", padding: 0, color: "inherit", font: "inherit", cursor: "pointer" }}
          >
            <DocKindIcon kind={node.kind} size={14} />
            {renaming ? (
              <input
                autoFocus
                className="kb-tree-rename"
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onBlur={submitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="kb-tree-label">{node.title || "未命名"}</span>
            )}
          </button>
          {canEdit && !renaming && (
            <span className="relative">
              <button
                type="button"
                className="kb-tree-more"
                onClick={(e) => { e.stopPropagation(); openMenu(node.id, e.currentTarget); }}
                title="更多操作"
              >
                <Icon name="more" size={14} />
              </button>
              <Popover open={menuFor === node.id} onClose={() => setMenuFor(null)} align="left" width={160} fixed anchorEl={menuAnchor}>
                <Menu width={160}>
                  <MenuItem icon="plus" label="新建子文档" onClick={() => create("doc", node.id)} />
                  <MenuItem icon="edit" label="重命名" onClick={() => startRename(node)} />
                  <MenuItem icon="trash" label="删除" danger onClick={() => doDelete(node)} />
                </Menu>
              </Popover>
            </span>
          )}
        </div>
        {hasChildren && !isCollapsed && <div>{node.children.map((c) => renderDocNode(c, depth + 1))}</div>}
      </div>
    );
  }

  function renderCanvas(d: KbDocDTO) {
    const active = activeDocId === d.id;
    const renaming = renamingId === d.id;
    return (
      <div key={d.id} className={`kb-tree-item${active ? " active" : ""}`}>
        <button
          type="button"
          onClick={() => !renaming && openDoc(d)}
          className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent text-left"
          style={{ border: "none", padding: 0, color: "inherit", font: "inherit", cursor: "pointer" }}
        >
          <DocKindIcon kind={d.kind} size={14} />
          {renaming ? (
            <input
              autoFocus
              className="kb-tree-rename"
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenamingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="kb-tree-label">{d.title || "未命名"}</span>
          )}
        </button>
        {canEdit && !renaming && (
          <span className="relative">
            <button
              type="button"
              className="kb-tree-more"
              onClick={(e) => { e.stopPropagation(); openMenu(d.id, e.currentTarget); }}
              title="更多操作"
            >
              <Icon name="more" size={14} />
            </button>
            <Popover open={menuFor === d.id} onClose={() => setMenuFor(null)} align="left" width={150} fixed anchorEl={menuAnchor}>
              <Menu width={150}>
                <MenuItem icon="edit" label="重命名" onClick={() => startRename(d)} />
                <MenuItem icon="trash" label="删除" danger onClick={() => doDelete(d)} />
              </Menu>
            </Popover>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="kb-tree">
      {/* 文档 / 画布 选项卡 */}
      <div className="mx-2 mb-2 flex rounded-gx-md bg-gx-bg p-0.5">
        {(["doc", "canvas"] as const).map((t) => {
          const count = t === "doc" ? countNodes(docTree) : canvases.length;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-gx-sm text-gx-12 font-medium transition-colors ${
                tab === t ? "bg-gx-surface text-gx-text-primary shadow-sm" : "text-gx-text-tertiary hover:text-gx-text-secondary"
              }`}
            >
              <Icon name={t === "doc" ? "doc" : "canvas"} size={13} />
              {t === "doc" ? "文档" : "画布"}
              <span className="text-gx-11 opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="kb-tree-empty">加载中…</div>
      ) : tab === "doc" ? (
        <>
          <div className="kb-tree-section">
            <Icon name="doc" size={13} className="text-gx-text-hint" />
            <span className="kb-tree-title">文档</span>
            {canEdit && (
              <button type="button" className="kb-tree-add" title="新建文档" onClick={() => create("doc")}>
                <Icon name="plus" size={13} />
              </button>
            )}
          </div>
          {/* 顶级拖放区 */}
          {canEdit && (
            <div
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropTarget({ id: null, zone: "root" }); } }}
              onDrop={(e) => { e.preventDefault(); void handleDrop(); }}
              className={`mx-2 mb-1 rounded-gx-sm border border-dashed px-2 py-1 text-center text-gx-11 transition-colors ${
                dropTarget?.zone === "root" ? "border-gx-accent bg-gx-accent-bg text-gx-accent" : "border-transparent text-transparent"
              }`}
            >
              拖到此处移到顶级
            </div>
          )}
          {docTree.length === 0 ? <div className="kb-tree-empty">暂无文档</div> : docTree.map((n) => renderDocNode(n, 0))}
        </>
      ) : (
        <>
          <div className="kb-tree-section">
            <Icon name="canvas" size={13} className="text-gx-text-hint" />
            <span className="kb-tree-title">画布</span>
            {canEdit && (
              <button type="button" className="kb-tree-add" title="新建画布" onClick={() => create("canvas")}>
                <Icon name="plus" size={13} />
              </button>
            )}
          </div>
          {canvases.length === 0 ? <div className="kb-tree-empty">暂无画布</div> : canvases.map(renderCanvas)}
        </>
      )}
    </div>
  );
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}
