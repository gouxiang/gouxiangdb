// M3/S8 新工作区外壳（GX_ENTERPRISE_NAV on 时由 App 选用，替代旧 AppShell/KbShell 两壳）：
//   顶栏（品牌/库切换 + 全局搜索 + 个人中心）
//   左 w-60 一级导航 PrimaryNav（S9 叠加编排与二级三分区）
//   左下通用区（工作区设置中心：通讯录/导航编排/资产，裁决 7 三条真实入口）
//   内容 Outlet
// 窄宽 <1024 左栏退化为抽屉（M3 只做桌面三版浏览器，SPEC :133）。
// URL 与旧壳完全一致；旧 AppShell/KbShell 文件保留供 flag off 回退。
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { SearchDialog } from "../search/SearchDialog";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { PrimaryNav } from "./PrimaryNav";
import { SecondaryNav } from "./SecondaryNav";
import type { MenuTreeNode } from "./lib/menu-tree";

interface SecondaryState {
  containerId: string;
  name: string;
}

function FooterNav({ onNavigate }: { onNavigate?: () => void }) {
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
        className={[
          "relative flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-13 transition-colors",
          active ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
        ].join(" ")}
      >
        {active && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r bg-gx-accent" />}
        <Icon name={icon} size={14} className="shrink-0 opacity-80" />
        <span className="flex-1 truncate">{label}</span>
      </button>
    );
  };

  return (
    <div className="border-t border-gx-separator p-1.5">
      {item("/workspace/contacts", "building", "通讯录")}
      {item("/workspace/authz", "shield", "权限管理")}
      {item("/workspace/settings/nav", "sitemap", "导航编排")}
      {item("/workspace/settings/assets", "database", "工作区设置")}
    </div>
  );
}

function SideRail({ onOpenSecondary }: { onOpenSecondary: (c: MenuTreeNode) => void }) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-gx-separator bg-gx-bg">
      {/* PrimaryNav 自身窗口化滚动（S10 大菜单 DOM 有界），不再外包滚动容器避免双滚动条 */}
      <div className="min-h-0 flex-1">
        <PrimaryNav onOpenSecondary={onOpenSecondary} />
      </div>
      <FooterNav />
    </aside>
  );
}

export function WorkspaceShell() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [secondary, setSecondary] = useState<SecondaryState | null>(null);
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1024));
  const location = useLocation();

  const openSecondary = (c: MenuTreeNode) => {
    setSecondary({ containerId: c.item.id, name: c.item.label ?? c.item.node?.name ?? "容器" });
  };

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
  }, [location.pathname]);

  return (
    <div className="flex h-screen flex-col bg-gx-bg">
      <WorkspaceTopBar onOpenSearch={() => setSearchOpen(true)} />

      {/* 窄屏抽屉触发条 */}
      {!wide && (
        <div className="flex items-center border-b border-gx-separator bg-gx-surface px-2 py-1">
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
          <SideRail onOpenSecondary={openSecondary} />
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
                <SideRail onOpenSecondary={openSecondary} />
              </div>
            </>
          )
        )}

        {wide && secondary && (
          // key 随容器切换：tab/搜索词/展开态/移动弹层全部重挂重置，不把上个容器的视图状态带过来
          <SecondaryNav
            key={secondary.containerId}
            containerMenuId={secondary.containerId}
            containerName={secondary.name}
            onClose={() => setSecondary(null)}
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
