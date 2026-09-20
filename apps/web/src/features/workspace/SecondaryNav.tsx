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
import { useMemo, useState } from "react";
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
  SectionHeader,
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
  variant = "static",
  width = L2_WIDTH,
  entityIcons,
}: {
  container: SecondaryContainer;
  onClose: () => void;
  /**
   * static   ：骨架 S-1 常驻栏（≥1440 / 1280–1439），在流内占位。
   * floating ：R-D-31 / R-D-32「浮出面板」——768–1279 由壳层绝对定位到内容区左侧，
   *            覆盖内容而不挤压内容宽度（浮层带阴影，符合「浮出面板」语义）。
   */
  variant?: "static" | "floating";
  /** 面板宽度；R-D-30 档由壳层传 208，缺省仍是规范 240。 */
  width?: number;
  /**
   * base/kb 实体自定义图标索引（壳层装配后传入，理由同 PrimaryNav：
   * 本组件的多份 SSR 回归不带 QueryClientProvider，不能在组件内直接取「实体列表」的 mock）。
   * 未自定义时不传色，面板头维持纯文本形态。
   */
  entityIcons?: EntityIconIndex;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());

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
    <aside
      className={clsx(
        "flex h-full shrink-0 flex-col border-r border-gx-hairline bg-gx-nav2",
        variant === "floating" && "shadow-gx-lg",
      )}
      style={{ width }}
      data-l2-scope={container.kind}
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-gx-hairline px-3.5">
        <Icon
          name={headerIcon.name}
          size={15}
          className="shrink-0"
          style={headerColor ? { color: headerColor } : undefined}
        />
        <span className="flex-1 truncate text-gx-14 font-semibold text-gx-text-primary" title={container.name}>
          {container.name}
        </span>
        <button
          type="button"
          aria-label="收起二级面板"
          title="收起二级面板"
          aria-expanded
          onClick={onClose}
          className="rounded-gx-sm p-1 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="border-b border-gx-separator px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-gx-sm border border-gx-separator bg-gx-surface px-2 py-1">
          <Icon name="search" size={13} className="shrink-0 text-gx-text-hint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选当前列表…"
            className="min-w-0 flex-1 bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
        </div>
        {/* 知识库专有：文档 / 画布 两个选项卡 + 按 tab 的「新建」入口。
            数据库没有第二种子内容，改为渲染「+ 新建数据表」（同一位置、同一规格）。
            tablist 只包住两个 tab，新建按钮是它的兄弟节点——它不是选项卡，不该进 tablist。 */}
        {container.kind === "kb" ? (
          <div className="mt-2 flex items-center gap-1">
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
        ) : (
          tableOps.panelNode
        )}
      </div>

      {/* R-I-16 表级操作行挂载点（表级能力，不在顶栏也不在表格工具栏）。
          导入 / 导出已收敛到网格工具栏常驻按钮，「分享数据」规划占位已下线，
          故本行当前无入口可挂、渲染为空；仅当前路由落在某张表上时才有挂载上下文，
          库首页 / 知识库 / 工作区路由下不占位。 */}
      <TableActionRow
        tableId={tableMatch?.params.tableId ?? null}
        viewId={viewMatch?.params.viewId ?? null}
        baseId={tableMatch?.params.baseId ?? null}
      />

      <div ref={virt.scrollerRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {loading ? (
          <div className="flex h-24 items-center justify-center"><Spinner size={16} /></div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-gx-12 text-gx-text-hint">内容加载失败，请重试</div>
        ) : (
          <>
            {/* 文档段的「回到顶级」落区（KB + 文档 tab 才有；无写权限不渲染）。
                与旧 KbTree 同一套落区样式思路，颜色走 gx-* 令牌。 */}
            {container.kind === "kb" && kbTab === "doc" && kbOps.canCreate && (
              <div
                onDragOver={kbOps.rootZone.onDragOver}
                onDrop={kbOps.rootZone.onDrop}
                data-drop-root={kbOps.rootZone.active ? "true" : undefined}
                className={[
                  "mx-1.5 mb-1 rounded-gx-sm border border-dashed px-2 py-1 text-center text-gx-11 transition-colors",
                  kbOps.rootZone.active
                    ? "border-gx-accent bg-gx-accent-bg text-gx-accent"
                    : "border-transparent text-transparent",
                ].join(" ")}
              >
                拖到此处移到顶级
              </div>
            )}
            <div className="px-1.5" style={{ paddingTop: virt.padTop, paddingBottom: virt.padBottom }}>
              {virt.windowed.map((row) =>
                row.type === "header" ? (
                  <SectionHeader key={`h-${row.kind}`} kind={row.kind} count={row.count} />
                ) : (
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
                    // 表行：五项菜单（无 canManageSchema 时 rowMenuItems 返回 [] → 不渲染三点）
                    menu={
                      row.kind === "table"
                        ? tableOps.rowMenuItems({ id: row.entry.id, name: row.entry.name })
                        : undefined
                    }
                    menuLabel={row.kind === "table" ? `${row.entry.name} 表操作菜单` : undefined}
                    // 文档行：拖拽改层级（画布行不给）
                    drag={row.kind === "doc" ? kbOps.rowDrag(row.entry.id) : undefined}
                  />
                ),
              )}
            </div>
            {empty && <div className="px-4 py-8 text-center text-gx-12 text-gx-text-hint">{emptyText}</div>}
          </>
        )}

        {/* 列表末尾：当前容器的回收站（base → /base/:id/trash，kb → /kb/:id/trash）。
            两页都已存在，按容器 id 直跳；行规格与列表行一致。 */}
        <div className="px-1.5 pt-1">
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
            className="flex w-full items-center gap-1 rounded-gx-lg px-1.5 py-1.5 text-gx-13 text-gx-text-primary transition-colors hover:bg-gx-row-hover"
          >
            <Icon name="trash" size={13} className="shrink-0 text-gx-text-tertiary" />
            <span className="truncate">回收站</span>
          </button>
        </div>
      </div>
    </aside>
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
