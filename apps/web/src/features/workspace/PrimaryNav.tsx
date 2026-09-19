// 一级导航（L1）。
//
// 第三批导航重构的口径（用户定的规则）：
//   - L1 **只放「数据库 + 知识库」**，外加底部固定区的管理功能（FooterNav，见 WorkspaceShell）；
//   - L1 里**不得出现任何二级内容**（表 / 文档 / 画布一律不在此渲染）——这是核心红线；
//   - 二级由一级选中项决定，且二级数据源也不再读 menu_items（见 SecondaryNav.tsx）。
//
// 数据源因此从 `GET /workspaces/current/menu`（menu_items 树）改为 useBases() / useKbList()
// 两个既有查询：L1 = 用户有权看到的全部库，新建库即时出现，无需再手工「收纳」。
// 数据由壳层（WorkspaceShell）以 props 注入：本组件跑在多份不带 QueryClientProvider 的
// SSR 回归里，组件内不能直接用 useQuery。
//
// 保留下来不许丢的能力：
//   R-N-07/09  折叠档（56px 只留图标）+ 选中态 = 白底卡片 + 圆角 8 + accent 字 600（左侧色条已删）
//   R-N-20     两级摊平：分组标题行 + 平铺项，无手风琴展开/收起
//   R-N-22     节奏统一：菜单项行 32 / 分组标题行 24 / 图标 14 / 文字 13 / 圆角 8 /
//              图标与文字 gap-8 / 行内左右 padding 8；行右键 hover 150ms ease-out
//   S10        大列表窗口化（定高/变高切片），DOM 不随库数量线性膨胀
//   R-N-17     个人区入口是规划入口：保留位置 + 「规划中」徽标 + 点击有明确反馈
//
// 随 menu_items 一并下线的：container 嵌套与它的深层侧方浮出（L1 现在是扁平的两组列表，
// 没有可浮出的嵌套容器了；FlyoutPanel 与其(), 单测因此不再存在）。
import { useMemo, type ReactNode } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { Spinner, toast } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";
import {
  buildLibraryRows,
  libraryRowHeights,
  NAV_GROUP_ROW_H,
  NAV_ITEM_ROW_H,
  NAV_ROW_GAP,
  type LibraryEntity,
  type LibraryNavRow,
} from "./lib/menu-sections";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";

/** 浏览态一级行固定行高 32（窗口化与视觉节奏的同一真源，见 lib/menu-sections）。 */
export const NAV_ROW_H = NAV_ITEM_ROW_H;

/** 全站菜单行过渡：150ms ease-out。 */
export const NAV_ROW_TRANSITION = "transition-colors duration-150 ease-out";

