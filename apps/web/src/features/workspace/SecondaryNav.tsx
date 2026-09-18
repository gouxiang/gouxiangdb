// M3/S9 二级导航（N3 二级 P0）：三视角 全部 / 未收纳 / 已收纳（裁决 8，无收藏无最近）。
//
// 数据：nav tree 深层索引 + menu 引用（collection.ts 纯函数派生）。
//   - 全部：容器内全部活 table/doc/canvas（按权威树 parentId 镜像，doc 支持层级展开）
//   - 未收纳：C4 口径（table/canvas + kb 根级 doc 无任何活 shortcut）
//   - 已收纳：当前菜单容器子树引用的实体
// 行操作：收纳到导航（menu insert 到当前容器）、移动到分组（权威 move，必经 impact 确认）。
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
import { useNavMenu, useNavNodeIndex, useNavTreeDeep, usePatchMenu, useMoveNode } from "./nav-hooks";
import { extractMoveImpact } from "./nav-hooks";
import {
  buildCollection,
  collectedUnderSubtree,
  navSubtreeIds,
  selectEntries,
  uncollectedCount,
  type CollectableEntry,
  type CollectionView,
} from "./lib/collection";
import { newDraftId } from "./lib/menu-ops";
import { useMenuVirtualizer } from "./lib/useMenuVirtualizer";
import {
  buildSecondaryRows,
  groupByKind,
  SectionHeader,
  SecondaryRow,
  SECONDARY_ROW_H,
} from "./SecondaryNavSections";
import { MoveToGroupModal } from "./MoveToGroupModal";
import { MoveImpactModal, type PendingMove } from "./MoveImpactModal";
import type { NavNodeDTO } from "@gx/shared-types";

const TABS: { key: CollectionView; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "uncollected", label: "未收纳" },
  { key: "collected", label: "已收纳" },
];

