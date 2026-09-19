// M3/S8 一级导航（S9 叠加二级三分区，S10 菜单窗口化）：渲染 menu 树（容器 + 活 shortcut），
// 点击解析实体跳到既有内容 URL。soft_dangling 全员隐藏，broken 浏览态隐藏（编排态才显灰）。
// S10：树扁平化后用定高行窗口化，1000+ 菜单项只挂载视口附近 DOM（不引新依赖）。
//
// 阶段 1 壳层重构（UI-SPEC）：
//   R-N-07/09 — L1 支持 56px 图标折叠档；选中态 = 白底卡片 + 圆角 8 + accent 字 600，
//               明确禁止左侧色条（原 3px bg-gx-accent 竖条已删）。
//   R-N-17   — 个人区入口是规划入口：保留位置 + 「规划中」徽标 + 点击有明确反馈。
//
// 阶段 6 菜单精细化（参考图对齐，配色与视觉风格不变）：
//   R-N-20 取消手风琴：container 一律降级为**分组标题行**（11px hint、独立行、不缩进），
//          其 shortcut 子项**平铺**在下方，直接可见，无展开/收起交互。
//   R-N-21 深层侧方浮出：container 下还有 container 时不再就地缩进展开，改为 hover /
//          键盘聚焦时向侧方浮出独立子菜单面板（贴边自动翻转、Esc 关闭、150ms 移入间隙）。
//   R-N-22 节奏统一：菜单项行 32 / 分组标题行 24 / 图标 14 / 文字 13 / 圆角 8 /
//          图标与文字 gap-8 / 行内左右 padding 8；hover 与浮出统一 150ms ease-out。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { Spinner, toast } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { resolveEntityIcon, resolvedEntityColor, type EntityIconIndex, type EntityIconValue } from "../../components/EntityIconPicker";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";
import type { MenuItemDTO, MenuNodeSummaryDTO } from "@gx/shared-types";
import { useNavMenu, useNavNodeIndex } from "./nav-hooks";
import { buildMenuTree, filterBrowsableItems, findActiveShortcuts, type MenuTreeNode } from "./lib/menu-tree";
import {
  buildFlyoutRows,
  flattenMenuSections,
  navRowHeights,
  NAV_GROUP_ROW_H,
  NAV_ITEM_ROW_H,
  NAV_ROW_GAP,
  type FlyoutRow,
  type NavSectionRow,
} from "./lib/menu-sections";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";
import { navNodeHref, type NodeIndex } from "./lib/nav-links";

/** 浏览态一级行固定行高 32（窗口化与视觉节奏的同一真源，见 lib/menu-sections）。 */
export const NAV_ROW_H = NAV_ITEM_ROW_H;

/** 全站菜单行过渡：150ms ease-out（与浮出面板入场同一时长与缓动）。 */
export const NAV_ROW_TRANSITION = "transition-colors duration-150 ease-out";

/** 浮出面板几何：宽 200、与触发行留 8px 缝、每行 28。 */
export const FLYOUT_PANEL_W = 200;
export const FLYOUT_GAP = 8;
export const FLYOUT_ROW_H = 28;
/** 移出触发行/面板后的关闭延时：留 150ms 移入间隙，防止鼠标斜穿时误关。 */
export const FLYOUT_CLOSE_DELAY_MS = 150;

/** 拼类名并过滤空片段（避免条件片段留双空格）。 */
const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** shortcut 实体类型 → 默认图标（iconName 白名单优先，null 时回退类型图标）。 */
export function navKindIcon(kind: MenuNodeSummaryDTO["kind"]): IconName {
  switch (kind) {
    case "base":
      return "database";
    case "kb":
      return "book";
    case "table":
      return "table";
    case "doc":
      return "doc";
    case "canvas":
      return "canvas";
    case "view":
      return "grid";
    case "group":
      return "group";
    default:
      return "link";
  }
}

/**
 * 容器图标：iconName 白名单 → 挂载实体的自定义图标 → nodeId 指向的实体类型图标 → folder。
 * 修掉原来「所有容器一律 folder」的语义错配：挂 base 的容器显示 database、挂 kb 显示 book。
 *
 * entityIcons：母实体（base/kb）的图标索引，由壳层按下述来源装配后传入——
 * 本组件不直接 useBases/useKbList，是因为一级导航在多份 SSR 回归里不带 QueryClientProvider。
 * 未自定义（icon 为 null）时走 navKindIcon 原路径，渲染与改动前一致。
 */
