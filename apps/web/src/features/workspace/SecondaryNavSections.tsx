// M3/S9 二级导航分区：table/doc/canvas 三段，doc 段支持按权威 parentId 树展开。
// S10：三段合并为一条定高行序列（段头同样定高）交由 SecondaryNav 单窗口切片，大表列表（上千行）只挂载视口附近 DOM。
// 第三批：L2 语义从「收纳/未收纳」改为「选中容器的子项」——「已收纳处数 / shortcuts / 收纳到导航」已不存在。
import { useRef, useState } from "react";
import { Icon, type IconName } from "../../components/icons";
import { Menu, MenuItem, Popover } from "../../components/ui";
import { resolveEntityIcon, resolvedEntityColor, type EntityIconValue } from "../../components/EntityIconPicker";
import { navKindIcon } from "./PrimaryNav";

/** 二级行固定行高（含段头；py-1.5 + 13px 内容 ≈ 31），窗口化按此映射滚动位置。 */
export const SECONDARY_ROW_H = 31;

export type SectionKind = "table" | "doc" | "canvas";

/** 二级列表条目：与数据源解耦的最小形态；icon/iconColor 沿用实体自定义图标口径（EntityIconValue）。 */
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
  | { type: "entry"; kind: SectionKind; entry: SecondaryEntry; depth: number; hasDocKids: boolean; expanded: boolean };

/** 三段合并为一条定高行序列（空段不产段头）；doc 段按 expandedDocs 深度优先摊平并带出 depth。
 *  纯函数：总行数在此一次确定，组件再用 virtualWindow 切片，DOM 不随总量线性膨胀。 */
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
 * 行尾「竖向三点」操作菜单（R-N-11/12）。L1 库条目与 L2 表行共用同一组件，交互必须一致。
 *
 * 四条护栏全部成立，缺一即视为不合格：
 *   ① 占位常驻 20×20（span h-5 w-5），显隐不改行宽行高；
 *   ② 菜单打开期间强制可见（data-open="true" → CSS 强制 opacity 1）；
 *   ③ 触屏（`@media (hover: none)`）常驻可见 —— 由 index.css 的媒体查询兜；
 *   ④ 键盘 focus-within / focus-visible 可见 —— 同上。
 * 默认隐藏与 hover 显现同样由 `.gx-row-more`（index.css）统一承载，避免各调用点各写一半。
 * P3-a11y：`label` 让调用点给出「表操作菜单」这类具体名称（不传回落「行操作」），键盘 Tab 到此按钮时读屏要念出它管哪一行。
 *
 * 展开方式（hover 优先，click 保留）：
 *   · 移入 20×20 触发区 120ms 后展开，移出按钮或弹层 180ms 后收起 —— 防抖是必要的：没有它鼠标扫过
 *     菜单列会拖出一串弹窗，按钮与弹层之间 4px 间隙也会让弹层半路收起。
 *   · 弹层 portal 到 body，不在按钮 DOM 子树里：「是否还在本组件内」须 wrapRef + panelRef 一起
 *     contains 判定（鼠标去向命中任一侧都不算离开）。
 *   · src 记录展开来源：click 打开是「钉住」态，鼠标移出不收起；hover 打开时点按钮即收起。触屏无真
 *     hover，tap 合成的 mouseover 排下的展开会被 click 清定时器掐掉，故触屏仍是纯 click 路径。
 *   · 不用 CSS :hover 展开 —— 那会把触屏（无 hover）与键盘（focus ≠ hover）一起带坏。
 */
const HOVER_IN_MS = 120; // hover 进入防抖；离开 180ms（够鼠标穿过按钮与弹层间的 4px 间隙）
const HOVER_OUT_MS = 180;

export function RowMoreMenu({ items, label = "行操作" }: { items: RowMoreItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  /** 展开来源：hover 态随鼠标移出收起；click 态「钉住」，只由再点 / 点外部 / Esc 收起。 */
  const [src, setSrc] = useState<"hover" | "click" | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const set = (next: boolean, by: "hover" | "click" | null, delay = 0) => { // 开合唯一出口：先掐在途定时器
    clearTimeout(timer.current ?? undefined);
    if (delay) {
      timer.current = window.setTimeout(() => set(next, by), delay);
      return;
    }
    timer.current = null;
    setSrc(by);
    setOpen(next);
  };
  /** 弹层是 portal 的 fixed 元素，不在按钮子树里：两侧任一命中都算「还在本组件内」。 */
  const inside = (n: Node | null) => !!n && (!!wrapRef.current?.contains(n) || !!panelRef.current?.contains(n));
  if (items.length === 0) return <span aria-hidden className="h-5 w-5 shrink-0" />;
  const enter = () => (open ? clearTimeout(timer.current ?? undefined) : set(true, "hover", HOVER_IN_MS));
  const leave = (e: { relatedTarget: EventTarget | null }) => {
    if (inside(e.relatedTarget as Node | null)) return; // 按钮 ↔ 弹层之间移动不算离开
    if (open && src === "hover") return set(false, null, HOVER_OUT_MS);
    clearTimeout(timer.current ?? undefined); // 尚未展开：取消排队中的进入延时
  };
  return (
    <span
      ref={wrapRef}
      className="gx-row-more flex h-5 w-5 shrink-0 items-center justify-center"
      data-open={open ? "true" : "false"}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => set(!open, open ? null : "click")}
        className="relative flex h-5 w-5 items-center justify-center rounded-gx-sm text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary after:absolute after:-inset-1.5 after:content-['']"
      >
        <Icon name="moreVertical" size={14} />
      </button>
      {open && (
        // fixed：二级列表是滚动容器（overflow-y-auto），absolute 弹层会被裁掉，故 portal 到 body
        <Popover open onClose={() => set(false, null)} align="right" width={168} fixed anchorEl={btnRef.current}>
          <div ref={panelRef} onMouseEnter={enter} onMouseLeave={leave}>
            <Menu width={168}>
              {items.map((it) => (
                <MenuItem
                  key={it.label}
                  icon={it.icon}
                  label={it.label}
                  description={it.description}
                  danger={it.danger}
                  onClick={() => {
                    set(false, null);
                    it.onClick();
                  }}
                />
              ))}
            </Menu>
          </div>
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

/** 文档行的拖拽状态（KB 文档改层级）。画布行不参与——服务端 moveDoc 的层级语义只用在文档树上。 */
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
 * 二级实体行（第三批）：点整行进对应的表 / 文档 / 画布。行尾三点菜单按行类型回挂：
 * 表行 → 重命名 / 编辑表单 / 复制表×2 / 清空数据 / 删除表（见 SecondaryNavTableOps）；文档行 → 拖拽
 * 改层级（见 SecondaryNavKbOps），菜单不挂（后端无文档级其它行操作）。菜单由调用点给出，不给不渲染。
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
  // R-N-10 选中态：白底 + 圆角 8 + accent 字 600；落点态与选中态互斥取一（两个 bg-* 同权重会互相覆盖）。
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
