// M3/S8 一级导航（S9 叠加二级三分区，S10 菜单窗口化）：渲染 menu 树（容器 + 活 shortcut），
// 点击解析实体跳到既有内容 URL。soft_dangling 全员隐藏，broken 浏览态隐藏（编排态才显灰）。
// S10：容器折叠态 + 树扁平化后用定高行窗口化，1000+ 菜单项只挂载视口附近 DOM（不引新依赖）。
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spinner } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
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
 * 一级导航。浏览态：只显示活 shortcut；点击容器名打开二级三分区。
 * 大菜单窗口化：容器默认展开，可折叠；平铺为定高行后只渲染视口窗口。
 */
export function PrimaryNav({ onOpenSecondary }: { onOpenSecondary?: (container: MenuTreeNode) => void }) {
  const { menu, isLoading, isError } = useNavMenu();
  const { index } = useNavNodeIndex();
  const navigate = useNavigate();
  const { baseId, tableId, kbId, docId } = useParams();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildMenuTree(filterBrowsableItems(menu?.items ?? [])), [menu?.items]);

  // 当前内容资源：表页取 table 节点，文档/画布取 doc 节点，库首页取 base/kb 节点。
  const currentResource = tableId ?? docId ?? baseId ?? kbId ?? null;
  const activeItems = useMemo(
    () => new Set(findActiveShortcuts(menu, currentResource).map((i) => i.id)),
    [menu, currentResource],
  );

  // 深度优先摊平（折叠容器不摊子行）；空容器（过滤后无活子项）在组树阶段已剔除。
  const rows = useMemo(
    () => flattenMenuRows(tree, (id) => !collapsed.has(id)),
    [tree, collapsed],
  );

  const virt = useMenuVirtualizer<FlatMenuRow>(rows, NAV_ROW_H);

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  if (isError) {
    return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">导航加载失败，刷新重试</div>;
  }
  if (tree.length === 0) {
    return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">暂无导航项</div>;
  }

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

  return (
    <div ref={virt.scrollerRef} className="h-full overflow-y-auto">
      <nav className="flex flex-col gap-0.5 px-1.5 py-2" style={{ paddingTop: virt.padTop, paddingBottom: virt.padBottom }}>
        {virt.windowed.map((row) => (
          <NavRow
            key={row.node.item.id}
            row={row}
            active={activeItems.has(row.node.item.id)}
            collapsed={collapsed.has(row.node.item.id)}
            onToggle={toggle}
            onNavigate={navigate}
            onLocate={locate}
            onOpenSecondary={onOpenSecondary}
            nodeIndex={index}
          />
        ))}
      </nav>
    </div>
  );
}

function NavRow({
  row,
  active,
  collapsed,
  onToggle,
  onNavigate,
  onLocate,
  onOpenSecondary,
  nodeIndex,
}: {
  row: FlatMenuRow;
  active: boolean;
  collapsed: boolean;
  onToggle: (id: string) => void;
  onNavigate: (href: string) => void;
  onLocate: (parentMenuId: string | null) => void;
  onOpenSecondary?: (container: MenuTreeNode) => void;
  nodeIndex: ReturnType<typeof useNavNodeIndex>["index"];
}) {
  const { node, depth } = row;
  const { item } = node;

  if (item.type === "container") {
    const icon: IconName = (item.iconName as IconName | null) ?? "folder";
    return (
      <div className="group flex w-full items-center gap-1 py-1" style={{ height: NAV_ROW_H, paddingLeft: 8 + depth * 14 }}>
        <button
          type="button"
          onClick={() => onToggle(item.id)}
          className="rounded p-0.5 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
          aria-label={collapsed ? "展开" : "折叠"}
          aria-expanded={!collapsed}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
        </button>
        <button
          type="button"
          onClick={() => onOpenSecondary?.(node)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title="打开二级导航"
        >
          <Icon name={icon} size={14} className="shrink-0 text-gx-text-tertiary" />
          <span className="flex-1 truncate text-gx-12 font-medium text-gx-text-secondary group-hover:text-gx-text-primary">
            {item.label ?? "未命名分组"}
          </span>
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
      title={item.label ? summary.name : undefined}
      onClick={() => {
        if (!href) return;
        onNavigate(href);
        onLocate(item.parentId);
      }}
      style={{ height: NAV_ROW_H, paddingLeft: 8 + depth * 14 }}
      className={[
        "relative flex w-full items-center gap-2 rounded-gx-sm py-1.5 pr-2 text-left text-gx-13 transition-colors",
        active ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
        href ? "" : "cursor-not-allowed opacity-50",
      ].join(" ")}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r bg-gx-accent" />}
      <Icon name={icon} size={14} className="shrink-0 opacity-80" />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}
