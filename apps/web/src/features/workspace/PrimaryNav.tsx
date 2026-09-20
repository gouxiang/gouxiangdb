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
import { useMemo, useState, type ReactNode } from "react";
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
import { RowMoreMenu, type RowMoreItem } from "./SecondaryNavSections";
import { PrimaryNavRenameModal, type RenameTarget } from "./PrimaryNavRenameModal";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";

/** 浏览态一级行固定行高 32（窗口化与视觉节奏的同一真源，见 lib/menu-sections）。 */
export const NAV_ROW_H = NAV_ITEM_ROW_H;

/** 全站菜单行过渡：150ms ease-out。 */
export const NAV_ROW_TRANSITION = "transition-colors duration-150 ease-out";

/** 拼类名并过滤空片段（避免条件片段留双空格）。 */
const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// navKindIcon 已下沉到 lib/menu-sections（L1 / L2 / 权限资源树共用同一份映射）。
// 下沉的另一个目的：本文件要从 SecondaryNavSections 复用 RowMoreMenu（L1 行尾「…」），
// 而后者反向 import 了 navKindIcon —— 留在原地会构成一个真循环依赖。
// 这里原样转出，既有 import { navKindIcon } from "./PrimaryNav" 的调用点全部不受影响。
export { navKindIcon } from "./lib/menu-sections";

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
  onRename,
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
  /**
   * 行尾「…」菜单里的「重命名」。改名要写库 + 失效列表缓存，两边都要 QueryClient，
   * 因此同样由壳层以回调注入（本组件不能 useMutation，理由同 useQuery）。
   * 不传时菜单里只保留「设置」一项。
   */
  onRename?: (kind: "base" | "kb", id: string, name: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  // 重命名弹窗挂在导航这一层（而不是每行各挂一个）：同一时刻只会有一个在改，
  // 且窗口化下被卸载的行不会带走未提交的弹窗状态。
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
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
              onRename={onRename ? (r) => setRenaming({ kind: r.entityKind, id: r.entityId, name: r.label }) : undefined}
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

      {/* key 随目标库切换：弹窗的输入初值靠挂载时取，换一行重命名必须重挂，
          否则会带着上一行改了一半的名字。 */}
      <PrimaryNavRenameModal
        key={renaming?.id ?? ""}
        target={renaming}
        onClose={() => setRenaming(null)}
        onRename={onRename}
      />
    </div>
  );
}

/**
 * 分组标题行 / 库入口行（两态）。
 *
 * 行尾「…」菜单（重命名 / 设置）——工作区设置里的「资产」分区下线后，
 * 单个库的深度设置改从这里进入。两条显隐规则：
 *   · 折叠档（iconOnly）：不渲染。折叠态的行只剩一个居中图标，塞按钮会挤掉图标，
 *     且窗口化行高按 32 算，多一层会让折叠态视觉失衡；
 *   · 本人无管理角色（canManage 假）：菜单项为空数组 —— RowMoreMenu 会退化成一个
 *     20×20 占位 span，行宽行高不跳变（不给无权限的人看到管理入口，也不留空洞）。
 * 菜单里**不放任何权限项**：权限已统一收敛到「工作区设置 → 权限管理」。
 */
function LibraryRow({
  row,
  active,
  iconOnly,
  onNavigate,
  onRename,
}: {
  row: LibraryNavRow;
  active: boolean;
  iconOnly: boolean;
  onNavigate: (href: string) => void;
  /** 不传（壳层没注入重命名回调）时菜单里只有「设置」。 */
  onRename?: (row: Extract<LibraryNavRow, { kind: "item" }>) => void;
}) {
  if (row.kind === "group") {
    return <GroupHeaderRow label={row.label} iconOnly={iconOnly} />;
  }
  const href = row.entityKind === "base" ? `/base/${row.entityId}` : `/kb/${row.entityId}`;
  const isKb = row.entityKind === "kb";
  const items: RowMoreItem[] = row.canManage
    ? [
        ...(onRename ? [{ icon: "edit" as IconName, label: "重命名", onClick: () => onRename(row) }] : []),
        {
          icon: "settings" as IconName,
          label: "设置",
          description: isKb ? "打开知识库设置" : "打开数据库设置",
          onClick: () => onNavigate(isKb ? `/kb/${row.entityId}/settings` : `/base/${row.entityId}/settings`),
        },
      ]
    : [];

  return (
    <div style={{ marginBottom: NAV_ROW_GAP }}>
      {/* 跳转按钮与「…」是兄弟节点，不是父子：嵌套 button 是非法 HTML，
          且点「…」会连带触发整行跳转。 */}
      <div className={cx("flex items-center gap-1", iconOnly && "justify-center")}>
        <button
          type="button"
          onClick={() => onNavigate(href)}
          title={iconOnly ? row.label : undefined}
          aria-label={row.label}
          data-nav-row="item"
          data-nav-entity={row.entityKind}
          className={cx(
            ITEM_SHELL,
            "min-w-0 flex-1",
            iconOnly && "w-8 flex-none justify-center px-0",
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
        {iconOnly ? null : (
          <RowMoreMenu items={items} label={`${isKb ? "知识库" : "数据库"}操作 ${row.label}`} />
        )}
      </div>
    </div>
  );
}
