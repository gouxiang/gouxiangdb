// apps/web/src/features/kb/KbTree.tsx
// 知识库内容导航：
//  - 顶部「文档 / 画布」选项卡切换（数量多时承载优化）
//  - 文档：按 parentId 组装成不限层级的缩进树，支持展开/收起、拖拽建立父子级联、新建子文档
//  - 画布：平铺列表（不参与级联）
//  - 内联新建/重命名/删除（软删除进回收站）

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Button, Menu, MenuItem, Modal, Popover, EmptyState, toast } from "../../components/ui";
import { confirmSoftDelete } from "../../components/feedback";
// 阶段 4：统一撤销 toast（R-D-22）+ 长标题截断带 title（R-I-29）
import { TruncatedText, toastDeleted } from "../../components/interaction";
import type { KbDocDTO, KbDocKind } from "../../api/client";
import {
  useKb,
  useKbDocs,
  useCreateDoc,
  useRenameDoc,
  useDeleteDoc,
  useMoveDoc,
  useRestoreDoc,
} from "./kb-hooks";
import { DocKindIcon } from "./kb-ui";
import { EntityIconPicker } from "../../components/EntityIconPicker";
import { colors } from "@gx/design-tokens";

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
  const { data: kb, isLoading: kbLoading } = useKb(kbId);
  const { data: docs, isLoading } = useKbDocs(kbId, "all");
  const createDoc = useCreateDoc(kbId);
  const deleteDoc = useDeleteDoc(kbId);
  const restoreDoc = useRestoreDoc(kbId);
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
  // 「图标与颜色」入口：树里行内改名输入框很窄塞不下选择器，故走行尾菜单 → 独立弹窗
  const [iconFor, setIconFor] = useState<string | null>(null);
  // 「更多操作」弹层的定位锚点：深层级节点缩进后按钮贴近右缘，absolute 弹层会被
  // .kb-tree(overflow:auto) 裁剪，故用 fixed portal 弹层并按触发按钮视口坐标定位。
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string | null; zone: "into" | "root" } | null>(null);

  const renameDoc = useRenameDoc(renamingId ?? "__none__", kbId);
  const renameIconDoc = useRenameDoc(iconFor ?? "__none__", kbId);

  useEffect(() => {
    localStorage.setItem(`gx-kb-tab-${kbId}`, tab);
  }, [tab, kbId]);
  useEffect(() => {
    localStorage.setItem(`gx-kb-collapsed-${kbId}`, JSON.stringify([...collapsed]));
  }, [collapsed, kbId]);

  const canEdit = useMemo(() => {
    // PERM-S2：加载中按 owner 兜底（避免闪现禁用形态），加载失败（403 等）一律按 viewer——
    // 宁可让无权者短暂多看，不能让无权者在失败态拿到可点的新建/删除入口。
    const r = kbLoading ? "owner" : (kb?.role ?? "viewer");
    return r === "owner" || r === "editor";
  }, [kb?.role, kbLoading]);

  const docsList = useMemo(() => (docs ?? []).filter((d) => !d.deletedAt), [docs]);
  // 图标弹窗绑定的实体：按 id 从列表取，改完 invalidation 回来即跟随更新
  const iconEntity = docsList.find((d) => d.id === iconFor) ?? null;
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
    // R-D-23 L2（可恢复：软删除进回收站）+ R-D-24 主按钮用具体动词
    const ok = await confirmSoftDelete({
      title: `删除「${d.title}」`,
      confirmText: "删除并移入回收站",
      description: "文档会移入回收站，30 天内可恢复；下级文档会一并保留在回收站。",
    });
    if (!ok) return;
    try {
      await deleteDoc.mutateAsync(d.id);
      // R-D-22 删除类成功 toast 必须带「撤销」，窗口 6 秒
      toastDeleted({
        message: `已移入回收站「${d.title || "未命名"}」`,
        restoredMessage: `已恢复「${d.title || "未命名"}」`,
        onUndo: () => restoreDoc.mutateAsync(d.id),
      });
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
            // P3-a11y：纯图标折叠箭头必须有可访问名称；无子级时它只是对齐占位，
            // 直接 aria-hidden + 移出 Tab 序列，别让读屏念出一个点不动的「按钮」。
            aria-label={hasChildren ? `${node.title || "未命名"} ${isCollapsed ? "展开子文档" : "折叠子文档"}` : undefined}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            aria-hidden={hasChildren ? undefined : true}
            tabIndex={hasChildren ? undefined : -1}
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
            <DocKindIcon kind={node.kind} size={14} icon={node.icon} iconColor={node.iconColor} />
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
              // R-I-29：树里缩进后可用宽度很窄，长标题必须截断 + title 全文
              <TruncatedText text={node.title || "未命名"} className="kb-tree-label" />
            )}
          </button>
          {canEdit && !renaming && (
            <span className="relative">
              <button
                type="button"
                className="kb-tree-more"
                // P3-a11y：纯图标行尾菜单，给具体作用名（不写泛泛的「更多」）
                aria-label={`${node.title || "未命名"} 文档操作菜单`}
                aria-haspopup="menu"
                aria-expanded={menuFor === node.id}
                onClick={(e) => { e.stopPropagation(); openMenu(node.id, e.currentTarget); }}
                title="更多操作"
              >
                <Icon name="more" size={14} />
              </button>
              <Popover open={menuFor === node.id} onClose={() => setMenuFor(null)} align="left" width={160} fixed anchorEl={menuAnchor}>
                <Menu width={160}>
                  <MenuItem icon="plus" label="新建子文档" onClick={() => create("doc", node.id)} />
                  <MenuItem icon="edit" label="重命名" onClick={() => startRename(node)} />
                  <MenuItem
                    icon="palette"
                    label="图标与颜色"
                    onClick={() => {
                      setMenuFor(null);
                      setIconFor(node.id);
                    }}
                  />
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
          <DocKindIcon kind={d.kind} size={14} icon={d.icon} iconColor={d.iconColor} />
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
            <TruncatedText text={d.title || "未命名"} className="kb-tree-label" />
          )}
        </button>
        {canEdit && !renaming && (
          <span className="relative">
            <button
              type="button"
              className="kb-tree-more"
              // P3-a11y：画布行的行尾菜单，同上给具体作用名
              aria-label={`${d.title || "未命名"} 画布操作菜单`}
              aria-haspopup="menu"
              aria-expanded={menuFor === d.id}
              onClick={(e) => { e.stopPropagation(); openMenu(d.id, e.currentTarget); }}
              title="更多操作"
            >
              <Icon name="more" size={14} />
            </button>
            <Popover open={menuFor === d.id} onClose={() => setMenuFor(null)} align="left" width={150} fixed anchorEl={menuAnchor}>
              <Menu width={150}>
                <MenuItem icon="edit" label="重命名" onClick={() => startRename(d)} />
                <MenuItem
                  icon="palette"
                  label="图标与颜色"
                  onClick={() => {
                    setMenuFor(null);
                    setIconFor(d.id);
                  }}
                />
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
      <div className="mx-2 mb-2 flex rounded-gx-lg bg-gx-bg p-0.5">
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
              <button type="button" className="kb-tree-add" title="新建文档" aria-label="新建文档" onClick={() => create("doc")}>
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
          {docTree.length === 0 ? (
            // R-D-13 空态：图标 + 主文案 + 次文案 + 行动入口（保住「新建」入口，不丢信息）
            <EmptyState
              icon="doc"
              title="暂无文档"
              description={canEdit ? "点击上方「+」新建第一篇文档。" : undefined}
              action={
                canEdit ? (
                  <Button size="sm" variant="primary" icon="plus" onClick={() => create("doc")}>
                    新建文档
                  </Button>
                ) : undefined
              }
              className="py-8"
            />
          ) : (
            docTree.map((n) => renderDocNode(n, 0))
          )}
        </>
      ) : (
        <>
          <div className="kb-tree-section">
            <Icon name="canvas" size={13} className="text-gx-text-hint" />
            <span className="kb-tree-title">画布</span>
            {canEdit && (
              <button type="button" className="kb-tree-add" title="新建画布" aria-label="新建画布" onClick={() => create("canvas")}>
                <Icon name="plus" size={13} />
              </button>
            )}
          </div>
          {canvases.length === 0 ? (
            <EmptyState
              icon="canvas"
              title="暂无画布"
              description={canEdit ? "点击上方「+」新建一块画布。" : undefined}
              action={
                canEdit ? (
                  <Button size="sm" variant="primary" icon="plus" onClick={() => create("canvas")}>
                    新建画布
                  </Button>
                ) : undefined
              }
              className="py-8"
            />
          ) : (
            canvases.map(renderCanvas)
          )}
        </>
      )}

      {/* 图标与颜色（文档 / 画布）：选完即时生效，不走「保存」。
          入口在行尾菜单（canEdit 才有），此处只负责渲染；实体不存在时不挂载。 */}
      <Modal
        open={!!iconEntity}
        title={`${iconEntity?.kind === "canvas" ? "画布" : "文档"}图标与颜色`}
        onClose={() => setIconFor(null)}
        footer={
          <button
            className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
            onClick={() => setIconFor(null)}
          >
            完成
          </button>
        }
      >
        {iconEntity && (
          <div className="flex items-center gap-3">
            <EntityIconPicker
              icon={iconEntity.icon ?? null}
              iconColor={iconEntity.iconColor ?? null}
              defaultIcon={iconEntity.kind === "canvas" ? "canvas" : "doc"}
              defaultColor={iconEntity.kind === "canvas" ? colors.secondaryAlt : colors.accent}
              onChange={(next) => renameIconDoc.mutateAsync({ icon: next.icon, iconColor: next.iconColor })}
            />
            <span className="text-gx-12 text-gx-text-hint">
              选择后立即生效；「恢复默认」清除自定义图标与颜色。
            </span>
          </div>
        )}
      </Modal>
    </div>
  );
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}
