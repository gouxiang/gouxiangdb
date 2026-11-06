// M3/S9 二级导航（N3 二级 P0）。
//
// 第三批导航重构后的语义：**二级 = 一级选中容器的子项**（用户的规则）。
//   选中数据库（base）  → 该库下的**数据表**列表；
//   选中知识库（kb）    → 「文档 / 画布」两个选项卡 + 对应列表。
// 右侧主区只按二级选中项渲染（路由即真源，R-N-02）。
//
// 数据源因此不再走 nav tree + menu_items 的「收纳/未收纳」派生
// （buildCollection / usePatchMenu / 「收纳到导航」入口已下线），
// 而是直接用资源本体的既有查询：useTables(baseId) 与 useKbDocs(kbId, kind)。
// 两者都是页面上已经在用的缓存（库首页 / 表格页同源），这里不新增请求。
//
// 保留下来不许丢的能力：S10 窗口化（useMenuVirtualizer，DOM 有界）、
// 面板收起展开（由壳层持有）、R-I-16 表级操作行、doc 段按 parentId 层级展开。
// useEffect 仅用于「挂载后才允许收展过渡」：SSR/首帧直接落到目标宽度，不播动画。
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { useMatch, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import { Spinner } from "../../components/ui";
import { resolveEntityIcon, resolvedEntityColor, type EntityIconIndex } from "../../components/EntityIconPicker";
import { useTables } from "../../api/hooks";
import { useKbDocs } from "../kb/kb-hooks";
import type { KbDocDTO } from "../../api/client";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";
import {
  buildSecondaryRows,
  secondaryEmptyText,
  SecondaryRow,
  SECONDARY_ROW_H,
  type SecondaryEntry,
  type SectionKind,
} from "./SecondaryNavSections";
// 第四批：把旧壳失联的表操作与 KB 文档层级能力接回 L2（各自带自己的 hooks 与弹窗，
// 本文件只装配，避免把数据层、操作层、弹窗状态全塞进一个文件）。
import { useSecondaryTableOps } from "./SecondaryNavTableOps";
import { useSecondaryKbOps } from "./SecondaryNavKbOps";
import { TableActionRow } from "./TableActionRow";
import { LibraryOpsButton } from "./LibraryOpsButton";
import { L2_WIDTH } from "./lib/l1-collapse";

/** 知识库二级的两个选项卡（顺序固定：文档在前）。 */
const KB_TABS: { kind: SectionKind; label: string }[] = [
  { kind: "doc", label: "文档" },
  { kind: "canvas", label: "画布" },
];

/** 二级容器：一级选中项本体（base / kb）。 */
export interface SecondaryContainer {
  kind: "base" | "kb";
  id: string;
  name: string;
}

/** 列表按名称本地过滤（区分度只看名字；后端 q 由其主页自己用）。 */
function filterByName<T extends { name?: string; title?: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => (r.name ?? r.title ?? "").toLowerCase().includes(q));
}

