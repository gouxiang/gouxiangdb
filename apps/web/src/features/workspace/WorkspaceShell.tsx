// M3/S8 新工作区外壳（GX_ENTERPRISE_NAV on 时由 App 选用，替代旧 AppShell/KbShell 两壳）：
//   顶栏 56（品牌/库切换 + 全局搜索 + 个人中心）
//   左 L1 一级导航 224（折叠档 56）+ 底部固定区
//   L2 二级面板 240（骨架 S-1 常驻；无二级内容的入口收起为 0 宽，不占位）
//   内容 Outlet
// 窄宽 <1024 左栏退化为抽屉（M3 只做桌面三版浏览器，SPEC :133）。
// URL 与旧壳完全一致；旧 AppShell/KbShell 文件保留供 flag off 回退。
//
// 阶段 1 壳层重构（UI-SPEC v1.0 骨架 S-1）：
//   R-N-07/08   L1 两档 224/56，折叠态写 localStorage（不写 URL），刷新保持
//   R-N-09/10   L1/L2 选中态 = 白底卡片 + 圆角 8 + accent 字 600（左侧色条已删）
//   R-N-02      L2 归属由 URL 反推（useMatch 取参），刷新/直访完整还原
//   R-N-19      主壳内不渲染面包屑（本壳本来就没有，保持为零）
import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { SearchDialog } from "../search/SearchDialog";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { PrimaryNav } from "./PrimaryNav";
import { SecondaryNav } from "./SecondaryNav";
import { useNavMenu, useNavNodeIndex } from "./nav-hooks";
import { resolveRouteContainer } from "./lib/route-container";
import {
  L1_WIDTH_COLLAPSED,
  L1_WIDTH_EXPANDED,
  readL1Collapsed,
  writeL1Collapsed,
} from "./lib/l1-collapse";
import type { MenuTreeNode } from "./lib/menu-tree";

interface SecondaryState {
  containerId: string;
  name: string;
}

/** R-N-09 选中态：白底 + 圆角 8 + accent 字 600；未选中 hover 换 gx-row-hover。 */
const FOOTER_SELECTED = "bg-white font-semibold text-gx-accent";
const FOOTER_IDLE = "text-gx-text-primary hover:bg-gx-row-hover";

function FooterNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const go = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  const item = (path: string, icon: Parameters<typeof Icon>[0]["name"], label: string) => {
    const active = pathname === path || pathname.startsWith(`${path}/`);
    return (
      <button
        type="button"
        onClick={() => go(path)}
        title={collapsed ? label : undefined}
        aria-label={label}
        className={[
          "flex w-full items-center rounded-gx-lg text-gx-13 transition-colors",
          collapsed ? "h-8 justify-center px-0" : "h-8 gap-2 px-2",
          active ? FOOTER_SELECTED : FOOTER_IDLE,
        ].join(" ")}
      >
        <Icon name={icon} size={14} className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`} />
        {collapsed ? null : <span className="flex-1 truncate text-left">{label}</span>}
      </button>
    );
  };

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-gx-hairline p-1.5">
      {item("/workspace/contacts", "building", "通讯录")}
      {item("/workspace/authz", "shield", "权限管理")}
      {item("/workspace/settings/nav", "sitemap", "导航编排")}
      {item("/workspace/settings/assets", "database", "工作区设置")}
    </div>
  );
}

/** R-N-07 折叠开关：折叠档下也必须可点（只留图标 + tooltip），否则用户无法还原。 */
function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "展开导航" : "收起导航";
  return (
    <div className="shrink-0 border-t border-gx-hairline p-1.5">
      <button
        type="button"
        onClick={onToggle}
        title={label}
        aria-label={label}
        aria-expanded={!collapsed}
        className={[
          "flex w-full items-center rounded-gx-lg text-gx-12 text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary",
          collapsed ? "h-8 justify-center px-0" : "h-8 gap-2 px-2",
        ].join(" ")}
      >
        <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={14} className="shrink-0" />
        {collapsed ? null : <span className="flex-1 truncate text-left">收起导航</span>}
      </button>
    </div>
  );
}

function SideRail({
  collapsed,
  onToggleCollapsed,
  activeContainerId,
  onOpenSecondary,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  activeContainerId: string | null;
  onOpenSecondary: (c: MenuTreeNode) => void;
}) {
  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-gx-hairline bg-gx-nav1"
      style={{ width: collapsed ? L1_WIDTH_COLLAPSED : L1_WIDTH_EXPANDED }}
      data-l1={collapsed ? "collapsed" : "expanded"}
    >
      {/* PrimaryNav 自身窗口化滚动（S10 大菜单 DOM 有界），不再外包滚动容器避免双滚动条 */}
      <div className="min-h-0 flex-1">
        <PrimaryNav
          onOpenSecondary={onOpenSecondary}
          collapsed={collapsed}
          activeContainerId={activeContainerId}
        />
      </div>
      <FooterNav collapsed={collapsed} />
      <CollapseToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
    </aside>
  );
}

export function WorkspaceShell() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 手动点 L1 容器打开的 L2；路由变化即清空（URL 是 L2 归属的唯一真源，R-N-02）
  const [picked, setPicked] = useState<SecondaryState | null>(null);
  /** L2 手动收起（骨架允许折叠，R-D-31）；换路由自动复位为常驻。 */
  const [l2Hidden, setL2Hidden] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => readL1Collapsed());
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1024));
  const location = useLocation();

  const { menu } = useNavMenu();
  const { index } = useNavNodeIndex();
  const baseMatch = useMatch("/base/:baseId/*");
  const kbMatch = useMatch("/kb/:kbId/*");
  const scopeKind: "base" | "kb" | null = baseMatch ? "base" : kbMatch ? "kb" : null;
  const scopeId = baseMatch?.params.baseId ?? kbMatch?.params.kbId ?? null;

  // 由当前库（base/kb）反推 L2 容器：刷新与直访都能还原同一个二级面板
  const routeContainer = useMemo(() => {
    if (!menu || !scopeKind || !scopeId) return null;
    const item = resolveRouteContainer(menu.items, index, { kind: scopeKind, id: scopeId });
    if (!item) return null;
    return {
      containerId: item.id,
      name: item.label ?? index.byId.get(item.nodeId ?? "")?.name ?? "容器",
    } satisfies SecondaryState;
  }, [menu, index, scopeKind, scopeId]);

  const openSecondary = (c: MenuTreeNode) => {
    setPicked({ containerId: c.item.id, name: c.item.label ?? c.item.node?.name ?? "容器" });
    setL2Hidden(false);
  };

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeL1Collapsed(next);
      return next;
    });
  }, []);

  // ⌘K 与旧壳一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 桌面三版断点；窄屏切路由后自动收抽屉
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    setDrawerOpen(false);
    setPicked(null);
    setL2Hidden(false);
  }, [location.pathname]);

  // 工作区级路由（/workspace/*）没有库上下文 → L2 收起为 0 宽、不占位
  const activeContainer = location.pathname.startsWith("/workspace")
    ? null
    : (picked ?? routeContainer);
  const showL2 = wide && !!activeContainer && !l2Hidden;

  return (
    <div className="flex h-screen flex-col bg-gx-bg">
      <WorkspaceTopBar onOpenSearch={() => setSearchOpen(true)} />

      {/* 窄屏抽屉触发条 */}
      {!wide && (
        <div className="flex items-center border-b border-gx-hairline bg-gx-surface px-2 py-1">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 rounded-gx-sm px-2 py-1 text-gx-12 text-gx-text-secondary hover:bg-gx-row-hover"
          >
            <Icon name="menu" size={15} />
            导航
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {wide ? (
          <SideRail
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            activeContainerId={activeContainer?.containerId ?? null}
            onOpenSecondary={openSecondary}
          />
        ) : (
          drawerOpen && (
            <>
              <button
                type="button"
                aria-label="关闭导航"
                className="absolute inset-0 z-20 bg-black/20"
                onClick={() => setDrawerOpen(false)}
              />
              <div className="absolute left-0 top-0 bottom-0 z-30">
                <SideRail
                  collapsed={collapsed}
                  onToggleCollapsed={toggleCollapsed}
                  activeContainerId={activeContainer?.containerId ?? null}
                  onOpenSecondary={openSecondary}
                />
              </div>
            </>
          )
        )}

        {showL2 && activeContainer && (
          // key 随容器切换：tab/搜索词/展开态/移动弹层全部重挂重置，不把上个容器的视图状态带过来
          <SecondaryNav
            key={activeContainer.containerId}
            containerMenuId={activeContainer.containerId}
            containerName={activeContainer.name}
            onClose={() => setL2Hidden(true)}
          />
        )}

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
