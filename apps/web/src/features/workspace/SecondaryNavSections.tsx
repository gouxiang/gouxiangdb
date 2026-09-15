// M3/S9 二级导航分区列表：table/doc/canvas 三段，doc 段支持按权威 parentId 树展开。
// 从 SecondaryNav 抽出以控制单文件行数；纯展示 + 行回调，不含数据请求。
import { Icon, type IconName } from "../../components/icons";
import type { NodeIndex } from "./lib/nav-links";
import { navNodeHref } from "./lib/nav-links";
import { navKindIcon } from "./PrimaryNav";
import type { CollectableEntry, CollectionView } from "./lib/collection";

export interface SectionListProps {
  kind: "table" | "doc" | "canvas";
  entries: CollectableEntry[];
  tab: CollectionView;
  currentResource: string | null;
  index: NodeIndex;
  expandedDocs: Set<string>;
  docChildren: Map<string, CollectableEntry[]>;
  onToggleDoc: (id: string) => void;
  onNavigate: (href: string) => void;
  onCollect: (e: CollectableEntry) => void;
  onMove: (e: CollectableEntry) => void;
}

function RowAction({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-gx-sm p-1 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
    >
      {children}
    </button>
  );
}

export function SectionList(props: SectionListProps) {
  const { kind, entries, tab, currentResource, index, expandedDocs, docChildren, onToggleDoc, onNavigate, onCollect, onMove } =
    props;
  if (entries.length === 0) return null;
  const label = kind === "table" ? "数据表" : kind === "doc" ? "文档" : "画布";
  const icon: IconName = navKindIcon(kind);

  const renderRow = (e: CollectableEntry, depth: number) => {
    const href = navNodeHref(index, e.node);
    const active = currentResource === e.node.resourceId;
    const kids = kind === "doc" ? docChildren.get(e.node.id) ?? [] : [];
    const expanded = expandedDocs.has(e.node.id);
    return (
      <div key={e.node.id}>
        <div
          className={[
            "group relative flex items-center gap-1 rounded-gx-sm py-1.5 pr-1",
            active ? "bg-gx-accent-bg text-gx-accent" : "hover:bg-gx-row-hover",
          ].join(" ")}
          style={{ paddingLeft: 6 + depth * 13 }}
        >
          {active && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r bg-gx-accent" />}
          {kind === "doc" ? (
            <button
              type="button"
              onClick={() => kids.length && onToggleDoc(e.node.id)}
              className={`rounded p-0.5 ${kids.length ? "text-gx-text-hint hover:text-gx-text-secondary" : "invisible"}`}
              aria-label={expanded ? "折叠" : "展开"}
            >
              <Icon name={expanded ? "chevronDown" : "chevronRight"} size={11} />
            </button>
          ) : null}
          <Icon name={icon} size={13} className={`shrink-0 ${active ? "text-gx-accent" : "text-gx-text-tertiary"}`} />
          <button
            type="button"
            disabled={!href}
            onClick={() => href && onNavigate(href)}
            className={`min-w-0 flex-1 truncate text-left text-gx-13 ${href ? "" : "cursor-not-allowed opacity-50"} ${active ? "font-medium" : "text-gx-text-primary"}`}
            title={e.shortcuts.length ? `已在 ${e.shortcuts.length} 处菜单引用` : undefined}
          >
            {e.node.name}
          </button>
          {e.shortcuts.length > 0 && <Icon name="check" size={12} className="shrink-0 text-gx-text-hint" />}
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            {tab === "uncollected" && (
              <RowAction label="收纳到导航" onClick={() => onCollect(e)}>
                <Icon name="plus" size={13} />
              </RowAction>
            )}
            <RowAction label="移动到分组…" onClick={() => onMove(e)}>
              <Icon name="folderOpen" size={13} />
            </RowAction>
          </span>
        </div>
        {kind === "doc" && expanded && kids.map((k) => renderRow(k, depth + 1))}
      </div>
    );
  };

  // 文档分段按根级 doc 起树（嵌套 doc 由展开渲染）；table/canvas 平铺
  const visibleRoots =
    kind === "doc" ? entries.filter((e) => e.isRootDoc || !docChildren.has(e.node.parentId ?? "")) : entries;

  return (
    <div className="mb-1 px-1.5">
      <div className="px-2 py-1 text-gx-11 font-medium text-gx-text-hint">
        {label} {entries.length}
      </div>
      {visibleRoots.map((e) => renderRow(e, 0))}
    </div>
  );
}

/** 三视角条目按类型分组（顺序 table → doc → canvas）。 */
export function groupByKind(entries: CollectableEntry[]) {
  return {
    table: entries.filter((e) => e.kind === "table"),
    doc: entries.filter((e) => e.kind === "doc"),
    canvas: entries.filter((e) => e.kind === "canvas"),
  };
}