export function containerIcon(
  item: MenuItemDTO,
  index: NodeIndex,
  entityIcons?: EntityIconIndex,
): IconName {
  const explicit = item.iconName as IconName | null;
  if (explicit) return explicit;
  const node = item.nodeId ? index.byId.get(item.nodeId) : undefined;
  if (!node) return "folder";
  const kindIcon = navKindIcon(node.kind as MenuNodeSummaryDTO["kind"]);
  const entity = containerEntity(item, index, entityIcons);
  return entity ? resolveEntityIcon(entity, { name: kindIcon }).name : kindIcon;
}

/** 容器挂载到的母实体（base/kb）图标索引项；取不到返回 null。 */
export function containerEntity(
  item: MenuItemDTO,
  index: NodeIndex,
  entityIcons?: EntityIconIndex,
): EntityIconValue | null {
  const node = item.nodeId ? index.byId.get(item.nodeId) : undefined;
  if (!node?.resourceId) return null;
  return entityIcons?.get(node.resourceId) ?? null;
}

/**
 * R-N-09 选中态：白底 + 圆角 8 + accent 字 + 600。
 * 未选中：透明底 + hover 换 gx-row-hover（#F1F5FB）。左侧色条是规范明令的反例，已移除。
 */
export const L1_ROW_SELECTED = "bg-white font-semibold text-gx-accent";
export const L1_ROW_IDLE = "text-gx-text-primary hover:bg-gx-row-hover";

/** 菜单项行外壳（节奏统一：高 32 / 圆角 8 / 左右 padding 8 / gap 8 / 150ms ease-out）。 */
const ITEM_SHELL = `flex h-8 w-full items-center gap-2 rounded-gx-lg px-2 text-gx-13 ${NAV_ROW_TRANSITION}`;

/**
 * L1 顶部「个人用户」分组（UI-SPEC §1.1 / R-N-17 / D-11）：
 * 三项规划入口平铺在分组标题下，行规格与其它菜单项完全一致（不置灰），
 * 行尾挂「规划中」徽标，点击 toast 明说，不做静默失败。
 */
const PERSONAL_PLANNED: readonly { id: string; label: string; icon: IconName; hint: string }[] = [
  { id: "portal", label: "个人门户", icon: "user", hint: plannedHint("个人门户") },
  { id: "home", label: "工作台首页", icon: "home", hint: plannedHint("工作台首页") },
  { id: "todo", label: "我的待办", icon: "checkSquare", hint: plannedHint("我的待办") },
  { id: "favorites", label: "我的收藏", icon: "star", hint: plannedHint("我的收藏") },
];

function PlannedPersonalRow({
  label,
  icon,
  hint,
  collapsed,
}: {
  label: string;
  icon: IconName;
  hint: string;
  collapsed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => toast(hint, "info")}
      title={hint}
      aria-disabled="true"
      className={cx(ITEM_SHELL, L1_ROW_IDLE, collapsed && "justify-center px-0")}
      data-nav-row="planned"
    >
      <Icon name={icon} size={14} className="shrink-0 opacity-80" />
      {collapsed ? null : (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          <PlannedBadge />
        </>
      )}
    </button>
  );
}

/**
 * 分组标题行：小字、hint 色、独立行、不缩进。
 * 传 onOpen 时可点（只开二级面板，不做路由跳转，保住原来「点容器名开 L2」的能力）；
 * 不传则渲染为纯标签（如顶部「个人用户」——它不是导航入口，不做成假入口）。
 */
