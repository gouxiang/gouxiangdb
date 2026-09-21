// apps/web/src/features/kb/PublicShareTree.tsx
// 公开分享页左侧「分享文档树」：仅展示被分享根节点及其下级，支持展开/收起/点击切换。
// 从 PublicSharePage 抽出，避免单文件超 300 行；行为与抽取前一致。

import { useMemo, useState } from "react";
import { Icon } from "../../components/icons";
import type { KbTreeItemDTO } from "../../api/client";
import { DocKindIcon } from "./kb-ui";

interface TreeNode extends KbTreeItemDTO {
  children: TreeNode[];
}

export function buildTree(items: KbTreeItemDTO[], rootId: string): TreeNode[] {
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

export function PublicShareTree({
  items,
  rootId,
  activeId,
  onOpen,
}: {
  items: KbTreeItemDTO[];
  rootId: string;
  activeId?: string;
  onOpen: (id: string) => void;
}) {
  const tree = useMemo(() => buildTree(items, rootId), [items, rootId]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {tree.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          activeId={activeId}
          collapsed={collapsed}
          onToggle={toggle}
          onOpen={onOpen}
        />
      ))}
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
