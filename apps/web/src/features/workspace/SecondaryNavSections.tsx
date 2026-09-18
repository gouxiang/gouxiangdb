// M3/S9 二级导航分区：table/doc/canvas 三段，doc 段支持按权威 parentId 树展开。
// S10：三段合并为一条定高行序列（段头同样定高）交由 SecondaryNav 单窗口切片，
// 大表未收纳列表（可达上千行）只挂载视口附近 DOM；本文件只保留纯函数与行组件。
import { useRef, useState } from "react";
import { Icon, type IconName } from "../../components/icons";
import { Menu, MenuItem, Popover } from "../../components/ui";
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

/**
 * 行尾「竖向三点」操作菜单（R-N-11/12）。
 *
 * 四条护栏全部成立，缺一即视为不合格：
 *   ① 占位常驻 20×20（span h-5 w-5），显隐不改行宽行高；
 *   ② 菜单打开期间强制可见（data-open="true" → CSS 强制 opacity 1）；
 *   ③ 触屏（`@media (hover: none)`）常驻可见 —— 由 index.css 的媒体查询兜；
 *   ④ 键盘 focus-within / focus-visible 可见 —— 同上。
 * 默认隐藏与 hover 显现同样由 `.gx-row-more`（index.css）统一承载，避免各调用点各写一半。
 */
export function RowMoreMenu({ items }: { items: RowMoreItem[] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return <span aria-hidden className="h-5 w-5 shrink-0" />;
  return (
    <span
      className="gx-row-more flex h-5 w-5 shrink-0 items-center justify-center"
      data-open={open ? "true" : "false"}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label="行操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="行操作"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-5 w-5 items-center justify-center rounded-gx-sm text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary after:absolute after:-inset-1.5 after:content-['']"
      >
        <Icon name="moreVertical" size={14} />
      </button>
      {open && (
        // fixed：二级列表是滚动容器（overflow-y-auto），absolute 弹层会被裁掉，故 portal 到 body
        <Popover open onClose={() => setOpen(false)} align="right" width={168} fixed anchorEl={btnRef.current}>
          <Menu width={168}>
            {items.map((it) => (
              <MenuItem
                key={it.label}
                icon={it.icon}
                label={it.label}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              />
            ))}
          </Menu>
        </Popover>
      )}
    </span>
  );
}

export interface RowMoreItem {
  label: string;
  icon: IconName;
  onClick: () => void;
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
  // R-N-10 选中态：白底 + 圆角 8 + accent 字 600；hover 底 #F1F5FB。左侧色条已按规范移除。
  const menuItems: RowMoreItem[] = [
    ...(tab === "uncollected" ? [{ label: "收纳到导航", icon: "plus" as IconName, onClick: () => onCollect(e) }] : []),
    { label: "移动到分组…", icon: "folderOpen" as IconName, onClick: () => onMove(e) },
  ];
  return (
    <div
      className={[
        "group relative flex items-center gap-1 rounded-gx-lg py-1.5 pr-1 transition-colors",
        active ? "bg-white font-semibold text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
      ].join(" ")}
      style={{ height: SECONDARY_ROW_H, paddingLeft: 6 + depth * 13 }}
    >
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
      <RowMoreMenu items={menuItems} />
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
