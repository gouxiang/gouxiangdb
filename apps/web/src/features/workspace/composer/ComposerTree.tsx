// M3/S9 导航编排树（菜单引用层编辑态）：
//   - grip HTML5 拖拽做菜单层排序/跨容器移动（零权威副作用，AC-M3-1 边界）
//   - 双击/编辑按钮内联改别名（Esc 取消、Enter/失焦保存）
//   - 容器行：添加实体（多处挂载）
//   - 行尾删除（容器弹 DeleteMenuModal 选策略）
// 权威实体移动（拖到 group）在二级树中走 move-impact，不在这里。
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../../components/icons";
import type { MenuDraft } from "../lib/menu-ops";
import {
  buildMenuTree,
  composerItemState,
  filterComposerItems,
  flattenMenuRows,
  type MenuTreeNode,
} from "../lib/menu-tree";
import { useMenuVirtualizer } from "../lib/useMenuVirtualizer";
import { navKindIcon } from "../PrimaryNav";

/** 编排树行固定行高（py-1.5 + 14px 内容 ≈ 31），窗口化按此映射。 */
const COMPOSER_ROW_H = 31;

export interface DropTarget {
  parentId: string | null;
  /** 插入位（拔出拖拽项后的同父序列索引）；大数 = 末尾。 */
  index: number;
}

// 编排态仅 broken 会显灰（soft_dangling 全员隐藏，见 isComposerVisible）。
const STATE_LABEL: Partial<Record<string, string>> = {
  broken: "已失效",
};

function AliasEditor({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSave(v.trim());
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onSave(v.trim())}
      maxLength={60}
      className="h-6 min-w-0 flex-1 rounded-gx-sm border border-gx-accent bg-gx-surface px-1.5 text-gx-13 text-gx-text-primary outline-none"
    />
  );
}

interface RowProps {
  node: MenuTreeNode;
  depth: number;
  /** parentId → 同 parent（拔出拖拽项后）的兄弟 id 有序表，用于换算落点 index。 */
  siblingMap: Map<string | null, string[]>;
  dragId: string | null;
  hover: DropTarget | null;
  editingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onMove: (target: DropTarget) => void;
  onHoverChange: (t: DropTarget | null) => void;
  onRename: (id: string, label: string) => void;
  onStartEdit: (id: string | null) => void;
  onAdd: (container: MenuTreeNode) => void;
  onDelete: (item: MenuDraft) => void;
}

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  return a !== null && a.parentId === b.parentId && a.index === b.index;
}