function GroupHeaderRow({
  label,
  active,
  iconOnly,
  onOpen,
}: {
  label: string;
  active: boolean;
  iconOnly: boolean;
  onOpen?: () => void;
}) {
  if (iconOnly) return null;
  const cls = [
    "flex w-full items-center rounded-gx-lg px-2 text-gx-11 font-medium",
    NAV_ROW_TRANSITION,
    active ? "text-gx-accent" : "text-gx-text-hint",
    onOpen ? "hover:text-gx-text-secondary" : "cursor-default",
  ].join(" ");
  const style = { height: NAV_GROUP_ROW_H, marginBottom: NAV_ROW_GAP };
  if (!onOpen) {
    return (
      <div data-nav-row="group" className={cls} style={style}>
        <span className="truncate">{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`打开「${label}」二级导航`}
      aria-label={`打开「${label}」二级导航`}
      data-nav-row="group"
      className={cls}
      style={style}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * 一级导航。浏览态：只显示活 shortcut；container 降级为分组标题，子项平铺。
 * 大菜单窗口化：摊平为定高行后只渲染视口窗口（分组标题行更矮，故走变高切片）。
 */
export function PrimaryNav({
  onOpenSecondary,
  collapsed = false,
  activeContainerId = null,
  entityIcons,
  header,
}: {
  onOpenSecondary?: (container: MenuTreeNode) => void;
  /** R-N-07 折叠档（56px）：只留图标 + title tooltip。 */
  collapsed?: boolean;
  /** 当前 L2 展开的容器 id：分组标题行据此落到选中色。 */
  activeContainerId?: string | null;
  /** base/kb 实体自定义图标索引（按 node.resourceId 查）；不传则容器行退回实体类型图标。 */
  entityIcons?: EntityIconIndex;
  /**
   * 顶部插槽（库切换器 + 新建入口）：由壳层传入。
   * 本组件不直接 useBases/useKbList —— 多份 SSR 回归不带 QueryClientProvider，
   * 需要 QueryClient 的区块一律经这个插槽从壳层进来，不传时渲染与改动前完全一致。
   */
  header?: ReactNode;
}) {
  const { menu, isLoading, isError } = useNavMenu();
  const { index } = useNavNodeIndex();
  const navigate = useNavigate();
  // 当前资源一律用 useMatch 对 pathname 取参，不用 useParams：本组件挂在【无 path 的
  // 壳层布局路由】下，useParams 取到的是该布局路由自身的 params（恒为 {}），
  // L1 选中态因此在真实应用里永远不亮。useMatch 与路由层级无关，刷新/直访同样成立。
  const tableMatch = useMatch("/base/:baseId/table/:tableId/*");
  const docMatch = useMatch("/kb/:kbId/doc/:docId");
  const canvasMatch = useMatch("/kb/:kbId/canvas/:docId");
  const baseMatch = useMatch("/base/:baseId");
  const kbMatch = useMatch("/kb/:kbId");

  const tree = useMemo(() => buildMenuTree(filterBrowsableItems(menu?.items ?? [])), [menu?.items]);

  // 当前内容资源：表页取 table 节点，文档/画布取 doc 节点，库首页取 base/kb 节点。
  const currentResource =
    tableMatch?.params.tableId ??
    docMatch?.params.docId ??
    canvasMatch?.params.docId ??
    baseMatch?.params.baseId ??
    kbMatch?.params.kbId ??
    null;
  const activeItems = useMemo(
    () => new Set(findActiveShortcuts(menu, currentResource).map((i) => i.id)),
    [menu, currentResource],
  );

  // R-N-20：两层摊平（分组标题 + 平铺子项），无折叠态。折叠档只留图标，标题行不再有意义。
  const rows = useMemo(() => {
    const all = flattenMenuSections(tree);
    return collapsed ? all.filter((r) => r.kind !== "group") : all;
  }, [tree, collapsed]);
  const heights = useMemo(() => navRowHeights(rows), [rows]);

  const virt = useMenuVirtualizer<NavSectionRow>(rows, NAV_ITEM_ROW_H + NAV_ROW_GAP, 12, heights);

  const locate = (parentMenuId: string | null) => {
    if (!parentMenuId) return;
    const found = menu?.items.find((i) => i.id === parentMenuId);
    if (found) onOpenSecondary?.({ item: found, children: [] } as MenuTreeNode);
  };

  const body = () => {
    if (isLoading) {
      return (
        <div className="flex h-32 items-center justify-center">
          <Spinner size={18} />
        </div>
      );
    }
    if (isError) {
      return (
        <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">
          {collapsed ? "!" : "导航加载失败，刷新重试"}
        </div>
      );
    }
    if (tree.length === 0) {
      return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">{collapsed ? "" : "暂无导航项"}</div>;
    }
    return (
      <div ref={virt.scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        {/*
          无 gap：行距由每行自己的 marginBottom 承担，窗口化的 padTop/padBottom 才能逐像素对齐。
          窗口占位之外再各加 8px 呼吸（写在 style 里而非 py-2：内联 padding 会覆盖 Tailwind 类）。
        */}
        <nav
          className="flex flex-col px-1.5"
          style={{ paddingTop: virt.padTop + 8, paddingBottom: virt.padBottom + 8 }}
        >
          {virt.windowed.map((row) => (
            <NavRow
              key={row.id}
              row={row}
              active={activeItems.has(row.node.item.id)}
              iconOnly={collapsed}
              onNavigate={navigate}
              onLocate={locate}
              onOpenSecondary={onOpenSecondary}
              nodeIndex={index}
              entityIcons={entityIcons}
              containerActive={row.node.item.type === "container" && activeContainerId === row.node.item.id}
            />
          ))}
        </nav>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 库区块插槽（切换器 + 新建入口）：常驻顶部，不随菜单滚动 */}
      {header ? <div className="shrink-0 px-1.5 pt-2">{header}</div> : null}
      {/* 个人区分组：规划入口常驻顶部，不随菜单滚动（与参考图「个人用户」段一致） */}
      <div className="shrink-0 px-1.5 pt-2">
        <GroupHeaderRow label="个人用户" active={false} iconOnly={collapsed} />
        {PERSONAL_PLANNED.map((p) => (
          <div key={p.id} style={{ marginBottom: NAV_ROW_GAP }}>
            <PlannedPersonalRow label={p.label} icon={p.icon} hint={p.hint} collapsed={collapsed} />
          </div>
        ))}
      </div>
      {body()}
    </div>
  );
}

function NavRow({
  row,
  active,
  iconOnly,
  onNavigate,
  onLocate,
  onOpenSecondary,
  nodeIndex,
  entityIcons,
  containerActive,
}: {
  row: NavSectionRow;
  active: boolean;
  iconOnly?: boolean;
  onNavigate: (href: string) => void;
  onLocate: (parentMenuId: string | null) => void;
  onOpenSecondary?: (container: MenuTreeNode) => void;
  nodeIndex: NodeIndex;
  entityIcons?: EntityIconIndex;
  containerActive?: boolean;
}) {
  const { node } = row;

  if (row.kind === "group") {
    const label = node.item.label ?? "未命名分组";
    return (
      <GroupHeaderRow
        label={label}
        active={!!containerActive}
        iconOnly={!!iconOnly}
        onOpen={() => onOpenSecondary?.(node)}
      />
    );
  }

  // container（含子项为空、无浮出的情形）：不再就地展开，子项由侧方浮出面板承载。
  if (node.item.type === "container") {
    return (
      <NestedContainerRow
        node={node}
        nested={row.nested}
        active={active}
        iconOnly={iconOnly}
        onNavigate={onNavigate}
        onLocate={onLocate}
        onOpenSecondary={onOpenSecondary}
        nodeIndex={nodeIndex}
        entityIcons={entityIcons}
      />
    );
  }

  // shortcut：浏览态只渲染活项（父级过滤已保证），解析 href
  const summary = node.item.node;
  if (!summary || summary.state !== "alive") return null;
  const navNode = summary.id ? nodeIndex.byId.get(node.item.nodeId ?? "") : undefined;
  const href = navNode ? navNodeHref(nodeIndex, navNode) : null;
  const icon: IconName =
    (node.item.iconName as IconName | null) ?? (summary.iconName as IconName | null) ?? navKindIcon(summary.kind);
  const label = node.item.label ?? summary.name;

  return (
    <div style={{ marginBottom: NAV_ROW_GAP }}>
      <button
        type="button"
        disabled={!href}
        title={iconOnly ? label : node.item.label ? summary.name : undefined}
        onClick={() => {
          if (!href) return;
          onNavigate(href);
          onLocate(node.item.parentId);
        }}
        data-nav-row="item"
        className={cx(
        ITEM_SHELL,
        iconOnly && "justify-center px-0",
        active ? L1_ROW_SELECTED : L1_ROW_IDLE,
        !href && "cursor-not-allowed opacity-50",
      )}
      >
        <Icon name={icon} size={14} className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`} />
        {iconOnly ? null : <span className="flex-1 truncate">{label}</span>}
      </button>
    </div>
  );
}

/**
 * R-N-21 侧方浮出面板。
 *
 * 定位：面板 `position: fixed` + 触发行 getBoundingClientRect 计算坐标——L1 菜单区是
 * `overflow-y-auto` 滚动容器，absolute 子层会被横向裁掉；fixed 不受祖先 overflow 裁剪
 * （且全站禁止给布局容器加 transform，故不会被改换包含块）。
 * 翻转：右侧放不下（触发行右沿 + 8 + 200 > 视口宽）就翻到左侧；左侧也放不下时仍取右侧。
 * 键盘：触发行 onFocus 打开（focus-within 等价），面板内可 Tab，Esc 关闭并把焦点还给触发行。
 * 关闭：移出触发行或面板后延时 150ms；滚动 / 视口变化时立即关（fixed 面板不跟随滚动）。
 */
function NestedContainerRow({
  node,
  nested,
  active,
  iconOnly,
  onNavigate,
  onLocate,
  onOpenSecondary,
  nodeIndex,
  entityIcons,
}: {
  node: MenuTreeNode;
  nested: readonly MenuTreeNode[];
  active: boolean;
  iconOnly?: boolean;
  onNavigate: (href: string) => void;
  onLocate: (parentMenuId: string | null) => void;
  onOpenSecondary?: (container: MenuTreeNode) => void;
  nodeIndex: NodeIndex;
  entityIcons?: EntityIconIndex;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"right" | "left">("right");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flyoutRows = useMemo(() => buildFlyoutRows(nested), [nested]);
  const label = node.item.label ?? "未命名分组";
  const icon: IconName = containerIcon(node.item, nodeIndex, entityIcons);
  // 只有母实体自定义了图标才带色（未自定义沿用行前景色 / accent，逐像素保持不变）
  const iconColor = resolvedEntityColor(containerEntity(node.item, nodeIndex, entityIcons));

  const clearTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeNow = () => {
    clearTimer();
    setOpen(false);
  };
  const scheduleClose = () => {
    clearTimer();
    closeTimer.current = setTimeout(() => setOpen(false), FLYOUT_CLOSE_DELAY_MS);
  };
  const openNow = () => {
    clearTimer();
    const el = wrapRef.current;
    if (el && typeof window !== "undefined") {
      const r = el.getBoundingClientRect();
      // 面板高按行数估算，仅用于把面板夹在视口内（真实高度由内容决定，无需精确）
      const estH = 8 + 24 + flyoutRows.length * FLYOUT_ROW_H;
      const fitsRight = r.right + FLYOUT_GAP + FLYOUT_PANEL_W <= window.innerWidth - 8;
      const fitsLeft = r.left - FLYOUT_GAP - FLYOUT_PANEL_W >= 8;
      const toRight = fitsRight || !fitsLeft;
      setSide(toRight ? "right" : "left");
      setPos({
        top: Math.max(8, Math.min(r.top, window.innerHeight - estH - 8)),
        left: toRight ? r.right + FLYOUT_GAP : r.left - FLYOUT_GAP - FLYOUT_PANEL_W,
      });
    }
    setOpen(true);
  };

  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => closeNow();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      ref={wrapRef}
      style={{ marginBottom: NAV_ROW_GAP }}
      data-flyout={open ? "open" : "closed"}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeNow();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        closeNow();
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        // 子节点为空的容器没有浮出内容：退化成「打开二级面板」的普通行，不放浮出标记
        aria-haspopup={nested.length > 0 ? "menu" : undefined}
        aria-expanded={nested.length > 0 ? open : undefined}
        onClick={nested.length > 0 ? undefined : () => onOpenSecondary?.(node)}
        title={iconOnly ? label : undefined}
        data-nav-row="item"
        className={cx(ITEM_SHELL, iconOnly && "justify-center px-0", active ? L1_ROW_SELECTED : L1_ROW_IDLE)}
      >
        <Icon
          name={icon}
          size={14}
          className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`}
          style={iconColor ? { color: iconColor } : undefined}
        />
        {iconOnly ? null : (
          <>
            <span className="flex-1 truncate text-left">{label}</span>
            {nested.length > 0 && (
              <Icon name="chevronRight" size={12} className="shrink-0 text-gx-text-hint" />
            )}
          </>
        )}
      </button>
      {open && (
        <FlyoutPanel
          label={label}
          rows={flyoutRows}
          side={side}
          pos={pos}
          nodeIndex={nodeIndex}
          entityIcons={entityIcons}
          onNavigate={onNavigate}
          onLocate={onLocate}
          onMouseEnter={clearTimer}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}

/** 浮出面板行内缩进档（0/1/2 → padding-left 8/24/40），与图标 14 + gap 8 对齐。 */
const FLYOUT_PAD: readonly string[] = ["px-2", "pl-6 pr-2", "pl-10 pr-2"];

/**
 * 侧方浮出面板本体（单独导出以便 SSR 断言「打开态渲染 / 关闭态不渲染」）。
 * 面板头（11px hint + 发丝线）→ 一级标题（13/600）→ 二级子项（12/400 + 缩进）。
 */
export function FlyoutPanel({
  label,
  rows,
  side = "right",
  pos = null,
  nodeIndex,
  entityIcons,
  onNavigate,
  onLocate,
  onMouseEnter,
  onMouseLeave,
}: {
  label: string;
  rows: readonly FlyoutRow[];
  side?: "right" | "left";
  pos?: { top: number; left: number } | null;
  nodeIndex: NodeIndex;
  entityIcons?: EntityIconIndex;
  onNavigate?: (href: string) => void;
  onLocate?: (parentMenuId: string | null) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const resolveHref = (item: MenuItemDTO): string | null => {
    const navNode = item.nodeId ? nodeIndex.byId.get(item.nodeId) : undefined;
    return navNode ? navNodeHref(nodeIndex, navNode) : null;
  };
  return (
    <div
      role="menu"
      aria-label={`${label} 子菜单`}
      data-flyout-panel={side}
      className={`fixed gx-z-popover rounded-gx-lg border border-gx-border bg-gx-surface p-1 shadow-gx-lg gx-flyout-in-${side}`}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: FLYOUT_PANEL_W }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="mb-1 flex h-6 items-center border-b border-gx-hairline px-2 text-gx-11 font-medium text-gx-text-hint">
        <span className="truncate">{label}</span>
      </div>
      {rows.map((r) => {
        const item = r.node.item;
        if (r.kind === "title") {
          const titleIcon = containerIcon(item, nodeIndex, entityIcons);
          const titleIconColor = resolvedEntityColor(containerEntity(item, nodeIndex, entityIcons));
          const title = item.label ?? "未命名分组";
          return (
            <div
              key={r.id}
              className={cx("flex items-center gap-2 text-gx-13 font-semibold text-gx-text-primary", FLYOUT_PAD[r.depth] ?? FLYOUT_PAD[0])}
              style={{ height: FLYOUT_ROW_H }}
            >
              <Icon
                name={titleIcon}
                size={14}
                className="shrink-0 opacity-80"
                style={titleIconColor ? { color: titleIconColor } : undefined}
              />
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </div>
          );
        }
        const summary = item.node;
        const href = resolveHref(item);
        const rowIcon: IconName =
          (item.iconName as IconName | null) ?? (summary?.iconName as IconName | null) ?? (summary ? navKindIcon(summary.kind) : "link");
        const rowLabel = item.label ?? summary?.name ?? "未命名";
        const alive = !!summary && summary.state === "alive";
        return (
          <button
            key={r.id}
            type="button"
            role="menuitem"
            disabled={!href || !alive}
            title={rowLabel}
            onClick={() => {
              if (!href) return;
              onNavigate?.(href);
              onLocate?.(item.parentId);
            }}
            className={[
              "flex w-full items-center gap-2 rounded-gx-lg text-gx-12 text-gx-text-secondary",
              NAV_ROW_TRANSITION,
              FLYOUT_PAD[r.depth] ?? FLYOUT_PAD[0],
              href && alive ? "hover:bg-gx-row-hover hover:text-gx-text-primary" : "cursor-not-allowed opacity-50",
            ].join(" ")}
            style={{ height: FLYOUT_ROW_H }}
          >
            <Icon name={rowIcon} size={14} className="shrink-0 opacity-80" />
            <span className="min-w-0 flex-1 truncate text-left">{rowLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
