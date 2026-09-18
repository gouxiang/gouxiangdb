// M3/S8 一级导航（S9 叠加二级三分区，S10 菜单窗口化）：渲染 menu 树（容器 + 活 shortcut），
// 点击解析实体跳到既有内容 URL。soft_dangling 全员隐藏，broken 浏览态隐藏（编排态才显灰）。
// S10：容器折叠态 + 树扁平化后用定高行窗口化，1000+ 菜单项只挂载视口附近 DOM（不引新依赖）。
//
// 阶段 1 壳层重构（UI-SPEC）：
//   R-N-07/09 — L1 支持 56px 图标折叠档；选中态 = 白底卡片 + 圆角 8 + accent 字 600，
//               明确禁止左侧色条（原 3px bg-gx-accent 竖条已删）。
//   R-N-17   — L1 上区「个人门户」是规划入口：保留位置 + 「规划中」徽标 + 点击有明确反馈。
import { useMemo, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { Spinner, toast } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";
import type { MenuNodeSummaryDTO } from "@gx/shared-types";
import { useNavMenu, useNavNodeIndex } from "./nav-hooks";
import {
  buildMenuTree,
  filterBrowsableItems,
  findActiveShortcuts,
  flattenMenuRows,
  type FlatMenuRow,
  type MenuTreeNode,
} from "./lib/menu-tree";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";
import { navNodeHref } from "./lib/nav-links";

/** 浏览态一级行固定行高（py-1.5 + 14px 内容 ≈ 32），窗口化按此映射滚动位置。 */
const NAV_ROW_H = 32;

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
 * R-N-09 选中态：白底 + 圆角 8 + accent 字 + 600。
 * 未选中：透明底 + hover 换 gx-row-hover（#F1F5FB）。左侧色条是规范明令的反例，已移除。
 */
export const L1_ROW_SELECTED = "bg-white font-semibold text-gx-accent";
export const L1_ROW_IDLE = "text-gx-text-primary hover:bg-gx-row-hover";

/**
 * L1 上区「个人门户」（UI-SPEC §1.1 / R-N-17）：规范列为 L1 上区首项，本期仅预留位置，
 * 不接业务。挂「规划中」徽标，点击 toast 明说，不做静默失败。
 */
function PlannedPortalRow({ collapsed }: { collapsed?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => toast(plannedHint("个人门户"), "info")}
      title="个人门户 · 规划中，尚未开放"
      aria-disabled="true"
      className={[
        "mx-1.5 mt-2 flex shrink-0 items-center rounded-gx-lg text-gx-13 transition-colors",
        collapsed ? "h-8 justify-center px-0" : "h-8 gap-2 px-2",
        L1_ROW_IDLE,
      ].join(" ")}
    >
      <Icon name="user" size={14} className="shrink-0 opacity-80" />
      {collapsed ? null : (
        <>
          <span className="flex-1 truncate text-left">个人门户</span>
          <PlannedBadge />
        </>
      )}
    </button>
  );
}

/**
 * 一级导航。浏览态：只显示活 shortcut；点击容器名打开二级三分区。
 * 大菜单窗口化：容器默认展开，可折叠；平铺为定高行后只渲染视口窗口。
 */
export function PrimaryNav({
  onOpenSecondary,
  collapsed = false,
  activeContainerId = null,
}: {
  onOpenSecondary?: (container: MenuTreeNode) => void;
  /** R-N-07 折叠档（56px）：只留图标 + title tooltip。 */
  collapsed?: boolean;
  /** 当前 L2 展开的容器 id：容器行据此落到 R-N-09 选中态。 */
  activeContainerId?: string | null;
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
  const [collapsedIds, setCollapsed] = useState<Set<string>>(new Set());

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

  // 深度优先摊平（折叠容器不摊子行）；空容器（过滤后无活子项）在组树阶段已剔除。
  const rows = useMemo(
    () => flattenMenuRows(tree, (id) => !collapsedIds.has(id)),
    [tree, collapsedIds],
  );

  const virt = useMenuVirtualizer<FlatMenuRow>(rows, NAV_ROW_H);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const locate = (parentMenuId: string | null) => {
    if (!parentMenuId) return;
    const found = menu?.items.find((i) => i.id === parentMenuId);
    if (found) onOpenSecondary?.({ item: found, children: [] } as MenuTreeNode);
  };

  // 折叠档下容器展开箭头失去意义（只留图标），摊平时按「全部展开」取行，避免折叠态无行可点。
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
        <nav
          className="flex flex-col gap-0.5 px-1.5 py-2"
          style={{ paddingTop: virt.padTop, paddingBottom: virt.padBottom }}
        >
          {virt.windowed.map((row) => (
            <NavRow
              key={row.node.item.id}
              row={row}
              active={activeItems.has(row.node.item.id)}
              collapsed={collapsedIds.has(row.node.item.id)}
              iconOnly={collapsed}
              onToggle={toggle}
              onNavigate={navigate}
              onLocate={locate}
              onOpenSecondary={onOpenSecondary}
              nodeIndex={index}
              containerActive={row.node.item.type === "container" && activeContainerId === row.node.item.id}
            />
          ))}
        </nav>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PlannedPortalRow collapsed={collapsed} />
      {body()}
    </div>
  );
}