function Row(props: RowProps) {
  const { node, depth, dragId, hover, editingId, siblingMap } = props;
  const { item } = node;
  const siblingsExcludingDrag = siblingMap.get(item.parentId) ?? [];
  const summary = item.node;
  const isContainer = item.type === "container";
  // 容器菜单项 node 恒 null（契约），不能因缺摘要被误标“已失效”；判定收口到纯函数。
  const state = composerItemState(item);
  const dangling = state !== "alive";
  const icon: IconName = isContainer
    ? "folderOpen"
    : summary?.kind
      ? navKindIcon(summary.kind)
      : "link";
  const displayName = item.label ?? summary?.name ?? "未命名";
  const editing = editingId === item.id;

  const pos = siblingsExcludingDrag.indexOf(item.id);
  const beforeTarget: DropTarget = { parentId: item.parentId, index: Math.max(0, pos) };
  const afterTarget: DropTarget = { parentId: item.parentId, index: pos < 0 ? siblingsExcludingDrag.length : pos + 1 };
  const intoTarget: DropTarget = { parentId: item.id, index: 9999 };

  const beforeActive = sameTarget(hover, beforeTarget);
  const afterActive = !isContainer && sameTarget(hover, afterTarget);
  const intoActive = isContainer && sameTarget(hover, intoTarget);
  const lineActive = beforeActive || afterActive;

  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={() => props.onDragStart(item.id)}
        onDragEnd={props.onDragEnd}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          const lowerHalf = e.clientY > rect.top + rect.height / 2;
          if (isContainer && lowerHalf) props.onHoverChange(intoTarget);
          else if (lowerHalf) props.onHoverChange(afterTarget);
          else props.onHoverChange(beforeTarget);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) props.onHoverChange(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (hover) props.onMove(hover);
        }}
        className={[
          "group relative flex items-center gap-1.5 rounded-gx-sm py-1.5 pr-1.5",
          dragId === item.id ? "opacity-40" : "",
          intoActive ? "bg-gx-accent-bg" : "hover:bg-gx-row-hover",
        ].join(" ")}
        style={{ paddingLeft: 8 + depth * 15 }}
      >
        {lineActive && <span className="pointer-events-none absolute left-2 right-2 top-0 h-0.5 rounded bg-gx-accent" />}
        {intoActive && <span className="pointer-events-none absolute inset-0 rounded-gx-sm ring-1 ring-gx-accent/40" />}
        <span className="cursor-grab text-gx-text-hint hover:text-gx-text-tertiary active:cursor-grabbing">
          <Icon name="grip" size={13} />
        </span>
        <Icon name={icon} size={14} className={`shrink-0 ${dangling ? "text-gx-text-hint" : "text-gx-text-tertiary"}`} />
        {editing ? (
          <AliasEditor
            initial={item.label ?? summary?.name ?? ""}
            onSave={(v) => props.onRename(item.id, v)}
            onCancel={() => props.onStartEdit(null)}
          />
        ) : (
          <span
            className="min-w-0 flex-1 cursor-default truncate text-gx-13"
            onDoubleClick={() => props.onStartEdit(item.id)}
            title={item.label ? summary?.name : undefined}
          >
            <span className={dangling ? "text-gx-text-hint line-through" : "text-gx-text-primary"}>{displayName}</span>
          </span>
        )}
        {item.label && summary?.name && item.label !== summary.name && !editing && (
          <span className="shrink-0 text-gx-11 text-gx-text-hint">→ {summary.name}</span>
        )}
        {dangling && (
          <span className="shrink-0 rounded-gx-pill bg-gx-warning-bg px-1.5 py-0.5 text-gx-11 text-gx-warning">
            {STATE_LABEL[state]}
          </span>
        )}
        {!editing && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            {isContainer && (
              <IconButton2 label="添加实体到容器" onClick={() => props.onAdd(node)}>
                <Icon name="plus" size={13} />
              </IconButton2>
            )}
            <IconButton2 label="编辑别名（双击名称也可）" onClick={() => props.onStartEdit(item.id)}>
              <Icon name="edit" size={13} />
            </IconButton2>
            <IconButton2 label="删除" danger onClick={() => props.onDelete(item)}>
              <Icon name="trash" size={13} />
            </IconButton2>
          </span>
        )}
      </div>
      {node.children.map((c) => (
        <Row key={c.item.id} {...props} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

export function ComposerTree(props: Omit<RowProps, "node" | "depth" | "siblingMap"> & { items: readonly MenuDraft[] }) {
  const { items, dragId, onMove, onHoverChange } = props;
  // 编排态同样全员隐藏 soft_dangling（源软删，保留引用待恢复，不暴露给管理者编辑）；
  // 仅视图层过滤——draft 仍保留这些项，diffMenu 对未改动的原项不产生 delete，恢复后自动还原。
  const visible = filterComposerItems(items) as MenuDraft[];
  const tree = buildMenuTree(visible);

  // 编排容器恒展开，摊平为定高行做窗口化（S10：1000+ 项只挂载视口 DOM，不引新依赖）。
  const rows = flattenMenuRows(tree, () => true);
  const virt = useMenuVirtualizer(rows, COMPOSER_ROW_H);

  // parentId → 有序兄弟 id（拖拽期间排除被拖项，落点 index 以此为准）
  const siblingMap = new Map<string | null, string[]>();
  for (const i of visible) {
    if (i.id === dragId) continue;
    const key = i.parentId;
    const arr = siblingMap.get(key) ?? [];
    arr.push(i.id);
    siblingMap.set(key, arr);
  }
  for (const arr of siblingMap.values()) {
    arr.sort((a, b) => {
      const ia = visible.find((i) => i.id === a)!;
      const ib = visible.find((i) => i.id === b)!;
      return ia.ord !== ib.ord ? ia.ord - ib.ord : a < b ? -1 : 1;
    });
  }

  return (
    <div ref={virt.scrollerRef} className="h-full overflow-y-auto">
      <div style={{ paddingTop: virt.padTop, paddingBottom: virt.padBottom }}>
        {virt.windowed.map((r) => (
          <Row key={r.node.item.id} {...props} node={r.node} depth={r.depth} siblingMap={siblingMap} />
        ))}
      </div>
      {/* 根层放置条带：拖到列表下方空白 = 根层末尾 */}
      <div
        onDragOver={(e) => {
          if (dragId) {
            e.preventDefault();
            onHoverChange({ parentId: null, index: 9999 });
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          onMove({ parentId: null, index: 9999 });
        }}
        className="h-10"
      />
    </div>
  );
}

function IconButton2({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-gx-sm p-1 hover:bg-gx-bg ${danger ? "text-gx-danger hover:bg-gx-danger-bg" : "text-gx-text-tertiary hover:text-gx-text-primary"}`}
    >
      {children}
    </button>
  );
}
