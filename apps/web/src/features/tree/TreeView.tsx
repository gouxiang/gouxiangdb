// apps/web/src/features/tree/TreeView.tsx
// 层级视图：同表自引用 link 字段构成的树。建树/拍平/窗口化纯函数见 tree-data.ts 与
// contacts/lib/tree.ts，本文件只负责 React 展示（缩进、展开折叠、开窗渲染、改父）。
//
// hooks 顺序约定（同 KanbanView，React #310 教训）：先无条件跑完全部 hooks（数据、
// expanded、滚动容器测量 effect），再按「treeParentFieldId 是否已配置且字段存在」
// 早返回 TreeSetup 引导空态（独立子组件，见文件末尾）。useFields 首帧为空、次帧
// 到达会让守卫翻转，故任何 hook 都不能排在守卫之后。

import { useEffect, useMemo, useRef, useState } from "react";
import { useFields, useGXMutations } from "../../api/hooks";
import { useRecordsBounded } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import { EmptyState, Select, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ResultNotice, boundedResultText, DEGRADED_RESULT_TEXT } from "../common/ResultNotice";
import type { FieldDTO } from "@gx/shared-types";
import type { ViewProps } from "../views/field-controls";
import { toTreeRows, treeWouldCycle, type TreeRow } from "./tree-data";
import {
  buildDeptTree,
  descendantIds,
  flattenVisible,
  virtualWindow,
} from "../contacts/lib/tree";

const ROW_H = 36;
const INDENT = 16;
const OVERSCAN = 8;
const ROOT_VALUE = "__root__";

