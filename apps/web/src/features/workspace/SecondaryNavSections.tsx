// M3/S9 二级导航分区：table/doc/canvas 三段，doc 段支持按权威 parentId 树展开。
// S10：三段合并为一条定高行序列（段头同样定高）交由 SecondaryNav 单窗口切片，
// 大表列表（可达上千行）只挂载视口附近 DOM；本文件只保留纯函数与行组件。
//
// 第三批导航重构：L2 的语义从「收纳/未收纳」改为「选中容器的子项」，
// 数据源不再走 menu_items + buildCollection，而是直接用资源本体（TableDTO / KbDocDTO）
// 摊成这里的轻量条目 SecondaryEntry —— 原来挂在 CollectableEntry 上的
// 「已收纳处数 / shortcuts / 收纳到导航」一并不存在了。
import { useRef, useState } from "react";
import { Icon, type IconName } from "../../components/icons";
import { Menu, MenuItem, Popover } from "../../components/ui";
import { resolveEntityIcon, resolvedEntityColor, type EntityIconValue } from "../../components/EntityIconPicker";
import { navKindIcon } from "./PrimaryNav";

/** 二级行固定行高（含段头；py-1.5 + 13px 内容 ≈ 31），窗口化按此映射滚动位置。 */
export const SECONDARY_ROW_H = 31;

export type SectionKind = "table" | "doc" | "canvas";

/**
 * 二级列表条目：与数据源解耦的最小形态（资源本体适配后的结果）。
 * icon/iconColor 沿用五类实体统一的自定义图标口径（EntityIconValue）。
 */
export interface SecondaryEntry extends EntityIconValue {
  id: string;
  name: string;
  kind: SectionKind;
  parentId?: string | null;
  href: string;
}