function NavRow({
  row,
  active,
  collapsed,
  iconOnly,
  onToggle,
  onNavigate,
  onLocate,
  onOpenSecondary,
  nodeIndex,
  containerActive,
}: {
  row: FlatMenuRow;
  active: boolean;
  collapsed: boolean;
  iconOnly?: boolean;
  onToggle: (id: string) => void;
  onNavigate: (href: string) => void;
  onLocate: (parentMenuId: string | null) => void;
  onOpenSecondary?: (container: MenuTreeNode) => void;
  nodeIndex: ReturnType<typeof useNavNodeIndex>["index"];
  containerActive?: boolean;
}) {
  const { node, depth } = row;
  const { item } = node;

  if (item.type === "container") {
    const icon: IconName = (item.iconName as IconName | null) ?? "folder";
    const label = item.label ?? "未命名分组";
    return (
      <div
        className={[
          "group flex w-full items-center rounded-gx-lg py-1 pr-1 transition-colors",
          containerActive ? L1_ROW_SELECTED : L1_ROW_IDLE,
          iconOnly ? "justify-center" : "gap-1",
        ].join(" ")}
        style={{ height: NAV_ROW_H, paddingLeft: iconOnly ? 0 : 8 + depth * 14 }}
      >
        {iconOnly ? null : (
          <button
            type="button"
            onClick={() => onToggle(item.id)}
            className="rounded p-0.5 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
            aria-label={collapsed ? "展开" : "折叠"}
            aria-expanded={!collapsed}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
          </button>
        )}
        <button
          type="button"
          title={iconOnly ? label : "打开二级导航"}
          onClick={() => onOpenSecondary?.(node)}
          className={[
            "flex min-w-0 items-center text-left",
            iconOnly ? "justify-center" : "flex-1 gap-1.5",
          ].join(" ")}
        >
          <Icon
            name={icon}
            size={14}
            className={`shrink-0 ${containerActive ? "text-gx-accent" : "text-gx-text-tertiary"}`}
          />
          {iconOnly ? null : (
            <span
              className={[
                "flex-1 truncate text-gx-12 font-medium",
                containerActive ? "text-gx-accent" : "text-gx-text-secondary group-hover:text-gx-text-primary",
              ].join(" ")}
            >
              {label}
            </span>
          )}
        </button>
      </div>
    );
  }

  // shortcut：浏览态只渲染活项（父级过滤已保证），解析 href
  const summary = item.node;
  if (!summary || summary.state !== "alive") return null;
  const navNode = summary.id ? nodeIndex.byId.get(item.nodeId ?? "") : undefined;
  const href = navNode ? navNodeHref(nodeIndex, navNode) : null;
  const icon: IconName = (item.iconName as IconName | null) ?? navKindIcon(summary.kind);
  const label = item.label ?? summary.name;

  return (
    <button
      type="button"
      disabled={!href}
      title={iconOnly ? label : item.label ? summary.name : undefined}
      onClick={() => {
        if (!href) return;
        onNavigate(href);
        onLocate(item.parentId);
      }}
      style={{ height: NAV_ROW_H, paddingLeft: iconOnly ? 0 : 8 + depth * 14 }}
      className={[
        "flex w-full items-center rounded-gx-lg py-1.5 text-left text-gx-13 transition-colors",
        iconOnly ? "justify-center" : "gap-2 pr-2",
        active ? L1_ROW_SELECTED : L1_ROW_IDLE,
        href ? "" : "cursor-not-allowed opacity-50",
      ].join(" ")}
    >
      <Icon name={icon} size={14} className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`} />
      {iconOnly ? null : <span className="flex-1 truncate">{label}</span>}
    </button>
  );
}