/** 拼类名并过滤空片段（避免条件片段留双空格）。 */
const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** 实体类型 → 默认图标（供复用：二级行的 fallback 图标也走这里）。 */
export function navKindIcon(kind: string): IconName {
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

/** 菜单项行外壳（节奏统一：高 32 / 圆角 8 / 左右 padding 8 / gap 8 / 150ms ease-out）。 */
const ITEM_SHELL = `flex h-8 w-full items-center gap-2 rounded-gx-lg px-2 text-gx-13 ${NAV_ROW_TRANSITION}`;

/**
 * 本阶段不启用的「个人用户」规划入口（个人门户 / 工作台首页 / 我的待办 / 我的收藏）：
 * 原实现是点了只弹一个「规划中」toast 的假入口，属不符合用户直觉的操作路径，
 * 已按主理人要求从界面移除、转入需求池（与侧栏底部个人信息栏同一处置口径）。
 * 需要恢复时从 commit 720e09c 之前取回 PERSONAL_PLANNED 与 PlannedPersonalRow。
 */

/**
 * 分组标题行：小字、hint 色、独立行、不缩进、不可点（「数据库」「知识库」只是分组标签，
 * 不是导航入口，不做成假入口）。
 */
function GroupHeaderRow({ label, iconOnly }: { label: string; iconOnly: boolean }) {
  if (iconOnly) return null;
  return (
    <div
      data-nav-row="group"
      className="flex w-full items-center rounded-gx-lg px-2 text-gx-11 font-medium text-gx-text-hint"
      style={{ height: NAV_GROUP_ROW_H, marginBottom: NAV_ROW_GAP }}
    >
      <span className="truncate">{label}</span>
    </div>
  );
}

/**
 * 一级导航：数据库 + 知识库两组。
 *
 * 二级内容不在此渲染（用户红线）：点某个库只做跳转到 /base/:id 或 /kb/:id，
 * 二级归属由 URL 反推（壳层 R-N-02），本组件不再持有任何二级状态。
 */
export function PrimaryNav({
  bases = [],
  kbs = [],
  loading = false,
  error = false,
  collapsed = false,
  header,
}: {
  /** 数据库列表（壳层 useBases() 的结果）。 */
  bases?: readonly LibraryEntity[];
  /** 知识库列表（壳层 useKbList() 的结果）。 */
  kbs?: readonly LibraryEntity[];
  /** 两个列表任一在 loading。 */
  loading?: boolean;
  /** 两个列表任一读取失败。 */
  error?: boolean;
  /** R-N-07 折叠档（56px）：只留图标 + title tooltip。 */
  collapsed?: boolean;
  /**
   * 顶部插槽（库切换器 + 新建入口）：由壳层传入。
   * 本组件不直接 useBases/useKbList —— 多份 SSR 回归不带 QueryClientProvider，
   * 需要 QueryClient 的区块一律经 props 从壳层进来。
   */
  header?: ReactNode;
}) {
  const navigate = useNavigate();
  // 当前资源一律用 useMatch 对 pathname 取参，不用 useParams：本组件挂在【无 path 的
  // 壳层布局路由】下，useParams 取到的是该布局路由自身的 params（恒为 {}），
  // L1 选中态因此在真实应用里永远不亮。useMatch 与路由层级无关，刷新/直访同样成立。
  const tableMatch = useMatch("/base/:baseId/table/:tableId/*");
  const docMatch = useMatch("/kb/:kbId/doc/:docId");
  const canvasMatch = useMatch("/kb/:kbId/canvas/:docId");
  const baseMatch = useMatch("/base/:baseId");
  const kbMatch = useMatch("/kb/:kbId");

  /** 当前所在的库：无论停在库首页还是它的子资源（表/文档/画布），父母 library 都要高亮。 */
  const activeEntityId =
    tableMatch?.params.baseId ??
    baseMatch?.params.baseId ??
    docMatch?.params.kbId ??
    canvasMatch?.params.kbId ??
    kbMatch?.params.kbId ??
    null;

  const rows = useMemo<LibraryNavRow[]>(() => {
    const all = buildLibraryRows(bases, kbs);
    return collapsed ? all.filter((r) => r.kind !== "group") : all;
  }, [bases, kbs, collapsed]);
  const heights = useMemo(() => libraryRowHeights(rows), [rows]);

  const virt = useMenuVirtualizer<LibraryNavRow>(rows, NAV_ITEM_ROW_H + NAV_ROW_GAP, 12, heights);

  const body = () => {
    if (loading) {
      return (
        <div className="flex h-32 items-center justify-center">
          <Spinner size={18} />
        </div>
      );
    }
    if (error) {
      return (
        <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">
          {collapsed ? "!" : "导航加载失败，刷新重试"}
        </div>
      );
    }
    if (rows.length === 0) {
      return (
        <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">
          {collapsed ? "" : "暂无数据库或知识库"}
        </div>
      );
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
            <LibraryRow
              key={row.id}
              row={row}
              active={row.kind === "item" && row.entityId === activeEntityId}
              iconOnly={collapsed}
              onNavigate={navigate}
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
      {/* 「个人用户」规划入口已按本阶段范围下线（见文件顶部注释），此处不再渲染。 */}
      {body()}
    </div>
  );
}

/** 分组标题行 / 库入口行（两态）。 */
function LibraryRow({
  row,
  active,
  iconOnly,
  onNavigate,
}: {
  row: LibraryNavRow;
  active: boolean;
  iconOnly: boolean;
  onNavigate: (href: string) => void;
}) {
  if (row.kind === "group") {
    return <GroupHeaderRow label={row.label} iconOnly={iconOnly} />;
  }
  const href = row.entityKind === "base" ? `/base/${row.entityId}` : `/kb/${row.entityId}`;
  return (
    <div style={{ marginBottom: NAV_ROW_GAP }}>
      <button
        type="button"
        onClick={() => onNavigate(href)}
        title={iconOnly ? row.label : undefined}
        aria-label={row.label}
        data-nav-row="item"
        data-nav-entity={row.entityKind}
        className={cx(
          ITEM_SHELL,
          iconOnly && "justify-center px-0",
          active ? L1_ROW_SELECTED : L1_ROW_IDLE,
        )}
      >
        <Icon
          name={row.icon}
          size={14}
          className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`}
          style={row.iconColor ? { color: row.iconColor } : undefined}
        />
        {iconOnly ? null : <span className="flex-1 truncate text-left">{row.label}</span>}
      </button>
    </div>
  );
}