/** 摊平后的二级行：段头或实体行（depth 仅 doc 段可能 > 0）。 */
export type SecondaryFlatRow =
  | { type: "header"; kind: SectionKind; count: number }
  | {
      type: "entry";
      kind: SectionKind;
      entry: SecondaryEntry;
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
  sections: Record<SectionKind, SecondaryEntry[]>,
  expandedDocs: Set<string>,
  docChildren: Map<string, SecondaryEntry[]>,
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
    const roots = entries.filter((e) => !e.parentId || !docChildren.has(e.parentId));
    const push = (list: SecondaryEntry[], depth: number) => {
      for (const entry of list) {
        const kids = docChildren.get(entry.id) ?? [];
        const expanded = expandedDocs.has(entry.id);
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

/** P3-a11y：行尾三点菜单的可访问名称由调用点给出（按行类型给具体作用，不写泛泛的「更多」）。 */

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
/**
 * P3-a11y 收尾：`label` 让调用点给出「表操作菜单 / 文档操作菜单 / 画布操作菜单」这类具体名称，
 * 默认「行操作」保留给未指定的调用点（不破坏既有行为）。
 * 该 label 是 `.gx-row-more` 键盘护栏（focus-within 可见）的必要配套：键盘用户 Tab 到这个
 * 只有图标的按钮时，读屏必须能念出它管的是哪一行的操作。
 */
export function RowMoreMenu({ items, label = "行操作" }: { items: RowMoreItem[]; label?: string }) {
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
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
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
                description={it.description}
                danger={it.danger}
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
  /** 危险动作（删除 / 清空）：菜单项走 danger 红字，与站内既有菜单口径一致。 */
  danger?: boolean;
  /** 次行说明（如「进入表单设计器」）。 */
  description?: string;
}

/**
 * 文档行的拖拽状态（KB 文档改层级）。画布行不参与——服务端 moveDoc 的层级语义
 * 只用在文档树上（旧 KbTree 同样把画布排除在级联之外），不造后端没有的语义。
 */
export interface SecondaryRowDrag {
  draggable: boolean;
  /** 该行正在被拖（半透明） */
  dragging: boolean;
  /** 该行是当前落点（成为其子级） */
  dropInto: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: { preventDefault: () => void }) => void;
  onDrop: (e: { preventDefault: () => void }) => void;
}

/**
 * 二级实体行（第三批）：点整行进对应的表 / 文档 / 画布。
 *
 * 行尾「竖向三点」行菜单在第四批按行类型回挂：
 *   表行   → 重命名 / 编辑表单 / 复制表×2 / 清空数据 / 删除表（见 SecondaryNavTableOps）；
 *   文档行 → 拖拽改层级（见 SecondaryNavKbOps），菜单仍不挂（后端无文档级其它行操作）。
 * 菜单由调用点给出；不给时不渲染（列表保持纯导航形态，行宽行高不变）。
 */
export function SecondaryRow({
  kind,
  entry: e,
  depth,
  hasDocKids,
  expanded,
  active,
  onToggleDoc,
  onNavigate,
  menu,
  menuLabel,
  drag = null,
}: {
  kind: SectionKind;
  entry: SecondaryEntry;
  depth: number;
  hasDocKids: boolean;
  expanded: boolean;
  active: boolean;
  onToggleDoc: (id: string) => void;
  onNavigate: (href: string) => void;
  /** 行尾菜单项；空数组 / 不给 = 不渲染三点（无权限即不渲染，不做禁用假入口）。 */
  menu?: RowMoreItem[];
  /** 行尾菜单的可访问名称（按行类型给具体作用名）。 */
  menuLabel?: string;
  /** 拖拽状态；只有文档行给。 */
  drag?: SecondaryRowDrag | null;
}) {
  const resolved = resolveEntityIcon(e, { name: navKindIcon(kind) });
  const color = resolvedEntityColor(e);
  // R-N-10 选中态：白底 + 圆角 8 + accent 字 600；hover 底 #F1F5FB。左侧色条已按规范移除。
  // 落点态（dropInto）与选中态互斥取一：两个 bg-* 同权重会互相覆盖，不能并列写进 class。
  return (
    <div
      draggable={drag?.draggable ?? false}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      data-drag={drag?.dragging ? "source" : undefined}
      data-drop-into={drag?.dropInto ? "into" : undefined}
      className={[
        "group relative flex items-center gap-1 rounded-gx-lg py-1.5 pr-1 transition-colors",
        active
          ? "bg-white font-semibold text-gx-accent"
          : drag?.dropInto
            ? "bg-gx-accent-bg text-gx-accent"
            : "text-gx-text-primary hover:bg-gx-row-hover",
        drag?.dragging ? "opacity-40" : "",
      ].join(" ")}
      style={{ height: SECONDARY_ROW_H, paddingLeft: 6 + depth * 13 }}
    >
      {kind === "doc" ? (
        <button
          type="button"
          onClick={() => hasDocKids && onToggleDoc(e.id)}
          className={`rounded p-0.5 ${hasDocKids ? "text-gx-text-hint hover:text-gx-text-secondary" : "invisible"}`}
          aria-label={expanded ? "折叠" : "展开"}
          aria-expanded={expanded}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={11} />
        </button>
      ) : null}
      <Icon
        name={resolved.name}
        size={13}
        className={`shrink-0 ${active ? "text-gx-accent" : "text-gx-text-tertiary"}`}
        style={color ? { color } : undefined}
      />
      <button
        type="button"
        disabled={!e.href}
        onClick={() => e.href && onNavigate(e.href)}
        // P3-a11y + 回归可断言：当前所在的二级项要给读屏「当前页」语义（aria-current="page"）
        aria-current={active ? "page" : undefined}
        title={e.name}
        className={`min-w-0 flex-1 truncate text-left text-gx-13 ${e.href ? "" : "cursor-not-allowed opacity-50"} ${active ? "font-medium text-gx-text-primary" : "text-gx-text-primary"}`}
      >
        {e.name}
      </button>
      {menu && menu.length > 0 ? <RowMoreMenu items={menu} label={menuLabel ?? "行操作"} /> : null}
    </div>
  );
}

/** 三视角条目按类型分组（顺序 table → doc → canvas）。 */
export function groupByKind(entries: SecondaryEntry[]): Record<SectionKind, SecondaryEntry[]> {
  return {
    table: entries.filter((e) => e.kind === "table"),
    doc: entries.filter((e) => e.kind === "doc"),
    canvas: entries.filter((e) => e.kind === "canvas"),
  };
}

/** 空态文案：按当前 fragments（类型 + 是否有搜索词）给具体说法，不写泛泛的「暂无数据」。 */
export function secondaryEmptyText(kind: SectionKind, query: string): string {
  if (query.trim()) return "没有匹配的内容";
  return kind === "table" ? "该数据库还没有数据表" : kind === "doc" ? "还没有文档" : "还没有画布";
}
