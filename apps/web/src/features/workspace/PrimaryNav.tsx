// M3/S8 一级导航（只读骨架版）：渲染 menu 树（容器 + 活 shortcut），点击解析实体
// 跳到既有内容 URL。soft_dangling 全员隐藏，broken 浏览态隐藏（S9 编排态再显灰）。
// S9 在同组件叠加 NavComposer（增删改排/分组/拖拽）与二级三分区，本文件保持数据源单一。
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spinner } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import type { MenuNodeSummaryDTO } from "@gx/shared-types";
import { useNavMenu } from "./nav-hooks";
import { useNavNodeIndex } from "./nav-hooks";
import {
  buildMenuTree,
  filterBrowsableItems,
  findActiveShortcuts,
  isBrowsableShortcut,
  type MenuTreeNode,
} from "./lib/menu-tree";
import { navNodeHref } from "./lib/nav-links";

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

function ShortcutRow({ node, depth, active, onNavigate, onLocate }: {
  node: MenuTreeNode;
  depth: number;
  active: boolean;
  onNavigate: (href: string) => void;
  /** 点击后在二级栏定位其菜单父容器（UIUX :75）。 */
  onLocate?: (parentMenuId: string) => void;
}) {
  const { index } = useNavNodeIndex();
  const summary = node.item.node;
  if (!summary || summary.state !== "alive") return null;
  // 菜单摘要只带 resourceId/kind；需要 kb/base 祖先拼 URL 时用 tree 索引找节点。
  const navNode = summary.id ? index.byId.get(node.item.nodeId ?? "") : undefined;
  const href = navNode ? navNodeHref(index, navNode) : null;

  const icon: IconName = (node.item.iconName as IconName | null) ?? navKindIcon(summary.kind);
  const label = node.item.label ?? summary.name;

  return (
    <button
      type="button"
      disabled={!href}
      title={node.item.label ? summary.name : undefined}
      onClick={() => {
        if (!href) return;
        onNavigate(href);
        if (node.item.parentId) onLocate?.(node.item.parentId);
      }}
      style={{ paddingLeft: 8 + depth * 14 }}
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

function ContainerNode({ node, depth, activeIds, onNavigate, onLocate, onOpenSecondary }: {
  node: MenuTreeNode;
  depth: number;
  activeIds: Set<string>;
  onNavigate: (href: string) => void;
  onLocate?: (parentMenuId: string) => void;
  onOpenSecondary?: (container: MenuTreeNode) => void;
}) {
  // 容器默认展开（后端菜单深度 ≤2 层容器）；chevron 折叠，名称点击开二级栏。
  const [open, setOpen] = useState(true);
  const visibleChildren = node.children.filter((c) => isBrowsableShortcut(c.item) || c.item.type === "container");
  if (visibleChildren.length === 0) return null;
  const icon: IconName = (node.item.iconName as IconName | null) ?? "folder";

  return (
    <div>
      <div className="group flex w-full items-center gap-1 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded p-0.5 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
          aria-label={open ? "折叠" : "展开"}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        </button>
        <button
          type="button"
          onClick={() => onOpenSecondary?.(node)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title="打开二级导航"
        >
          <Icon name={icon} size={14} className="shrink-0 text-gx-text-tertiary" />
          <span className="flex-1 truncate text-gx-12 font-medium text-gx-text-secondary group-hover:text-gx-text-primary">
            {node.item.label ?? "未命名分组"}
          </span>
        </button>
      </div>
      {open &&
        visibleChildren.map((child) =>
          child.item.type === "container" ? (
            <ContainerNode
              key={child.item.id}
              node={child}
              depth={depth + 1}
              activeIds={activeIds}
              onNavigate={onNavigate}
              onLocate={onLocate}
              onOpenSecondary={onOpenSecondary}
            />
          ) : (
            <ShortcutRow
              key={child.item.id}
              node={child}
              depth={depth + 1}
              active={activeIds.has(child.item.id)}
              onNavigate={onNavigate}
              onLocate={onLocate}
            />
          ),
        )}
    </div>
  );
}

/**
 * 一级导航。浏览态：只显示活 shortcut；点击容器名打开二级三分区。
 */
export function PrimaryNav({ onOpenSecondary }: { onOpenSecondary?: (container: MenuTreeNode) => void }) {
  const { menu, isLoading, isError } = useNavMenu();
  const navigate = useNavigate();
  const { baseId, tableId, kbId, docId } = useParams();

  const tree = useMemo(() => buildMenuTree(filterBrowsableItems(menu?.items ?? [])), [menu?.items]);

  // 当前内容资源：表页取 table 节点，文档/画布取 doc 节点，库首页取 base/kb 节点。
  const currentResource = tableId ?? docId ?? baseId ?? kbId ?? null;
  const activeItems = useMemo(
    () => new Set(findActiveShortcuts(menu, currentResource).map((i) => i.id)),
    [menu, currentResource],
  );

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">导航加载失败，刷新重试</div>
    );
  }
  if (tree.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">
        暂无导航项
      </div>
    );
  }

  return (
    <nav className="flex flex-col gap-0.5 px-1.5 py-2">
      {tree.map((node) =>
        node.item.type === "container" ? (
          <ContainerNode
            key={node.item.id}
            node={node}
            depth={0}
            activeIds={activeItems}
            onNavigate={navigate}
            onLocate={(pid) =>
              onOpenSecondary?.(
                // 用菜单项构造容器节点（二级栏只需 id/label）
                { item: menu?.items.find((i) => i.id === pid) ?? node.item, children: [] } as MenuTreeNode,
              )
            }
            onOpenSecondary={onOpenSecondary}
          />
        ) : (
          <ShortcutRow
            key={node.item.id}
            node={node}
            depth={0}
            active={activeItems.has(node.item.id)}
            onNavigate={navigate}
            onLocate={(pid) =>
              onOpenSecondary?.(
                { item: menu?.items.find((i) => i.id === pid) ?? node.item, children: [] } as MenuTreeNode,
              )
            }
          />
        ),
      )}
    </nav>
  );
}
