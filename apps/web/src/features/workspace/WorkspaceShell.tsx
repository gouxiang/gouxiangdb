// M3/S8 新工作区外壳（GX_ENTERPRISE_NAV on 时由 App 选用，替代旧 AppShell/KbShell 两壳）：
//   顶栏 56（品牌 / 全局搜索 / 个人中心）
//   左 L1 v6 图标轨：恒 76px（轻量拟物砖 + 底部建库实心蓝钮），无折叠档
//   L2 二级面板恒 236（v6 S2 起底板同宽、不分档；无二级内容时收起为 0 宽，不占位）
//   内容 Outlet
// 窄宽退化（UI-SPEC v1.0 R-D-30~R-D-33）：
//   1280–1439  L2 恒 236（v6 S2 起 R-D-30 紧凑档 208 废止）
//   1024–1279  L2 改浮出面板（可折叠，覆盖内容区左侧）（R-D-31）
//   768–1023   L2 浮出面板（R-D-32；v6 起 L1 不再折叠，恒为 76 图标轨）
//   <768       单栏：L1/L2 全部进抽屉（R-D-33）
// 档位由 lib/breakpoint.ts 判定：三档的结构不同（常驻栏 / 浮出面板 / 抽屉），
// 不是同一元素的 class 切换，故必须走 JS 档位；断档数值与 Tailwind 断点一致。
// URL 与旧壳完全一致；旧 AppShell/KbShell 文件保留供 flag off 回退。
//
// v6 S1（2026-10 UI 重做第一刀）：
//   - L1 从「196/56 两档文字栏」改为恒 76px 图标轨，折叠态 localStorage 机制整体废止
//     （lib/l1-collapse.ts 只剩几何常量）；
//   - 整条图标轨就是库列表（PrimaryNav），建库入口移到轨道底部 RailFoot 的实心蓝钮；
//   - 库级「重命名 / 设置」从 L1 行尾菜单迁到 L2 面板头（SecondaryNav 的库操作「…」），
//     重命名弹窗在本壳层挂载（PrimaryNavRenameModal + useLibraryRename）；
//   - NavLibraryBlock / LibrarySwitcher 本体保留（旧两壳 flag off 仍在用），新壳不再接线。
//
// L2 机制（R-N-07/08'，一字未动）：收起/展开写 gx.l2.collapsed；三级优先级
// 用户显式意图 > 响应式档位默认（浮出档收起 / 常驻档展开），见 lib/l2-collapse.ts。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { buildEntityIconIndex } from "../../components/EntityIconPicker";
import { useBases, useCanCreateLibrary } from "../../api/hooks";
import { useKbList } from "../kb/kb-hooks";
import { SearchDialog } from "../search/SearchDialog";
import { useAuthzCapability } from "../authz/useAuthzCapability";
import { visibleFooterNav } from "./lib/nav-gate";
import { FOOTER_NAV_ITEMS, type FooterNavItem } from "./lib/nav-footer";
import type { LibraryEntity } from "./lib/menu-sections";
import { canManageLibrary } from "./lib/menu-sections";
import { deriveScopeContainer } from "./lib/route-container";
import { useMyOrgActions } from "../contacts/contacts-hooks";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { PrimaryNav } from "./PrimaryNav";
import { PrimaryNavRenameModal, type RenameTarget } from "./PrimaryNavRenameModal";
import { CreateLibraryModal } from "../../components/CreateLibraryModal";
import { SecondaryNav, type SecondaryContainer } from "./SecondaryNav";
import { useLibraryRename } from "./useLibraryRename";
import { SecondaryNavRail } from "./SecondaryNavRail";
import { useBreakpointTier, isDrawerTier, isFloatingL2Tier } from "../../lib/breakpoint";
import { L1_WIDTH, L2_WIDTH } from "./lib/l1-collapse";
import { readL2Collapsed, resolveL2Collapsed, writeL2Collapsed } from "./lib/l2-collapse";

/** L2 当前容器：一级选中库本体（kind + id + name），由 URL 与实体列表得出。 */
type ActiveContainer = SecondaryContainer;

/**
 * 浮出面板（R-D-31 / R-D-32）的起始高度：内容区首行「工具栏带」高 48（附录 C.1）。
 * 面板从这一行下沿起算，因此不会盖住「新建记录 / 筛选 / 搜索 / 更多」这排按钮——
 * 浮出只是覆盖内容，不能把主操作变成不可点。
 */
const L2_FLOATING_TOP_PX = 48;

/**
 * ③ 图标轨底部固定区（v6 底板 .rail-foot）：
 *   1. 建库实心蓝钮（仅 useCanCreateLibrary() 为真；库类型在弹窗内二选一）；
 *   2. 能力门控后的底部项（通讯录 / 帮助 / 设置，门控沿用 nav-gate，fail-closed）；
 *   3. 浮出档 L2 收起时的唤回砖。
 * 一项都没有时不渲染容器（不留空边线）。全部纯图标 + title tooltip（砖名由 CSS 隐藏）。
 */
