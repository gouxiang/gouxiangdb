// 一级导航（L1）—— v6「恒 76px 轻量拟物图标轨」（2026-10 UI 重做 S1）。
//
// 视觉契约（逐像素底板，不得自由发挥）：
//   docs/design/2026-10-ui-redesign/actual/v6/src/shared.css
//   .rail / .rail-mark / .rail-sep / .rail-nav / .rail-item / .rd / .nm / .rail-foot
//   （底板 72–181 行）。组件源码零 hex：渐变 / 阴影 / 圆角 / 轨道表面全部写成
//   src/index.css 的 .gx-rail-* 类，本文件只挂类名 + 现成 gx-* token 类。
//
// 数据契约（不许丢的红线）：
//   - L1 **只放「数据库 + 知识库」**：数据仍由 buildLibraryRows(bases, kbs) 产出，
//     分组行（kind:'group'）在数据层保留、在表层**永不渲染**——库列表读作连续的一条，
//     但行上挂 data-grp="base|kb" 保留分组契约；
//   - L1 里不得出现任何二级内容（表 / 文档 / 画布一律不在此渲染）；
//   - 数据由壳层（WorkspaceShell）以 props 注入：本组件跑在多份不带
//     QueryClientProvider 的 SSR 回归里，组件内不能直接用 useQuery；
//   - href 模板仍是 /base/:id 与 /kb/:id（旧链 N5 不改名）。
//
// S1 相对旧版的变化：
//   - L1 折叠档（196/56 两档）永久废止，轨道恒定 76px（lib/l1-collapse.ts 只导几何常量）；
//   - 品牌区改为 36×36 favicon 砖（点击回首页）+ 26×1 分隔线，不随列表滚动；
//   - 建库入口移到轨道底部 RailFoot 的实心蓝钮（见 WorkspaceShell），本组件不再持有；
//   - 行尾「…」库操作菜单（重命名 / 设置）迁到 L2 面板头（见 SecondaryNav）；
//   - 砖步进 68（RAIL_TILE_ROW_H 65 + RAIL_ROW_GAP 3），窗口化沿用 useMenuVirtualizer。
//
// 「个人用户」规划入口（个人门户 / 我的待办 / 我的收藏）本阶段不启用，轨道上不渲染
// （与侧栏底部个人信息栏同一处置口径）；需要恢复时从旧版 PrimaryNav 取回。
import { useMemo } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  buildLibraryRows,
  RAIL_TILE_ROW_H,
  RAIL_ROW_GAP,
  type LibraryEntity,
  type LibraryNavRow,
} from "./lib/menu-sections";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";

// navKindIcon 已下沉到 lib/menu-sections（L1 / L2 / 权限资源树共用同一份映射）。
// 这里原样转出，既有 import { navKindIcon } from "./PrimaryNav" 的调用点
// （authz/PermNodeTree.tsx、SecondaryNavSections.tsx）全部不受影响。
export { navKindIcon } from "./lib/menu-sections";

/** 砖步进：砖行 65 + 行距 3（窗口化定高切片的单一真源，见 menu-sections 注释）。 */
const RAIL_STEP = RAIL_TILE_ROW_H + RAIL_ROW_GAP;

/**
 * 一级导航：图标轨。
 *
 * 点某个库只做跳转到 /base/:id 或 /kb/:id，二级归属由 URL 反推（壳层 R-N-02），
 * 本组件不持有任何二级状态。
 */