export default function TreeView({ tableId, viewId, view, permissions, onOpenRecord }: ViewProps) {
  const bounded = useRecordsBounded({ tableId, viewId });
  const { data: fieldsRes } = useFields(tableId);
  const m = useGXMutations();

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);

  // 容器尺寸测量（ResizeObserver + 原生 scroll，均为 passive / 有清理）。
  // 必须在守卫之前：守卫翻转不影响本 effect 的挂载，hook 序列恒定。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  const fields = fieldsRes ?? [];
  const records = bounded.records;
  const degraded = isComputedInMem(bounded.degraded);
  // 父字段：必须存在且为 link（Setup 只列出指向本表的关联字段）。
  const parentField = fields.find((f) => f.id === view.config.treeParentFieldId);
  const configured = !!parentField && parentField.type === "links";
  // 主字段（标题）：cardFieldIds[0] 存在则用，否则 fields[0]。
  const titleField =
    fields.find((f) => f.id === view.config.cardFieldIds?.[0]) ?? fields[0];
  const titleFieldId = titleField ? titleField.id : null;

  const rows = useMemo(
    () =>
      configured
        ? toTreeRows(records, view.config.treeParentFieldId, titleFieldId)
        : [],
    [configured, records, view.config.treeParentFieldId, titleFieldId],
  );
  const tree = useMemo(() => buildDeptTree(rows), [rows]);
  // 默认全部展开（层级视图节点通常可控；用户可折叠）。expanded 一旦被用户触碰即以此为准。
  const effectiveExpanded = useMemo(() => {
    if (expanded.size === 0 && rows.length) return new Set(rows.map((r) => r.id));
    return expanded;
  }, [expanded, rows]);
  const visibleRows = useMemo(
    () => flattenVisible(tree, effectiveExpanded),
    [tree, effectiveExpanded],
  );
  // 子节点计数：无子节点不显示 chevron。
  const childCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.parentId) map.set(r.parentId, (map.get(r.parentId) ?? 0) + 1);
    }
    return map;
  }, [rows]);
  // 每行的改父候选：排除自身及全部子孙（候选层面已拦环，treeWouldCycle 是选中时的二次防线）。
  const parentOptions = useMemo(() => {
    const map = new Map<string, TreeRow[]>();
    for (const r of rows) {
      const blocked = descendantIds(rows, r.id, true);
      map.set(r.id, rows.filter((o) => !blocked.has(o.id)));
    }
    return map;
  }, [rows]);

  // 守卫：未配置父字段 -> Setup 引导。必须晚于上面全部 hooks。
  if (!configured) {
    return (
      <TreeSetup
        tableId={tableId}
        viewId={viewId}
        fields={fields}
        canManageSchema={permissions.canManageSchema}
      />
    );
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const base = prev.size ? prev : new Set(rows.map((r) => r.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const changeParent = async (child: TreeRow, raw: string) => {
    const next = raw === ROOT_VALUE ? null : raw;
    if (next === (child.parentId ?? ROOT_VALUE)) return;
    if (treeWouldCycle(rows, child.id, next)) {
      toast("不能移动到自身或其子孙节点之下", "error");
      return;
    }
    try {
      await m.updateRecord.mutateAsync({
        recordId: child.id,
        fields: {
          [parentField!.id]: next ? [{ recordId: next }] : [],
        },
        tableId,
        viewId,
      });
    } catch (e) {
      toast((e as Error)?.message || "修改父级失败", "error");
    }
  };

  if (bounded.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const win = virtualWindow(scrollTop, viewportH, ROW_H, visibleRows.length, OVERSCAN);
  const windowRows = visibleRows.slice(win.start, win.end);

  return (
    <div className="flex h-full flex-col">
      {(bounded.bounded || degraded) && (
        <div className="shrink-0 px-gx-lg pt-gx-md">
          {degraded ? (
            <ResultNotice tone="warning" role="alert">
              {DEGRADED_RESULT_TEXT}
            </ResultNotice>
          ) : (
            <ResultNotice tone="warning">
              {boundedResultText(bounded.declaredTotal, records.length)}
            </ResultNotice>
          )}
        </div>
      )}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 ? (
          <EmptyState
            icon="sitemap"
            title="暂无记录"
            description="在本表新建记录并通过关联字段指定父级后，将在此按层级展示。"
          />
        ) : (
          <div style={{ height: win.totalHeight }}>
            <div style={{ transform: `translateY(${win.padTop}px)` }}>
              {windowRows.map(({ dept, depth }) => {
                const hasChildren = (childCount.get(dept.id) ?? 0) > 0;
                const isOpen = effectiveExpanded.has(dept.id);
                return (
                  <div
                    key={dept.id}
                    style={{ height: ROW_H, paddingLeft: depth * INDENT }}
                    className="flex items-center gap-1 pr-gx-md hover:bg-gx-row-hover"
                  >
                    <button
                      type="button"
                      aria-label={isOpen ? "折叠" : "展开"}
                      aria-expanded={isOpen}
                      onClick={() => hasChildren && toggle(dept.id)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-sm text-gx-text-tertiary hover:bg-gx-surface disabled:cursor-default"
                      disabled={!hasChildren}
                    >
                      {hasChildren ? (
                        <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      title={dept.name}
                      onClick={() =>
                        onOpenRecord?.({ tableId, recordId: dept.id, title: dept.name })
                      }
                      className="min-w-0 flex-1 truncate text-left text-gx-13 text-gx-text-primary hover:text-gx-accent"
                    >
                      {dept.name}
                    </button>
                    {permissions.canEditData && (
                      <Select
                        aria-label="修改父级"
                        className="w-40 shrink-0"
                        value={dept.parentId ?? ROOT_VALUE}
                        onChange={(e) => void changeParent(dept, e.target.value)}
                      >
                        <option value={ROOT_VALUE}>无（根）</option>
                        {(parentOptions.get(dept.id) ?? []).map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 未配置父级字段时的引导空态（独立子组件）。
 * 拆出来让父组件 TreeView 的 hooks 无条件跑完（首帧 fields 空 / 次帧到达翻转守卫时
 * hook 数量恒定，避免 React #310）。Setup 只列出指向本表的非反向 link 字段。
 */
function TreeSetup({
  tableId,
  viewId,
  fields,
  canManageSchema,
}: {
  tableId: string;
  viewId: string;
  fields: FieldDTO[];
  canManageSchema: boolean;
}) {
  const m = useGXMutations();
  const linkFields = fields.filter(
    (f) => f.type === "links" && !f.isReverse && f.relatedTableId === tableId,
  );
  return (
    <div className="flex h-full items-center justify-center p-gx-lg">
      <EmptyState
        icon="sitemap"
        title="设置层级父级字段"
        description="请选择一个指向本表的「关联」字段，层级视图将按该字段的父子关系展示记录。"
        action={
          <div className="mt-3 flex items-center gap-2">
            <span className="text-gx-13 text-gx-text-secondary">父级字段：</span>
            <Select
              value=""
              disabled={linkFields.length === 0 || !canManageSchema}
              disabledReason="需要可管理表结构的权限"
              options={
                linkFields.length === 0
                  ? [{ value: "", label: "暂无指向本表的关联字段" }]
                  : [{ value: "", label: "请选择…" }, ...linkFields.map((f) => ({ value: f.id, label: f.name }))]
              }
              onChange={(e) => {
                if (e.target.value) {
                  void m.updateView.mutateAsync({
                    viewId,
                    tableId,
                    data: { config: { treeParentFieldId: e.target.value } },
                  });
                }
              }}
            />
          </div>
        }
      />
    </div>
  );
}