function RailFoot({
  secondaryToggle = null,
  onNavigate,
}: {
  secondaryToggle?: { label: string; onOpen: () => void } | null;
  /** 抽屉档点击后关抽屉；常驻档不传。 */
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [creating, setCreating] = useState(false);
  // 权限门：无 create_library 的用户整个建库钮不渲染（不是 disabled）；加载中按无权限。
  const canCreate = useCanCreateLibrary();
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const { canManage: authzManage } = useAuthzCapability();

  const visible = visibleFooterNav(FOOTER_NAV_ITEMS, {
    actions,
    authzManage,
    // 能力探针未回来一律按无能力（fail-closed），否则会先闪出管理入口再消失。
    loading: actionsLoading,
  });

  const go = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  const footItem = (it: FooterNavItem) => {
    const active = pathname === it.path || pathname.startsWith(`${it.path}/`);
    return (
      <button
        key={it.path}
        type="button"
        onClick={() => go(it.path)}
        title={it.label}
        aria-label={it.label}
        className={["gx-rail-item", active ? "is-active" : ""].filter(Boolean).join(" ")}
      >
        <span className="gx-rail-tile">
          <Icon name={it.icon} size={17} />
        </span>
        <span className="gx-rail-nm">{it.label}</span>
      </button>
    );
  };

  if (!canCreate && visible.length === 0 && !secondaryToggle) return null;

  return (
    <div className="gx-rail-foot">
      {canCreate && (
        <>
          <button
            type="button"
            onClick={() => setCreating(true)}
            title="新建库"
            aria-label="新建库"
            data-nav-row="library-create"
            className="gx-rail-item is-create"
          >
            <span className="gx-rail-tile">
              <Icon name="plus" size={17} />
            </span>
            <span className="gx-rail-nm">新建库</span>
          </button>
          {/* 不传 fixedType：弹窗内渲染「智能数据库 / 知识库」二选一，两条创建流程共用一份 */}
          <CreateLibraryModal open={creating} title="新建库" onClose={() => setCreating(false)} />
        </>
      )}
      {visible.map(footItem)}
      {secondaryToggle && (
        <button
          type="button"
          onClick={secondaryToggle.onOpen}
          title={secondaryToggle.label}
          aria-label={secondaryToggle.label}
          className="gx-rail-item"
        >
          <span className="gx-rail-tile">
            <Icon name="chevronRight" size={17} />
          </span>
          <span className="gx-rail-nm">展开面板</span>
        </button>
      )}
    </div>
  );
}

/**
 * L1 侧栏：v6 恒 76px 图标轨。宽度走内联 style（L1_WIDTH），表面样式全部在
 * index.css 的 .gx-rail-surface（组件源码零 hex）。
 */
function SideRail({
  /** R-D-31 / R-D-32：L2 以「浮出面板」承载时，收起态的唤回砖（放轨道底部）。 */
  secondaryToggle = null,
  /** L1 数据源：bases / kbs 实体列表（不读 menu_items）。 */
  bases,
  kbs,
  navLoading = false,
  navError = false,
  /** 透传给 PrimaryNav：浮出/抽屉档 L2 收起时，点当前容器临时唤出 L2。 */
  onPeekCurrent,
  /** 抽屉档：点底部项后关抽屉。 */
  onFootNavigate,
}: {
  secondaryToggle?: { label: string; onOpen: () => void } | null;
  bases?: readonly LibraryEntity[];
  kbs?: readonly LibraryEntity[];
  navLoading?: boolean;
  navError?: boolean;
  onPeekCurrent?: () => void;
  onFootNavigate?: () => void;
}) {
  return (
    <aside
      className="gx-rail-surface flex h-full shrink-0 flex-col"
      style={{ width: L1_WIDTH }}
      data-l1="rail"
    >
      {/* PrimaryNav 自身窗口化滚动（S10 大菜单 DOM 有界）。 */}
      <div className="min-h-0 flex-1">
        <PrimaryNav
          bases={bases}
          kbs={kbs}
          loading={navLoading}
          error={navError}
          onPeekCurrent={onPeekCurrent}
        />
      </div>
      <RailFoot secondaryToggle={secondaryToggle} onNavigate={onFootNavigate} />
    </aside>
  );
}

export function WorkspaceShell() {
  const tier = useBreakpointTier();
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /**
   * L2 收起态拆成两份，根因是「响应式档位」原先冒充了「用户意图」：
   *   l2Intent —— 用户显式点过收起/展开，写 localStorage（gx.l2.collapsed），刷新保持。
   *               null = 从未操作过，此时才跟随档位默认（浮出档收起 / 常驻档展开）。
   *   l2Peeked —— 会话内临时展开（点一级容器唤出），不写盘、换路由即失效：
   *               「我要看这个容器的二级」是一次性动作，不该升级成永久偏好。
   * 优先级（单一真源 l2-collapse.resolveL2Collapsed）：l2Peeked > l2Intent > 档位默认。
   */
  const [l2Intent, setL2Intent] = useState<boolean | null>(() => readL2Collapsed());
  const [l2Peeked, setL2Peeked] = useState(false);
  /** 库重命名弹窗目标：S1 起由 L2 面板头「库操作」菜单发起，弹窗在壳层挂载。 */
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const location = useLocation();

  /** 当前库作用域（base / kb）：L1 数据源、L2 归属的同一处判定。 */
  const baseMatch = useMatch("/base/:baseId/*");
  const kbMatch = useMatch("/kb/:kbId/*");
  const scopeKind: "base" | "kb" | null = baseMatch ? "base" : kbMatch ? "kb" : null;
  const scopeId = baseMatch?.params.baseId ?? kbMatch?.params.kbId ?? null;

  /** L1 数据源：useBases/useKbList 就是一级导航本身，不读 menu_items。 */
  const { data: bases, isLoading: basesLoading, isError: basesError } = useBases();
  const { data: kbs, isLoading: kbsLoading, isError: kbsError } = useKbList();
  /**
   * L2 面板头的实体图标索引：按实体资源 id 索引。放在壳层装配是因为二级导航跑在多份
   * 不带 QueryClientProvider 的 SSR 回归里，不能在它内部直接取这两个列表。
   * 两份列表与 L1 同源（同一次请求），这里不新增网络开销。
   */
  const entityIcons = useMemo(
    () => buildEntityIconIndex(bases ?? [], kbs ?? []),
    [bases, kbs],
  );

  /**
   * 由当前库（base/kb）直接得出 L2 容器：刷新与直访都能还原同一个二级面板。
   * 名称取自同一批列表（未加载完先返回 null，避免面板头短暂的错名闪跳）。
   */
  const routeContainer = useMemo<ActiveContainer | null>(
    () => deriveScopeContainer(bases, kbs, scopeKind && scopeId ? { kind: scopeKind, id: scopeId } : null),
    [scopeKind, scopeId, bases, kbs],
  );

  /**
   * L2 头「库操作 → 重命名」的落库实现：useLibraryRename（client 方法 + 失效列表缓存）。
   * SecondaryNav 头回调只负责发起，真正落库走既有 modal → useLibraryRename。
   */
  const renameLibrary = useLibraryRename();

  /** 当前库实体（用于库操作菜单的 canManage 判定）；未加载完按无管理权限（fail-closed）。 */
  const activeEntity = routeContainer
    ? ((bases ?? []).find((b) => b.id === routeContainer.id)
      ?? (kbs ?? []).find((k) => k.id === routeContainer.id)
      ?? null)
    : null;
  const canManageActiveLib = canManageLibrary(activeEntity?.role);

  /** 显式收起：落盘（刷新保持），并清掉会话内 peek，否则 peek 会盖掉这次收起。 */
  const collapseL2 = useCallback(() => {
    setL2Peeked(false);
    setL2Intent(true);
    writeL2Collapsed(true);
  }, []);

  /** 显式展开：落盘（刷新保持）。窄条与唤回砖都走这里。 */
  const expandL2 = useCallback(() => {
    setL2Intent(false);
    writeL2Collapsed(false);
  }, []);

  /**
   * 临时唤出（peek）：会话态，只置 l2Peeked，不写盘、不改 l2Intent；
   * 换路由由既有 effect 复位。浮出/抽屉档 L2 收起时点当前容器使用。
   */
  const peekL2 = useCallback(() => setL2Peeked(true), []);

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

  // 跨档位切换（如 1000 → 1200）与路由变化都不再复位 L2：l2Hidden 是纯派生值，
  // 用户显式收起/展开由 l2Intent 承载（跨刷新），档位默认只在「从未操作」时生效。
  useEffect(() => {
    setDrawerOpen(false);
    setL2Peeked(false);
  }, [location.pathname]);

  // 工作区级路由（/workspace/*）没有库上下文 → L2 收起为 0 宽、不占位
  const activeContainer = location.pathname.startsWith("/workspace")
    ? null
    : routeContainer;
  const l2Hidden = l2Peeked ? false : resolveL2Collapsed(l2Intent, isFloatingL2Tier(tier));
  const showL2 = !!activeContainer && !l2Hidden;

  // R-D-33：<768 单栏，L1/L2 全部进抽屉（由汉堡「导航」唤出）
  const drawer = isDrawerTier(tier);
  // R-D-31 / R-D-32：768–1279 L2 是覆盖内容区左侧的浮出面板
  const floatingL2 = isFloatingL2Tier(tier);

  // 仅浮出/抽屉档且 L2 当前收起、确有容器时，才给 PrimaryNav 注入 peek 口；
  // 常驻静态档或已展开时不传（点击仍为普通导航）。
  const peekCurrent =
    (floatingL2 || drawer) && !showL2 && activeContainer ? peekL2 : undefined;

  // v6：L1 恒为 76px 图标轨（浮出 left 与 SecondaryNavRail 的 l1Width 都取此值）。
  const l1Width = L1_WIDTH;
  // v6 S2：L2 按底板 .l2 恒为 236px，紧凑档（208）已废止，所有响应式档同宽。
  const l2Width = L2_WIDTH;

  const secondary = activeContainer ? (
    // key 随容器切换：tab/搜索词/展开态全部重挂重置，不把上个容器的视图状态带过来
    <SecondaryNav
      key={activeContainer.id}
      container={activeContainer}
      variant={floatingL2 || drawer ? "floating" : "static"}
      width={l2Width}
      entityIcons={entityIcons}
      onClose={collapseL2}
      libraryCanManage={canManageActiveLib}
      onRenameLibrary={(kind, id, name) => setRenameTarget({ kind, id, name })}
    />
  ) : null;

  return (
    <div className="flex h-screen flex-col bg-gx-bg">
      <WorkspaceTopBar onOpenSearch={() => setSearchOpen(true)} />

      {/* 窄屏抽屉触发条（R-D-33） */}
      {drawer && (
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
        {drawer ? (
          drawerOpen && (
            <>
              <button
                type="button"
                aria-label="关闭导航"
                className="absolute inset-0 z-20 bg-black/20"
                onClick={() => setDrawerOpen(false)}
              />
              {/* R-D-33：L1/L2 全部进抽屉。L1 常驻抽屉内（恒 76 图标轨）；L2 叠在 L1
                  之上（不是并排——76+236 也会挤出 390 屏宽），其 × 收起后回到 L1，
                  等价于「返回上一级」 */}
              <div className="absolute left-0 top-0 bottom-0 z-30 flex">
                <SideRail
                  bases={bases ?? []}
                  kbs={kbs ?? []}
                  navLoading={basesLoading || kbsLoading}
                  navError={basesError || kbsError}
                  onPeekCurrent={peekCurrent}
                  onFootNavigate={() => setDrawerOpen(false)}
                />
                {showL2 && secondary && (
                  <div className="absolute left-0 top-0 bottom-0 gx-z-drawer shadow-gx-lg">
                    {secondary}
                  </div>
                )}
              </div>
            </>
          )
        ) : (
          <SideRail
            bases={bases ?? []}
            kbs={kbs ?? []}
            navLoading={basesLoading || kbsLoading}
            navError={basesError || kbsError}
            secondaryToggle={
              floatingL2 && !showL2 && activeContainer
                ? {
                    label: `展开「${activeContainer.name}」二级面板`,
                    onOpen: expandL2,
                  }
                : null
            }
            onPeekCurrent={peekCurrent}
          />
        )}

        {!drawer && activeContainer && (
          showL2 ? (
            floatingL2 ? (
              // R-D-31 / R-D-32：浮出面板——绝对定位贴内容区左侧，覆盖内容但不挤压内容宽度。
              // top 从「内容区首行工具带」下沿起算（工具栏高 48，见附录 C.1）：面板只覆盖内容，
              // 不盖住「新建记录 / 筛选 / 搜索」这一行——一号原则是功能始终可达。
              <div
                className="absolute bottom-0 gx-z-drawer"
                style={{ left: l1Width, top: L2_FLOATING_TOP_PX }}
                data-l2="floating"
              >
                {secondary}
              </div>
            ) : (
              secondary
            )
          ) : (
            // 收起态（常驻档）：彻底收起、零内容占位，只在 L1 右缘垂直中点留一个圆形悬浮
            // 箭头唤回（SecondaryNavRail 已改为不占宽的 absolute 钮，骑在当前 L1 右缘）。
            // 浮出档不渲染本件（会占内容宽度，违反 R-D-31/32），唤回入口在轨道底部。
            !floatingL2 && (
              <SecondaryNavRail
                key={`rail-${activeContainer.id}`}
                containerName={activeContainer.name}
                onExpand={expandL2}
                l1Width={l1Width}
              />
            )
          )
        )}

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* 库重命名弹窗：L2 面板头「库操作」发起，落库走 useLibraryRename。 */}
      <PrimaryNavRenameModal
        target={renameTarget}
        bases={bases ?? []}
        kbs={kbs ?? []}
        onClose={() => setRenameTarget(null)}
        onRename={renameLibrary}
      />
    </div>
  );
}