export function SecondaryNav({
  container,
  onClose,
  onExpand,
  variant = "static",
  width = L2_WIDTH,
  collapsed = false,
  entityIcons,
  libraryCanManage = false,
  onRenameLibrary,
}: {
  container: SecondaryContainer;
  onClose: () => void;
  /**
   * static 档展开态点击单颗骑缝钮时由壳层展开（宽度 0 → 236 带过渡）。
   * floating/drawer 档不用：那两档面板由壳层按 showL2 条件挂载，唤回入口在 L1 底部。
   */
  onExpand?: () => void;
  /**
   * static   ：骨架 S-1 常驻栏（≥1440 / 1280–1439），在流内占位。
   * floating ：R-D-31 / R-D-32「浮出面板」——768–1279 由壳层绝对定位到内容区左侧，
   *            覆盖内容而不挤压内容宽度（浮层带阴影，符合「浮出面板」语义）。
   */
  variant?: "static" | "floating";
  /** 面板宽度；v6 S2 起所有响应式档恒为 L2_WIDTH（底板 .l2 = 236），壳层不再分档传值。 */
  width?: number;
  /**
   * static 档收展态（底板 .app.l2-collapsed）：true 时 wrap 宽度动画到 0、inner 淡出，
   * 单颗骑缝钮箭头旋转 180°。floating/drawer 档恒为 false（面板随挂载显隐，不做宽度动画）。
   */
  collapsed?: boolean;
  /**
   * base/kb 实体自定义图标索引（壳层装配后传入，理由同 PrimaryNav：
   * 本组件的多份 SSR 回归不带 QueryClientProvider，不能在组件内直接取「实体列表」的 mock）。
   * 未自定义时不传色，面板头维持纯文本形态。
   */
  entityIcons?: EntityIconIndex;
  /**
   * v6 S1：库级操作（重命名 / 设置）从 L1 行尾菜单迁到 L2 面板头。
   * false（默认，兼容不传新 props 的旧 SSR 回归）时头部「库操作」钮整个不渲染。
   */
  libraryCanManage?: boolean;
  /** 「重命名」由壳层处理（需 QueryClient）；不传时菜单里只保留「设置」。 */
  onRenameLibrary?: (kind: "base" | "kb", id: string, name: string) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  // static 档收展过渡只在客户端挂载后启用：SSR/首帧（readL2Collapsed 恒 null）直接落到
  // 目标宽度、不带 transition，避免 hydrate 后从展开态播一段「收起」的误动画。
  // 同时尊重系统「减弱动态效果」：开启时宽度/透明度也不播（CSS 媒体查询关不掉内联 transition）。
  const [animatable, setAnimatable] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setAnimatable(!mq.matches);
  }, []);

  // 路由作用域用 useMatch 而非 useParams：本组件挂在无 path 的壳层路由下，
  // useParams 取到的是布局路由自身的 params（恒为空），无法还原当前表/文档。
  const tableMatch = useMatch("/base/:baseId/table/:tableId/*");
  const viewMatch = useMatch("/base/:baseId/table/:tableId/view/:viewId");
  const docMatch = useMatch("/kb/:kbId/doc/:docId");
  const canvasMatch = useMatch("/kb/:kbId/canvas/:docId");
  const currentResource =
    tableMatch?.params.tableId ?? docMatch?.params.docId ?? canvasMatch?.params.docId ?? null;

  /**
   * 知识库选项卡：路由即真源（R-N-02），由 canvas/doc 路由反推。
   *
   * 修 P0-⑤：此前 kbTab 是纯本地 state（默认 "doc"）且从不与路由同步，打开
   * /kb/:kbId/canvas/:docId 时 L2 停在「文档」tab —— 画布行既不在数据源里也不在
   * 列表里，表现为「进画布编辑 L2 跳回文档列表、选中态丢失」。
   *
   * 两个刻意的选择：
   *  ① 渲染期派生而不是 useEffect —— SSR 首帧与路由切换同帧即为正确 tab，
   *     不会出现「先渲染文档列表、effect 后再跳到画布」的闪动；
   *  ② 手动点 tab 只在当前路由内有效（记住 routeKey），路由一变即回归路由真源，
   *     用户手动翻 tab 的自由不丢，也不会把下一次进画布带偏。
   */
  const routeTab: SectionKind | null = canvasMatch ? "canvas" : docMatch ? "doc" : null;
  const routeKey = canvasMatch?.params.docId ?? docMatch?.params.docId ?? "";
  const [manualTab, setManualTab] = useState<{ key: string; tab: SectionKind } | null>(null);
  const kbTab: SectionKind =
    manualTab && manualTab.key === routeKey ? manualTab.tab : (routeTab ?? "doc");

  const baseId = container.kind === "base" ? container.id : null;
  const kbId = container.kind === "kb" ? container.id : null;

  // 两个查询都按 enabled 互斥：选中 base 时不会去拉 kb 的文档，反之亦然。
  const tablesQ = useTables(baseId);
  // kb 拉全量（"all"）：tab 只做本地过滤。配合上面「路由反推 tab」，从文档页进画布页时
  // 不会换 queryKey 重取一次（无 loading 闪烁），且当前画布行一定在数据里 —— 选中态不会丢。
  const docsQ = useKbDocs(kbId ?? undefined, kbId ? "all" : undefined);

  const loading = container.kind === "base" ? tablesQ.isLoading : docsQ.isLoading;
  const error = container.kind === "base" ? tablesQ.isError : docsQ.isError;

  /** 数据源 → SecondaryEntry（统一行模型交给行组件渲染）。 */
  const entries = useMemo<SecondaryEntry[]>(() => {
    if (container.kind === "base") {
      const rows = tablesQ.data ?? [];
      return filterByName(rows, query).map((t) => ({
        id: t.id,
        name: t.name,
        kind: "table" as const,
        parentId: null,
        href: `/base/${t.baseId}/table/${t.id}`,
        icon: t.icon,
        iconColor: t.iconColor,
      }));
    }
    // 两个数据源跑同一个「按名字本地过滤」口径：后端 q 由各资源主页自己用，
    // 这里只筛当前容器的子项，本地过滤足够且不引入额外请求。
    const docs = docsQ.data ?? [];
    return filterByName(docs, query).map((d) => toDocEntry(d, container.id));
  }, [container.kind, container.id, tablesQ.data, docsQ.data, query]);

  /**
   * 第四批：行操作 / 新建能力（旧壳失联的那批入口）。
   * 两个 hook 都常驻调用（base 容器下 KB 那条也不取数，参数为空即 enabled:false）；
   * 数据源是上面同一份 entries，不新增请求。
   */
  const tableOps = useSecondaryTableOps({
    baseId,
    activeTableId: tableMatch?.params.tableId ?? null,
    navigate,
  });
  // tab 只在文档/画布两档之间（base 容器下不会有 kb 行，取 doc 只是类型兜底）
  const kbOps = useSecondaryKbOps({
    kbId,
    tab: kbTab === "canvas" ? "canvas" : "doc",
    navigate,
    docs: entries,
    // 仅知识库路由下有当前文档/画布；base 容器下恒为 null（kb 行菜单也不会被触发）。
    activeDocId: docMatch?.params.docId ?? canvasMatch?.params.docId ?? null,
  });

  /** kb 才有的 doc 层级：子文档折叠由 expandedDocs 控制。 */
  const docChildren = useMemo(() => {
    const m = new Map<string, SecondaryEntry[]>();
    if (container.kind !== "kb" || kbTab !== "doc") return m;
    for (const e of entries) {
      // 数据源是全量（doc + canvas），层级只按文档算：画布不参与 doc 段的父子折叠
      if (e.kind !== "doc") continue;
      const pid = e.parentId;
      if (!pid) continue;
      const arr = m.get(pid) ?? [];
      arr.push(e);
      m.set(pid, arr);
    }
    return m;
  }, [entries, container.kind, kbTab]);

  const flatRows = useMemo(
    () => buildSecondaryRows(kindGroups(entries, kbTab), expandedDocs, docChildren),
    [entries, kbTab, expandedDocs, docChildren],
  );
  const virt = useMenuVirtualizer(flatRows, SECONDARY_ROW_H);

  const toggleDoc = (id: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 面板头图标：实体自定义了图标才显示（未自定义维持纯文本一行，与改动前一致）。
   * 索引 key 现在直接是资源 id（第三批后不再绕 nav node.resourceId）。
   */
  const headerEntity = entityIcons?.get(container.id) ?? null;
  const headerIcon = headerEntity
    ? resolveEntityIcon(headerEntity, { name: container.kind === "base" ? "database" : "book" })
    : { name: (container.kind === "base" ? "database" : "book") as IconName, color: undefined };
  const headerColor = resolvedEntityColor(headerEntity);
  const emptyText = secondaryEmptyText(container.kind === "base" ? "table" : kbTab, query);
  const empty = flatRows.length === 0;

  return (
    // v6 #1003：底板 .l2-wrap（data-table.html 600 / shared.css 342）——position:relative、
    // flex:none、自身不设宽。宽度动画在内部 aside（.gx-l2）上：收起 0 ↔ 展开 236、.3s 缓动，
    // aside overflow:hidden 裁掉定宽 236 的 inner（内容不被挤压）。骑缝钮是 wrap 的兄弟节点，
    // 宽 0 时仍定位在 wrap 右缘。floating/drawer 档 aside 恒 236（面板由壳层条件挂载）。
    <div
      className="gx-l2-wrap"
      data-l2={variant === "static" ? "static-wrap" : "floating-inner"}
      data-l2-collapsed={variant === "static" && collapsed ? "true" : undefined}
    >
    <aside
      className={clsx("gx-l2", variant === "floating" && "shadow-gx-lg")}
      data-l2-scope={container.kind}
      id={`gx-l2-panel-${container.kind}`}
      style={{
        width: variant === "static" ? (collapsed ? 0 : width) : width,
        transition: animatable ? "width .3s cubic-bezier(.4,0,.2,1)" : "none",
      }}
    >
      <div
        className="gx-l2-inner flex h-full flex-col bg-gx-nav2"
        style={{
          width,
          opacity: variant === "static" && collapsed ? 0 : 1,
          transition: animatable ? "opacity .22s ease" : "none",
        }}
      >
      {/* v6 S2 面板头（底板 .l2-h，375–386 行）：56px 与主区顶栏同高，padding 12/8。 */}
      <div className="flex h-[56px] shrink-0 items-center gap-[7px] border-b border-gx-hairline pl-3 pr-2">
        <span className="gx-l2-ico">
          <Icon
            name={headerIcon.name}
            size={14}
            style={headerColor ? { color: headerColor } : undefined}
          />
        </span>
        <span className="gx-l2-title" title={container.name}>
          {container.name}
        </span>
        {/* 库类型徽标：底板 .tag.tag-gray 原型只有一个灰字「库」；产品区分数据库/知识库，
            保留既有语义（派工单唯一授权的语义化微调），样式逐字照底板。 */}
        <span className="gx-l2-tag">{container.kind === "base" ? "数据库" : "知识库"}</span>
        {/*
          v6 S1：库级操作「⋯」（重命名 / 设置）从 L1 行尾迁到 L2 面板头，常驻可见。
          底板 .l2-act margin-left:auto；骑缝收起圆箭头在容器外 right:-13px，二者不重叠。
          无管理权限（libraryCanManage=false）时整个不渲染。
        */}
        <div className="ml-auto">
          {libraryCanManage && (
            <LibraryOpsButton container={container} onRenameLibrary={onRenameLibrary} />
          )}
        </div>
      </div>
      {/* v6 S2 搜索框（底板 .l2-search，387–393 行）：保留真实受控 input，只换外壳。 */}
      <div className="gx-l2-search">
        <Icon name="search" size={13} className="shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索数据表"
          aria-label="搜索数据表"
        />
      </div>
      {/* 知识库专有：文档 / 画布 两个选项卡 + 按 tab 的「新建」入口（底板无 tabs，属产品
          既有功能：结构与 a11y 不动，仅把容器左右边距与搜索框对齐为 10px）。
          数据库没有第二种子内容，改为渲染「+ 新建数据表」（.gx-l2-new 自带 10px 边距）。
          tablist 只包住两个 tab，新建按钮是它的兄弟节点——它不是选项卡，不该进 tablist。 */}
      {container.kind === "kb" ? (
        <>
        <div className="mt-1.5 flex items-center gap-1 px-2.5">
          <div className="flex items-center gap-1" role="tablist" aria-label="知识库内容类型">
            {KB_TABS.map((t) => (
              <button
                key={t.kind}
                type="button"
                role="tab"
                aria-selected={kbTab === t.kind}
                onClick={() => setManualTab({ key: routeKey, tab: t.kind })}
                className={[
                  "rounded-full px-2 py-0.5 text-gx-12 transition-colors",
                  kbTab === t.kind
                    ? "bg-white font-semibold text-gx-accent"
                    : "text-gx-text-secondary hover:bg-gx-row-hover",
                ].join(" ")}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex shrink-0 items-center">{kbOps.createNode}</div>
        </div>
        {/* 文档 / 画布行菜单的重命名 / 图标与颜色弹窗（删除确认走全局 ConfirmHost）。
            两个 Modal 在 open=false 时返回 null，常驻挂载不产生 DOM。 */}
        {kbOps.menuNode}
        </>
      ) : (
        tableOps.panelNode
      )}

      {/* R-I-16 表级操作行挂载点（表级能力，不在顶栏也不在表格工具栏）。
          导入 / 导出已收敛到网格工具栏常驻按钮，「分享数据」规划占位已下线，
          故本行当前无入口可挂、渲染为空；仅当前路由落在某张表上时才有挂载上下文，
          库首页 / 知识库 / 工作区路由下不占位。 */}
      <TableActionRow
        tableId={tableMatch?.params.tableId ?? null}
        viewId={viewMatch?.params.viewId ?? null}
        baseId={tableMatch?.params.baseId ?? null}
      />

      {/* v6 S2 列表区（底板 .l2-list，407 行）：滚动体自带 8px 两侧 padding。 */}
      <div ref={virt.scrollerRef} className="gx-l2-list">
        {loading ? (
          <div className="flex h-24 items-center justify-center"><Spinner size={16} /></div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-gx-12 text-gx-text-hint">内容加载失败，请重试</div>
        ) : (
          <>
            {/* 文档段的「回到顶级」落区（KB + 文档 tab 才有；无写权限不渲染）。
                与旧 KbTree 同一套落区样式思路，颜色走 gx-* 令牌。
                P0-④：仅拖拽进行中才进 DOM。此前常驻渲染、靠 border/text-transparent
                藏起来，盒子照常占位（≈36px 空白条），知识库文档列表顶部因此空一大片。 */}
            {container.kind === "kb" && kbTab === "doc" && kbOps.canCreate && kbOps.dragActive && (
              <div
                onDragOver={kbOps.rootZone.onDragOver}
                onDrop={kbOps.rootZone.onDrop}
                data-drop-root={kbOps.rootZone.active ? "true" : undefined}
                className={[
                  "mx-0 mb-1 rounded-gx-sm border border-dashed px-2 py-1 text-center text-gx-11 transition-colors",
                  kbOps.rootZone.active
                    ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
                    : "border-transparent text-transparent",
                ].join(" ")}
              >
                拖到此处移到顶级
              </div>
            )}
            {/* 窗口垫片：.gx-l2-list 已带两侧 8px padding，这里只保留垂直 padTop/padBottom。
                v6 #1003：段头整类下线，序列里只剩实体行（33px 步距不变）。 */}
            <div style={{ paddingTop: virt.padTop, paddingBottom: virt.padBottom }}>
              {virt.windowed.map((row) => (
                <SecondaryRow
                  key={row.entry.id}
                  kind={row.kind}
                  entry={row.entry}
                  depth={row.depth}
                  hasDocKids={row.hasDocKids}
                  expanded={row.expanded}
                  active={currentResource === row.entry.id}
                  onToggleDoc={toggleDoc}
                  onNavigate={(href) => navigate(href)}
                  // 表行 → 表操作菜单；文档 / 画布行 → KB 行菜单（重命名 / 图标与颜色 / 删除）。
                  // 无对应写权限时各自的 rowMenuItems 返回 [] → RowMoreMenu 只占位不渲染三点。
                  // 透传当前自定义图标，供「图标与颜色」项弹窗回显。
                  menu={
                    row.kind === "table"
                      ? tableOps.rowMenuItems({
                          id: row.entry.id,
                          name: row.entry.name,
                          icon: row.entry.icon,
                          iconColor: row.entry.iconColor,
                        })
                      : kbOps.rowMenuItems({
                          id: row.entry.id,
                          name: row.entry.name,
                          kind: row.kind,
                          icon: row.entry.icon,
                          iconColor: row.entry.iconColor,
                        })
                  }
                  // P3-a11y：按行类型给具体作用名（同旧壳 KbTree「文档/画布操作菜单」口径）。
                  menuLabel={
                    row.kind === "table"
                      ? `${row.entry.name} 表操作菜单`
                      : `${row.entry.name} ${row.kind === "canvas" ? "画布" : "文档"}操作菜单`
                  }
                  // 文档行：拖拽改层级（画布行不给）
                  drag={row.kind === "doc" ? kbOps.rowDrag(row.entry.id) : undefined}
                />
              ))}
            </div>
            {empty && <div className="px-4 py-8 text-center text-gx-12 text-gx-text-hint">{emptyText}</div>}
          </>
        )}
      </div>

      {/* v6 #1003：回收站移到滚动列表之外的固定脚（底板 .l2-foot，shared.css 436 / DOM 706）。
          flex:none + 顶部分隔线，不随列表滚动；loading/error 态也常驻。 */}
      <div className="gx-l2-foot">
        <button
          type="button"
          onClick={() =>
            navigate(
              container.kind === "base"
                ? `/base/${container.id}/trash`
                : `/kb/${container.id}/trash`,
            )
          }
          title="回收站"
          data-l2-trash={container.kind}
          className="gx-l2-sub"
        >
          <Icon name="trash" size={14} className="shrink-0" />
          <span className="nm truncate">回收站</span>
        </button>
      </div>
        </div>
    </aside>

      {/*
        v6 #1003：单颗骑缝圆钮（底板 .l2-toggle，DOM 712 / shared.css 358–375）。
        它是 wrap 内 aside 之后的兄弟节点，恒 right:-13px 骑在面板右缘中线上，宽度动画时
        自动跟随、无需硬编码 left；展开态箭头朝左（向左收起），收起态整枚 svg rotate(180°)
        变朝右（向右拉回）。仅 static 档渲染：floating/drawer 档唤回入口在 L1 底部。
        层级 gx-z-drawer：高过业务内容、低于应用弹层（form-designer-layer 裁决锁定）。
      */}
      {variant === "static" && (
        <button
          type="button"
          aria-label={collapsed ? "展开二级面板" : "收起二级面板"}
          title={collapsed ? "展开二级面板" : "收起二级面板"}
          aria-expanded={!collapsed}
          aria-controls={`gx-l2-panel-${container.kind}`}
          onClick={collapsed ? onExpand : onClose}
          className="gx-l2-toggle gx-z-drawer"
        >
          <Icon name="chevronLeft" size={15} />
        </button>
      )}
    </div>
  );
}

/** KbDocDTO → 二级条目（href 按 kind 分流到 doc / canvas 路由）。 */
function toDocEntry(d: KbDocDTO, kbId: string): SecondaryEntry {
  return {
    id: d.id,
    name: d.title,
    kind: d.kind === "canvas" ? "canvas" : "doc",
    parentId: d.parentId ?? null,
    href: d.kind === "canvas" ? `/kb/${kbId}/canvas/${d.id}` : `/kb/${kbId}/doc/${d.id}`,
    icon: d.icon ?? null,
    iconColor: d.iconColor ?? null,
  };
}

/**
 * 当前视图的行分组。
 * 数据库：全部行都是表，只有 table 段；
 * 知识库：只显示当前选项卡那一段（文档 / 画布互斥，不再三段同列）。
 */
function kindGroups(entries: SecondaryEntry[], kbTab: SectionKind): Record<SectionKind, SecondaryEntry[]> {
  return {
    table: entries.filter((e) => e.kind === "table"),
    doc: kbTab === "doc" ? entries.filter((e) => e.kind === "doc") : [],
    canvas: kbTab === "canvas" ? entries.filter((e) => e.kind === "canvas") : [],
  };
}