export function PrimaryNav({
  bases = [],
  kbs = [],
  loading = false,
  error = false,
  onPeekCurrent,
}: {
  /** 数据库列表（壳层 useBases() 的结果）。 */
  bases?: readonly LibraryEntity[];
  /** 知识库列表（壳层 useKbList() 的结果）。 */
  kbs?: readonly LibraryEntity[];
  /** 两个列表任一在 loading。 */
  loading?: boolean;
  /** 两个列表任一读取失败。 */
  error?: boolean;
  /**
   * 浮出/抽屉档且 L2 收起时，点击「当前所在容器」临时唤出 L2（会话态、换路由复位）。
   * 由壳层在满足条件时注入；不传或点的不是当前行则仍是纯导航。纯 UI 状态，无数据查询。
   */
  onPeekCurrent?: () => void;
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

  // 分组行永久不渲染（底板契约：分组不画线，但数据层 buildLibraryRows 仍产出 group 行；
  // data-grp 挂在 item 上保留分组归属）。base 组在前 kb 在后的顺序由数据层保证。
  const rows = useMemo<LibraryNavRow[]>(
    () => buildLibraryRows(bases, kbs).filter((r) => r.kind !== "group"),
    [bases, kbs],
  );

  const virt = useMenuVirtualizer<LibraryNavRow>(rows, RAIL_STEP, 12);

  return (
    <div className="flex h-full min-h-0 flex-col items-center">
      {/* ① 品牌区：favicon 砖点击回首页；常驻轨道顶部，不随列表滚动。
          src 走 BASE_URL 前缀：飞牛 fnOS 子路径部署不能写死 "/favicon.svg"。 */}
      <button
        type="button"
        title="回到首页"
        aria-label="回到首页"
        onClick={() => navigate("/")}
        className="shrink-0"
      >
        <span className="gx-rail-mark">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            width={36}
            height={36}
            alt="构想工作台"
          />
        </span>
      </button>
      <div className="gx-rail-sep" aria-hidden />

      {/* ② 主导航（库）：自身窗口化滚动（S10 大菜单 DOM 有界）。 */}
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : error ? (
        // 轨道仅 76 宽：降级为一枚小字砖 + title，不渲染长句。
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <span className="gx-rail-tile text-gx-13 font-semibold" title="导航加载失败，刷新重试">
            !
          </span>
        </div>
      ) : (
        <div ref={virt.scrollerRef} className="gx-rail-nav min-h-0 flex-1">
          {/*
            无 gap：行距由每行自己的 marginBottom 承担，窗口化的 padTop/padBottom
            才能逐像素对齐。窗口占位之外各加 4/8px 呼吸（.gx-rail-nav 的内置 padding
            同值，内联只在有窗口占位时覆盖为「占位 + 呼吸」）。
          */}
          <nav
            className="flex flex-col items-center"
            style={{ paddingTop: virt.padTop + 4, paddingBottom: virt.padBottom + 8 }}
          >
            {virt.windowed.map((row) =>
              row.kind === "group" ? null : (
                <RailTile
                  key={row.id}
                  row={row}
                  active={row.entityId === activeEntityId}
                  onNavigate={navigate}
                  onPeekCurrent={onPeekCurrent}
                />
              ),
            )}
          </nav>
        </div>
      )}
      {/* 空态（rows=0）不渲染文字块：建库入口在轨道底部常驻可达。 */}
    </div>
  );
}

/**
 * 图标轨砖行：36×36 拟物图标砖 + 10.5px 砖名。
 *
 * 选中态走 .is-active（淡品牌底 + 凹槽砖），未选中是可点击的薄凸起；
 * 不挂任何行尾菜单——库级「重命名 / 设置」已迁到 L2 面板头（S1）。
 */
function RailTile({
  row,
  active,
  onNavigate,
  onPeekCurrent,
}: {
  row: Extract<LibraryNavRow, { kind: "item" }>;
  active: boolean;
  onNavigate: (href: string) => void;
  /** 仅壳层处于浮出/抽屉档且 L2 收起时注入：点当前行临时唤出 L2，不导航。 */
  onPeekCurrent?: () => void;
}) {
  const href = row.entityKind === "base" ? `/base/${row.entityId}` : `/kb/${row.entityId}`;
  const className = ["gx-rail-item", active ? "is-active" : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      onClick={() => {
        // 点当前所在容器且壳层给了 peek 口 → 临时唤出 L2（不重复导航到同一路由）；
        // 点别的库仍是普通跳转。
        if (active && onPeekCurrent) {
          onPeekCurrent();
          return;
        }
        onNavigate(href);
      }}
      title={row.label}
      aria-label={row.label}
      data-nav-row="item"
      data-nav-entity={row.entityKind}
      // 底板契约：分组不画线，但 data-grp 保留分组归属（base/kb）。
      data-grp={row.entityKind}
      className={className}
      style={{ marginBottom: RAIL_ROW_GAP }}
    >
      <span className="gx-rail-tile">
        <Icon name={row.icon} size={17} style={row.iconColor ? { color: row.iconColor } : undefined} />
      </span>
      <span className="gx-rail-nm">{row.label}</span>
    </button>
  );
}
