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
//   R-N-09/10   L1/L2 选中态 = 白底卡片 + 圆角 8 + accent 字 600（左侧色条已删）
//   R-N-02      L2 归属由 URL 反推（useMatch 取参），刷新/直访完整还原
//   R-N-19      主壳内不渲染面包屑（本壳本来就没有，保持为零）
//
// 阶段 6 菜单精细化：底部固定区与 L1 主区共用同一套行规格（高 32 / 图标 14 / 文字 13 /
// 圆角 8 / 左右 padding 8 / 150ms ease-out），图标按语义重排（工作区设置 = settings）；
// 底部固定区四项 + 折叠开关（原先最底的「用户卡片」已于交互治理阶段下线：
//   个人信息/登出入口统一收口到右上角 WorkspaceTopBar 的个人中心抽屉，避免同一入口两处并存）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import { buildEntityIconIndex, type EntityIconIndex } from "../../components/EntityIconPicker";
import { useBases } from "../../api/hooks";
import { useKbList } from "../kb/kb-hooks";
import { SearchDialog } from "../search/SearchDialog";
import { useAuthzCapability } from "../authz/useAuthzCapability";
import { visibleFooterNav } from "./lib/nav-gate";
import { useMyOrgActions } from "../contacts/contacts-hooks";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { L1_ROW_IDLE, L1_ROW_SELECTED, NAV_ROW_TRANSITION, PrimaryNav } from "./PrimaryNav";
import { SecondaryNav } from "./SecondaryNav";
import { useNavMenu, useNavNodeIndex } from "./nav-hooks";
import { resolveRouteContainer } from "./lib/route-container";
import { FOOTER_NAV_ITEMS } from "./lib/nav-footer";
import { useBreakpointTier, isDrawerTier, isFloatingL2Tier } from "../../lib/breakpoint";
import {
  L1_WIDTH_COLLAPSED,
  L1_WIDTH_EXPANDED,
  L2_WIDTH,
  L2_WIDTH_COMPACT,
  readL1Collapsed,
  writeL1Collapsed,
} from "./lib/l1-collapse";
import type { MenuTreeNode } from "./lib/menu-tree";

interface SecondaryState {
  containerId: string;
  name: string;
}

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
  activeContainerId,
  onOpenSecondary,
  /** R-D-32：768–1023 档 L1 被强制锁在 56 图标档，此时不给展开开关（点了也不会变宽）。 */
  showCollapseToggle = true,
  /**
   * R-D-31 / R-D-32：L2 以「浮出面板」承载时，收起态的唤回入口。
   * 放在 L1 底部固定区而不是内容区左上角——浮出面板收起来以后，入口不能再压住内容
   * （第一张卡片的标题就在那个位置）。折叠档下只留图标 + tooltip，符合 R-N-07。
   */
  secondaryToggle = null,
  /** base/kb 实体自定义图标索引（由 WorkspaceShell 装配）。 */
  entityIcons,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  activeContainerId: string | null;
  onOpenSecondary: (c: MenuTreeNode) => void;
  showCollapseToggle?: boolean;
  secondaryToggle?: { label: string; onOpen: () => void } | null;
  entityIcons?: EntityIconIndex;
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
          entityIcons={entityIcons}
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
  // 手动点 L1 容器打开的 L2；路由变化即清空（URL 是 L2 归属的唯一真源，R-N-02）
  const [picked, setPicked] = useState<SecondaryState | null>(null);
  /**
   * L2 收起态。
   * 浮出档（768–1279）默认**收起**：该档 L2 不再是常驻列，而是按需浮出的覆盖面板
   * （否则 240 的浮层会长期压住内容与卡片区，等于没给内容腾出宽度）。
   * 非浮出档（≥1280）默认常驻，与改动前一致。
   */
  const [l2Hidden, setL2Hidden] = useState(() => isFloatingL2Tier(tier));
  const [collapsed, setCollapsed] = useState<boolean>(() => readL1Collapsed());
  const location = useLocation();

  const { menu } = useNavMenu();
  const { index } = useNavNodeIndex();
  const baseMatch = useMatch("/base/:baseId/*");
  const kbMatch = useMatch("/kb/:kbId/*");
  const scopeKind: "base" | "kb" | null = baseMatch ? "base" : kbMatch ? "kb" : null;
  const scopeId = baseMatch?.params.baseId ?? kbMatch?.params.kbId ?? null;

  /**
   * 五类实体「自定义图标 + 颜色」索引：按实体资源 id 索引，L1 容器行与 L2 面板头按
   * nav node.resourceId 取值。放在壳层装配是因为一级/二级导航都跑在多份不带
   * QueryClientProvider 的 SSR 回归里，不能在它们内部直接 useQuery。
   * 两份列表都是既有缓存（库切换器 / 资产页同源），这里不新增请求。
   */
  const { data: basesForIcons } = useBases();
  const { data: kbsForIcons } = useKbList();
  const entityIcons = useMemo(
    () => buildEntityIconIndex(basesForIcons ?? [], kbsForIcons ?? []),
    [basesForIcons, kbsForIcons],
  );

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

  // 跨档位切换（如 1000 → 1200）时按该档默认态复位：浮出档收起、常驻档展开。
  // 否则会出现「面板在某档被收起、换档后既无列也无入口」的死角（功能必须始终可达）。
  useEffect(() => {
    setL2Hidden(isFloatingL2Tier(tier));
  }, [tier]);
  useEffect(() => {
    setDrawerOpen(false);
    setPicked(null);
    setL2Hidden(isFloatingL2Tier(tier));
    // 仅路由变化时复位；tier 变化由上一个 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // 工作区级路由（/workspace/*）没有库上下文 → L2 收起为 0 宽、不占位
  const activeContainer = location.pathname.startsWith("/workspace")
    ? null
    : (picked ?? routeContainer);
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
    // key 随容器切换：tab/搜索词/展开态/移动弹层全部重挂重置，不把上个容器的视图状态带过来
    <SecondaryNav
      key={activeContainer.containerId}
      containerMenuId={activeContainer.containerId}
      containerName={activeContainer.name}
      variant={floatingL2 || drawer ? "floating" : "static"}
      width={l2Width}
      entityIcons={entityIcons}
      onClose={() => setL2Hidden(true)}
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
                  activeContainerId={activeContainer?.containerId ?? null}
                  onOpenSecondary={openSecondary}
                  entityIcons={entityIcons}
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
            activeContainerId={activeContainer?.containerId ?? null}
            onOpenSecondary={openSecondary}
            showCollapseToggle={tier !== "md"}
            entityIcons={entityIcons}
            secondaryToggle={
              floatingL2 && !showL2 && activeContainer
                ? {
                    label: `展开「${activeContainer.name}」二级面板`,
                    onOpen: () => setL2Hidden(false),
                  }
                : null
            }
          />
        )}

        {!drawer && showL2 && secondary && (
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
