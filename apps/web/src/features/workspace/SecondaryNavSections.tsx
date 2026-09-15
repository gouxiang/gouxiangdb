// M3/S9 二级导航分区：table/doc/canvas 三段，doc 段支持按权威 parentId 树展开。
// S10：三段合并为一条定高行序列（段头同样定高）交由 SecondaryNav 单窗口切片，
// 大表未收纳列表（可达上千行）只挂载视口附近 DOM；本文件只保留纯函数与行组件。
import { Icon, type IconName } from "../../components/icons";
import type { NodeIndex } from "./lib/nav-links";
import { navNodeHref } from "./lib/nav-links";
import { navKindIcon } from "./PrimaryNav";
import type { CollectableEntry, CollectionView } from "./lib/collection";

/** 二级行固定行高（含段头；py-1.5 + 13px 内容 ≈ 31），窗口化按此映射滚动位置。 */
export const SECONDARY_ROW_H = 31;

export type SectionKind = "table" | "doc" | "canvas";

/** 摊平后的二级行：段头或实体行（depth 仅 doc 段可能 > 0）。 */
export type SecondaryFlatRow =
  | { type: "header"; kind: SectionKind; count: number }
  | {
      type: "entry";
      kind: SectionKind;
      entry: CollectableEntry;
      depth: number;
      hasDocKids: boolean;
      expanded: boolean;
    };

/**
 * 三段合并为一条定高行序列（空段不产段头，与 S9 空段不渲染一致）。
 * doc 段按 expandedDocs 深度优先摊平并直接带出 depth，调用方无需事后上溯父链。
 * 纯函数：大列表下总行数在此一次确定，组件再用 virtualWindow 切片，DOM 不随总量线性膨胀。
 */
export function buildSecondaryRows(
  sections: Record<SectionKind, CollectableEntry[]>,
  expandedDocs: Set<string>,
  docChildren: Map<string, CollectableEntry[]>,
): SecondaryFlatRow[] {
  const rows: SecondaryFlatRow[] = [];
  (["table", "doc", "canvas"] as const).forEach((kind) => {
    const entries = sections[kind];
    if (entries.length === 0) return;
    rows.push({ type: "header", kind, count: entries.length });
    if (kind !== "doc") {
      for (const entry of entries) rows.push({ type: "entry", kind, entry, depth: 0, hasDocKids: false, expanded: false });
      return;
    }
    const roots = entries.filter((e) => e.isRootDoc || !docChildren.has(e.node.parentId ?? ""));
    const push = (list: CollectableEntry[], depth: number) => {
      for (const entry of list) {
        const kids = docChildren.get(entry.node.id) ?? [];
        const expanded = expandedDocs.has(entry.node.id);
        rows.push({ type: "entry", kind, entry, depth, hasDocKids: kids.length > 0, expanded });
        if (expanded) push(kids, depth + 1);
      }
    };
    push(roots, 0);
  });
  return rows;
}

/** 段头中文标签。 */
export function sectionLabel(kind: SectionKind): string {
  return kind === "table" ? "数据表" : kind === "doc" ? "文档" : "画布";
}

export function SectionHeader({ kind, count }: { kind: SectionKind; count: number }) {
  return (
    <div
      style={{ height: SECONDARY_ROW_H }}
      className="flex items-center px-2 text-gx-11 font-medium text-gx-text-hint"
    >
      {sectionLabel(kind)} {count}
    </div>
  );
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

export function SecondaryRow({
  kind,
  entry: e,
  depth,
  hasDocKids,
  expanded,
  currentResource,
  index,
  tab,
  onToggleDoc,
  onNavigate,
  onCollect,
  onMove,
}: {
  kind: SectionKind;
  entry: CollectableEntry;
  depth: number;
  hasDocKids: boolean;
  expanded: boolean;
  currentResource: string | null;
  index: NodeIndex;
  tab: CollectionView;
  onToggleDoc: (id: string) => void;
  onNavigate: (href: string) => void;
  onCollect: (e: CollectableEntry) => void;
  onMove: (e: CollectableEntry) => void;
}) {
  const href = navNodeHref(index, e.node);
  const active = currentResource === e.node.resourceId;
  const icon: IconName = navKindIcon(kind);
  return (
    <div
      className={[
        "group relative flex items-center gap-1 rounded-gx-sm py-1.5 pr-1",
        active ? "bg-gx-accent-bg text-gx-accent" : "hover:bg-gx-row-hover",
      ].join(" ")}
      style={{ height: SECONDARY_ROW_H, paddingLeft: 6 + depth * 13 }}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r bg-gx-accent" />}
      {kind === "doc" ? (
        <button
          type="button"
          onClick={() => hasDocKids && onToggleDoc(e.node.id)}
          className={`rounded p-0.5 ${hasDocKids ? "text-gx-text-hint hover:text-gx-text-secondary" : "invisible"}`}
          aria-label={expanded ? "折叠" : "展开"}
          aria-expanded={expanded}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={11} />
        </button>
      ) : null}
      <Icon name={icon} size={13} className={`shrink-0 ${active ? "text-gx-accent" : "text-gx-text-tertiary"}`} />
      <button
        type="button"
        disabled={!href}
        onClick={() => href && onNavigate(href)}
        className={`min-w-0 flex-1 truncate text-left text-gx-13 ${href ? "" : "cursor-not-allowed opacity-50"} ${active ? "font-medium text-gx-text-primary" : "text-gx-text-primary"}`}
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
  );
}

/** 三视角条目按类型分组（顺序 table → doc → canvas）。 */
export function groupByKind(entries: CollectableEntry[]): Record<SectionKind, CollectableEntry[]> {
  return {
    table: entries.filter((e) => e.kind === "table"),
    doc: entries.filter((e) => e.kind === "doc"),
    canvas: entries.filter((e) => e.kind === "canvas"),
  };
}