export function SecondaryNav({ containerMenuId, containerName, onClose }: {
  containerMenuId: string;
  containerName: string;
  onClose: () => void;
}) {
  const { menu } = useNavMenu();
  const { tree, isLoading } = useNavTreeDeep();
  const { index } = useNavNodeIndex();
  const [tab, setTab] = useState<CollectionView>("all");
  const [query, setQuery] = useState("");
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [moveFor, setMoveFor] = useState<CollectableEntry | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const patch = usePatchMenu();
  const moveNode = useMoveNode();
  const navigate = useNavigate();
  const params = useParams();

  const collection = useMemo(
    () => buildCollection(tree?.items ?? [], menu?.items ?? []),
    [tree?.items, menu?.items],
  );

  const groups = useMemo(
    () => (tree?.items ?? []).filter((n) => n.kind === "group" && !n.deletedAt),
    [tree?.items],
  );

  const uncount = useMemo(() => uncollectedCount(collection), [collection]);

  // 容器菜单引用的权威容器节点（base/kb），用于把"全部/未收纳"限定到该容器实体子树
  const containerNodeId = useMemo(
    () => menu?.items.find((i) => i.id === containerMenuId)?.nodeId ?? null,
    [menu?.items, containerMenuId],
  );
  const scopeIds = useMemo(
    () => (containerNodeId && tree ? navSubtreeIds(tree.items, containerNodeId) : null),
    [tree, containerNodeId],
  );

  const sections = useMemo(() => {
    if (tab === "collected") {
      const entries = collectedUnderSubtree(collection, menu?.items ?? [], containerMenuId);
      const q = query.trim().toLowerCase();
      const hit = q ? entries.filter((e) => e.node.name.toLowerCase().includes(q)) : entries;
      return groupByKind(hit);
    }
    const mk = (kind: "table" | "doc" | "canvas") =>
      selectEntries(collection, tab, { kind, query }).filter(
        (e) => scopeIds === null || scopeIds.has(e.node.id),
      );
    return groupByKind([...mk("table"), ...mk("doc"), ...mk("canvas")]);
  }, [collection, tab, query, containerMenuId, menu?.items, scopeIds]);

  const currentResource = params.tableId ?? params.docId ?? null;

  // 文档父 → 子文档映射（权威 parentId 镜像，用于文档分段树展开）
  const docChildren = useMemo(() => {
    const m = new Map<string, CollectableEntry[]>();
    for (const e of collection.byKind.doc) {
      const pid = e.node.parentId;
      if (!pid) continue;
      const arr = m.get(pid) ?? [];
      arr.push(e);
      m.set(pid, arr);
    }
    return m;
  }, [collection.byKind.doc]);

  const collect = (entry: CollectableEntry) => {
    // 直接落库（二级栏行内动作即时生效，非编排草稿）
    patch.mutate(
      [{ op: "insert", id: newDraftId("s"), type: "shortcut", parentId: containerMenuId, nodeId: entry.node.id }],
      {
        onSuccess: () => toast(`已收纳「${entry.node.name}」到${containerName}`, "success"),
        onError: (e) => toast(e instanceof Error ? e.message : "收纳失败", "error"),
      },
    );
  };

  const requestMove = (entry: CollectableEntry, target: NavNodeDTO) => {
    setMoveFor(null);
    moveNode.mutate(
      { id: entry.node.id, newParentId: target.id, confirmed: false },
      {
        onSuccess: () => setPendingMove(null), // 已确认过的移动不可能到这（409 分支处理）；防御性关闭
        onError: (e) => {
          const impact = extractMoveImpact(e);
          if (impact) {
            setPendingMove({
              nodeId: entry.node.id,
              nodeName: entry.node.name,
              targetName: target.name,
              newParentId: target.id,
              impact,
            });
          } else {
            toast(e instanceof Error ? e.message : "移动失败", "error");
          }
        },
      },
    );
  };

  const confirmMove = () => {
    if (!pendingMove) return;
    moveNode.mutate(
      { id: pendingMove.nodeId, newParentId: pendingMove.newParentId, confirmed: true },
      {
        onSuccess: () => {
          toast(`已移动到「${pendingMove.targetName}」`, "success");
          setPendingMove(null);
        },
        onError: (e) => {
          toast(e instanceof Error ? e.message : "移动失败", "error");
          setPendingMove(null);
        },
      },
    );
  };

  const toggleDoc = (id: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const empty = sections.table.length + sections.doc.length + sections.canvas.length === 0;

  // S10：三段合并为一条定高行序列，单窗口切片，挂载 DOM 数不随未收纳/全部列表总量线性膨胀。
  const flatRows = useMemo(
    () => buildSecondaryRows(sections, expandedDocs, docChildren),
    [sections, expandedDocs, docChildren],
  );
  const virt = useMenuVirtualizer(flatRows, SECONDARY_ROW_H);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-gx-separator bg-gx-bg">
      <div className="flex items-center gap-1 border-b border-gx-separator px-2 py-2">
        <span className="flex-1 truncate px-1 text-gx-13 font-medium text-gx-text-primary" title={containerName}>
          {containerName}
        </span>
        <button
          type="button"
          aria-label="收起二级导航"
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
        <div className="mt-2 flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={[
                "rounded-full px-2 py-0.5 text-gx-12 transition-colors",
                tab === t.key
                  ? "bg-gx-accent-bg font-medium text-gx-accent"
                  : "text-gx-text-secondary hover:bg-gx-row-hover",
              ].join(" ")}
            >
              {t.label}
              {t.key === "uncollected" && uncount > 0 && (
                <span className="ml-1 font-mono text-gx-11 tabular-nums">{uncount}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div ref={virt.scrollerRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center"><Spinner size={16} /></div>
        ) : (
          <>
            <div className="px-1.5" style={{ paddingTop: virt.padTop, paddingBottom: virt.padBottom }}>
              {virt.windowed.map((row) =>
                row.type === "header" ? (
                  <SectionHeader key={`h-${row.kind}`} kind={row.kind} count={row.count} />
                ) : (
                  <SecondaryRow
                    key={row.entry.node.id}
                    kind={row.kind}
                    entry={row.entry}
                    depth={row.depth}
                    hasDocKids={row.hasDocKids}
                    expanded={row.expanded}
                    currentResource={currentResource}
                    index={index}
                    tab={tab}
                    onToggleDoc={toggleDoc}
                    onNavigate={(href) => navigate(href)}
                    onCollect={collect}
                    onMove={setMoveFor}
                  />
                ),
              )}
            </div>
            {empty && (
              <div className="px-4 py-8 text-center text-gx-12 text-gx-text-hint">
                {tab === "uncollected" ? "全部内容都已收纳" : "没有匹配的内容"}
              </div>
            )}
          </>
        )}
      </div>

      <MoveToGroupModal
        entry={moveFor}
        groups={groups}
        busy={moveNode.isPending}
        onPick={requestMove}
        onClose={() => setMoveFor(null)}
      />
      <MoveImpactModal
        pending={pendingMove}
        busy={moveNode.isPending}
        onConfirm={confirmMove}
        onCancel={() => setPendingMove(null)}
      />
    </aside>
  );
}
