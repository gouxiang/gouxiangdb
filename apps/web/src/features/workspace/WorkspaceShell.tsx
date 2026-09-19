// M3/S8 新工作区外壳（GX_ENTERPRISE_NAV on 时由 App 选用，替代旧 AppShell/KbShell 两壳）：
//   顶栏 56（品牌/库切换 + 全局搜索 + 个人中心）
//   左 L1 一级导航 224（折叠档 56）+ 底部固定区
//   L2 二级面板 240（骨架 S-1 常驻；无二级内容的入口收起为 0 宽，不占位）
//   内容 Outlet
// 窄宽退化（UI-SPEC v1.0 R-D-30~R-D-33，取代原先「一刀切 <1024 切抽屉」）：
//   1280–1439  L1 224、L2 压到 208（R-D-30）
//   1024–1279  L2 改浮出面板（可折叠，覆盖内容区左侧）（R-D-31）
//   768–1023   L1 折叠到 56 图标档 + L2 浮出面板（R-D-32）
//   <768       单栏：L1/L2 全部进抽屉（R-D-33）
// 档位由 lib/breakpoint.ts 判定：三档的结构不同（常驻栏 / 浮出面板 / 抽屉），
// 不是同一元素的 class 切换，故必须走 JS 档位；断档数值与 Tailwind 断点一致。
// URL 与旧壳完全一致；旧 AppShell/KbShell 文件保留供 flag off 回退。
//
// 阶段 1 壳层重构（UI-SPEC v1.0 骨架 S-1）：
//   R-N-07/08   L1 两档 224/56，折叠态写 localStorage（不写 URL），刷新保持
//   R-N-07/08'  L2 同构：收起/展开态写 gx.l2.collapsed，刷新保持；收起后常驻档留 56 窄条唤回。
//               三级优先级：用户显式意图 > 响应式档位默认（浮出档收起 / 常驻档展开）。
//   R-N-09/10   L1/L2 选中态 = 白底卡片 + 圆角 8 + accent 字 600（左侧色条已删）
//   R-N-02      L2 归属由 URL 反推（useMatch 取参），刷新/直访完整还原
//   R-N-19      主壳内不渲染面包屑（本壳本来就没有，保持为零）
//
// 阶段 6 菜单精细化：底部固定区与 L1 主区共用同一套行规格（高 32 / 图标 14 / 文字 13 /
// 圆角 8 / 左右 padding 8 / 150ms ease-out），图标按语义重排（工作区设置 = settings）；
// 底部固定区 + 折叠开关（原先最底的「用户卡片」已于交互治理阶段下线：
//   个人信息/登出入口统一收口到右上角 WorkspaceTopBar 的个人中心抽屉，避免同一入口两处并存）。
//
// 第三批导航重构（本文件接线的三处变化）：
//   1. L1 不再读 menu_items：改用 useBases() / useKbList() 两条既有查询喂给 PrimaryNav；
//   2. L2 的「当前容器」不再由 menu 容器**反推**，而直接由 URL 的 base/kb id + 上述列表得出；
//   3. `picked`（手动点一级容器开二级）随之删除 —— L1 点库就是导航，二级归属唯一真源是 URL。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import type { ActiveLibrary } from "../../components/LibrarySwitcher";
import { buildEntityIconIndex } from "../../components/EntityIconPicker";
import { useBases } from "../../api/hooks";
import { useKbList } from "../kb/kb-hooks";
import { SearchDialog } from "../search/SearchDialog";
import { useAuthzCapability } from "../authz/useAuthzCapability";
import { visibleFooterNav } from "./lib/nav-gate";
import { FOOTER_NAV_ITEMS } from "./lib/nav-footer";
import type { LibraryEntity } from "./lib/menu-sections";
import { deriveScopeContainer } from "./lib/route-container";
import { useMyOrgActions } from "../contacts/contacts-hooks";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { NavLibraryBlock } from "./NavLibraryBlock";
import { L1_ROW_IDLE, L1_ROW_SELECTED, NAV_ROW_TRANSITION, PrimaryNav } from "./PrimaryNav";
import { SecondaryNav, type SecondaryContainer } from "./SecondaryNav";
import { SecondaryNavRail } from "./SecondaryNavRail";
import { useBreakpointTier, isDrawerTier, isFloatingL2Tier } from "../../lib/breakpoint";
import {
  L1_WIDTH_COLLAPSED,
  L1_WIDTH_EXPANDED,
  L2_WIDTH,
  L2_WIDTH_COMPACT,
  readL1Collapsed,
  writeL1Collapsed,
} from "./lib/l1-collapse";
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
 * 底部固定区四项（D-5 §2.2 定稿顺序不变，单一真源在 lib/nav-footer.ts）。
 * 图标按语义重排：工作区设置由 database 改为 settings（database 已用于「数据库」类实体，
 * 挂在设置入口上语义错配）。行规格与 L1 主区共用 L1_ROW_* 与 NAV_ROW_TRANSITION。
 *
 * 门控（交互治理第一批）：四项各按自己那套能力判定渲染 —— 无能力即**不渲染该行**
 * （不是 disabled 假装禁用）。判定与 loading 语义全部下沉到 lib/nav-gate.ts 的纯函数，
 * 这里只装配 hook 信号，便于对同一套判定写单测而不必渲染整壳。
 */
function FooterNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const { canManage: authzManage } = useAuthzCapability();

  const go = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  const item = ({ path, icon, label }: { path: string; icon: IconName; label: string }) => {
    const active = pathname === path || pathname.startsWith(`${path}/`);
    return (
      <button
        type="button"
        onClick={() => go(path)}
        title={collapsed ? label : undefined}
        aria-label={label}
        className={[
          "flex h-8 w-full items-center rounded-gx-lg text-gx-13",
          NAV_ROW_TRANSITION,
          collapsed ? "justify-center px-0" : "gap-2 px-2",
          // R-N-09/10：与 L1 主区同一真源，选中 = 白底卡片 + accent 字 600
          active ? L1_ROW_SELECTED : L1_ROW_IDLE,
        ].join(" ")}
      >
        <Icon name={icon} size={14} className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`} />
        {collapsed ? null : <span className="flex-1 truncate text-left">{label}</span>}
      </button>
    );
  };

  const visible = visibleFooterNav(FOOTER_NAV_ITEMS, {
    actions,
    authzManage,
    // 能力探针未回来一律按无能力（fail-closed），否则会先闪出管理入口再消失。
    loading: actionsLoading,
  });
  // 一项都不可见时不渲染容器：空壳会在 L1 底部留下一条突兀的发丝线 + 内边距。
  if (visible.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-gx-hairline p-1.5">
      {visible.map((it) => (
        <div key={it.path}>{item(it)}</div>
      ))}
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
  /** R-D-32：768–1023 档 L1 被强制锁在 56 图标档，此时不给展开开关（点了也不会变宽）。 */
  showCollapseToggle = true,
  /**
   * R-D-31 / R-D-32：L2 以「浮出面板」承载时，收起态的唤回入口。
   * 放在 L1 底部固定区而不是内容区左上角——浮出面板收起来以后，入口不能再压住内容
   * （第一张卡片的标题就在那个位置）。折叠档下只留图标 + tooltip，符合 R-N-07。
   */
  secondaryToggle = null,
  /** L1 数据源：bases / kbs 实体列表（第三批：不再读 menu_items）。 */
  bases,
  kbs,
  navLoading = false,
  navError = false,
  /** 一级导航顶部插槽：库切换器 + 新建数据库/新建知识库入口。 */
  header,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showCollapseToggle?: boolean;
  secondaryToggle?: { label: string; onOpen: () => void } | null;
  /** L1 数据源所需的最小形态（BaseDTO / KbDTO 都结构化满足）。 */
  bases?: readonly LibraryEntity[];
  kbs?: readonly LibraryEntity[];
  navLoading?: boolean;
  navError?: boolean;
  header?: ReactNode;
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
          bases={bases}
          kbs={kbs}
          loading={navLoading}
          error={navError}
          collapsed={collapsed}
          header={header}
        />
      </div>
      <FooterNav collapsed={collapsed} />
      {secondaryToggle && (
        <div className="shrink-0 border-t border-gx-hairline p-1.5">
          <button
            type="button"
            onClick={secondaryToggle.onOpen}
            title={secondaryToggle.label}
            aria-label={secondaryToggle.label}
            className={[
              "flex w-full items-center rounded-gx-lg text-gx-12 text-gx-text-primary transition-colors hover:bg-gx-row-hover",
              collapsed ? "h-8 justify-center px-0" : "h-8 gap-2 px-2",
            ].join(" ")}
          >
            <Icon name="chevronRight" size={14} className="shrink-0" />
            {collapsed ? null : <span className="flex-1 truncate text-left">展开面板</span>}
          </button>
        </div>
      )}
      {showCollapseToggle && (
        <CollapseToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
      )}
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
  const [collapsed, setCollapsed] = useState<boolean>(() => readL1Collapsed());
  const location = useLocation();

  /** 当前库作用域（base / kb）：L1 数据源、L2 归属、库区块「当前库」的同一处判定。 */
  const baseMatch = useMatch("/base/:baseId/*");
  const kbMatch = useMatch("/kb/:kbId/*");
  const scopeKind: "base" | "kb" | null = baseMatch ? "base" : kbMatch ? "kb" : null;
  const scopeId = baseMatch?.params.baseId ?? kbMatch?.params.kbId ?? null;

  // 库区块（切换器 + 新建入口）的「当前库」同样由 pathname 反推：
  // 壳层挂在无 path 的布局路由下，useParams 恒为 {}（同上面 L2 归属的反推）。
  const activeLibrary: ActiveLibrary =
    scopeKind === "kb" ? { kind: "kb", id: scopeId } : { kind: "base", id: scopeId };

  /** L1 数据源（第三批：useBases/useKbList 就是一级导航本身，不再读 menu_items）。 */
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

  /** 显式收起：落盘（刷新保持），并清掉会话内 peek，否则 peek 会盖掉这次收起。 */
  const collapseL2 = useCallback(() => {
    setL2Peeked(false);
    setL2Intent(true);
    writeL2Collapsed(true);
  }, []);

  /** 显式展开：落盘（刷新保持）。窄条与 L1 底部唤回入口都走这里。 */
  const expandL2 = useCallback(() => {
    setL2Intent(false);
    writeL2Collapsed(false);
  }, []);

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

  // 跨档位切换（如 1000 → 1200）与路由变化都不再复位 L2：l2Hidden 是纯派生值，
  // 用户显式收起/展开由 l2Intent 承载（跨刷新），档位默认只在「从未操作」时生效。
  // 原先每次换档/换路由都按档位硬复位，正是「用户选择被档位锁死」的根因。
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
  // R-D-32：768–1023 L1 锁定 56 图标档（用户手动折叠态仍然保留，回到 ≥1024 时还原）
  const l1Collapsed = tier === "md" || collapsed;
  const l1Width = l1Collapsed ? L1_WIDTH_COLLAPSED : L1_WIDTH_EXPANDED;
  // R-D-30：1280–1439 L2 压到 208，其余档 240
  const l2Width = tier === "xl" ? L2_WIDTH_COMPACT : L2_WIDTH;

  const secondary = activeContainer ? (
    // key 随容器切换：tab/搜索词/展开态全部重挂重置，不把上个容器的视图状态带过来
    <SecondaryNav
      key={activeContainer.id}
      container={activeContainer}
      variant={floatingL2 || drawer ? "floating" : "static"}
      width={l2Width}
      entityIcons={entityIcons}
      onClose={collapseL2}
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
              {/* R-D-33：L1/L2 全部进抽屉。L1 常驻抽屉内；L2 叠在 L1 之上（不是并排——
                  224+240 会超出 390 的屏宽），其 × 收起后回到 L1，等价于「返回上一级」 */}
              <div className="absolute left-0 top-0 bottom-0 z-30 flex">
                <SideRail
                  collapsed={collapsed}
                  onToggleCollapsed={toggleCollapsed}
                  bases={bases ?? []}
                  kbs={kbs ?? []}
                  navLoading={basesLoading || kbsLoading}
                  navError={basesError || kbsError}
                  header={<NavLibraryBlock active={activeLibrary} collapsed={collapsed} />}
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
            collapsed={l1Collapsed}
            onToggleCollapsed={toggleCollapsed}
            bases={bases ?? []}
            kbs={kbs ?? []}
            navLoading={basesLoading || kbsLoading}
            navError={basesError || kbsError}
            showCollapseToggle={tier !== "md"}
            header={<NavLibraryBlock active={activeLibrary} collapsed={l1Collapsed} />}
            secondaryToggle={
              floatingL2 && !showL2 && activeContainer
                ? {
                    label: `展开「${activeContainer.name}」二级面板`,
                    onOpen: expandL2,
                  }
                : null
            }
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
            // 收起态：常驻档留 56 窄条唤回（否则收起＝二级导航永久消失）；
            // 浮出档不给窄条（会占掉内容宽度，违反 R-D-31/32），唤回入口在 L1 底部固定区。
            !floatingL2 && (
              <SecondaryNavRail
                key={`rail-${activeContainer.id}`}
                containerName={activeContainer.name}
                onExpand={expandL2}
              />
            )
          )
        )}

        {/* 浮出档收起后的唤回入口在 L1 底部固定区（SideRail.secondaryToggle），
            不浮在内容区上——入口不能反过来挡住内容。 */}

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
