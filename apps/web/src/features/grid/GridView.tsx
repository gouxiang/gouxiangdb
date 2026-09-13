// 网格视图主组件：工具栏 + 可滚动表格（sticky 表头/首列/主字段）+ 聚合行 + 状态栏。
// 负责单元格选中/编辑、键盘导航、虚拟滚动、分组渲染、行颜色，并把配置写回 view.config。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type {
  ViewDTO,
  ViewConfig,
  PermissionSet,
  RecordDTO,
  FieldDTO,
  AggFunc,
  LinkRefDTO,
  CellValue,
} from "@gx/shared-types";
import { ROW_HEIGHT_PX } from "@gx/shared-types";
import { useFields, useTables, useGXMutations } from "../../api/hooks";
import { useRecordsInfinite } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import { Spinner, EmptyState, IconButton, Modal, Select, Input, Button, toast } from "../../components/ui";
import { ResultNotice, DEGRADED_RESULT_TEXT } from "../common/ResultNotice";
import { GridToolbar } from "./GridToolbar";
import { GridHeaderCell } from "./GridHeaderCell";
import { GridRow } from "./GridRow";
import { AggregationBar } from "./AggregationBar";
import { useGridSelection } from "./useGridSelection";
import FieldEditorSheet from "../designer/FieldEditorSheet";
import { isEmptyValue, resolveSelectOption, formatCell } from "../cells/format";

export interface GridViewProps {
  baseId: string;
  tableId: string;
  viewId: string;
  view: ViewDTO;
  permissions: PermissionSet;
  onOpenRecord?: (ref: LinkRefDTO) => void;
}

const ROW_HEADER_W = 56;

// 不同字段类型的默认列宽
function defaultColWidth(field: FieldDTO): number {
  switch (field.type) {
    case "checkbox":
      return 80;
    case "links":
      return 220;
    case "attachment":
      return 200;
    case "singleSelect":
    case "multiSelect":
      return 160;
    case "date":
    case "datetime":
    case "createdTime":
    case "lastModifiedTime":
      return 140;
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "rating":
    case "autoNumber":
    case "count":
    case "rollup":
      return 120;
    default:
      return 200;
  }
}

export default function GridView({ baseId, tableId, viewId, view, permissions, onOpenRecord }: GridViewProps) {
  const infiniteData = useRecordsInfinite({ tableId, viewId });
  const { data: allFieldsData } = useFields(tableId);
  const m = useGXMutations();

  const records = infiniteData.records;
  const hasNextPage = infiniteData.hasNextPage;
  const isFetchingNextPage = infiniteData.isFetchingNextPage;
  const loadMore = infiniteData.loadMore;
  const isLoading = infiniteData.isLoading;
  // v2 新增：tabs/subtable 字段在 grid view 不显示（无独立 cell 表现）
  const visibleFields = useMemo(
    () => infiniteData.fields.filter((f) => f.type !== "tabs" && f.type !== "subtable"),
    [infiniteData.fields],
  );
  // 全字段（含 tabs/subtable）—— 只给 FieldEditorSheet 用，让用户能编辑/管理布局字段
  const allSchemaFields = useMemo(() => allFieldsData ?? [], [allFieldsData]);
  const groups = infiniteData.groups;
  const aggregations = infiniteData.aggregations;
  const filteredTotal = infiniteData.filteredTotal;
  const total = infiniteData.total;
  // S8：受限口径（computedInMem）——聚合/统计置灰标注，数据行仍正常显示可编辑。
  const degraded = isComputedInMem(infiniteData.degraded);

  const primaryFieldId = visibleFields[0]?.id ?? "";

  // 本地配置状态（乐观更新，并写回服务端）
  const [cfg, setCfg] = useState<ViewConfig>(view.config);
  useEffect(() => {
    setCfg(view.config);
    // 仅当切换视图时整体重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  const [editing, setEditing] = useState<{ recordId: string; fieldId: string } | null>(null);
  const [active, setActive] = useState<{ recordId: string; fieldId: string } | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(600);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [editingFieldMeta, setEditingFieldMeta] = useState<FieldDTO | null>(null);
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const { data: tablesData } = useTables(baseId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const selection = useGridSelection();

  useEffect(() => {
    if (scrollRef.current) setContainerH(scrollRef.current.clientHeight);
  }, [isLoading]);

  // S8 无限滚动：仅在服务端启用 keyset 且有下一页时，触底（约 480px 提前量）自动续翻。
  // 未启用（hasNextPage=false，含服务端 off 的单页退化）时永不触发，行为与旧版一致。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasNextPage) return;
    const onScroll = () => {
      if (isFetchingNextPage) return;
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining < 480) loadMore();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasNextPage, isFetchingNextPage, loadMore, records.length]);

  // 写回 view.config
  const updateConfig = useCallback(
    async (partial: Partial<ViewConfig>) => {
      const next = { ...cfg, ...partial };
      setCfg(next);
      try {
        await m.updateView.mutateAsync({ viewId, tableId, data: { config: next } });
      } catch (e) {
        toast((e as Error).message ?? "保存视图配置失败", "error");
      }
    },
    [cfg, m, viewId, tableId],
  );

  const widthOf = useCallback((f: FieldDTO) => colWidths[f.id] ?? defaultColWidth(f), [colWidths]);
  const resizeField = useCallback(
    (fieldId: string, delta: number) => {
      const f = visibleFields.find((x) => x.id === fieldId);
      if (!f) return;
      setColWidths((prev) => ({
        ...prev,
        [fieldId]: Math.max(60, (prev[fieldId] ?? defaultColWidth(f)) + delta),
      }));
    },
    [visibleFields],
  );

  // 单格提交
  const commitValue = useCallback(
    async (recordId: string, fieldId: string, next: CellValue) => {
      try {
        await m.updateRecord.mutateAsync({ recordId, fields: { [fieldId]: next }, tableId, viewId });
        toast("已保存", "success");
      } catch (e) {
        toast((e as Error).message ?? "保存失败", "error");
      }
    },
    [m, tableId, viewId],
  );

  // 排序
  const sortDirOf = (fieldId: string) => cfg.sorts.find((s) => s.fieldId === fieldId)?.direction;
  const handleSort = (fieldId: string, dir: "asc" | "desc" | null) => {
    const others = cfg.sorts.filter((s) => s.fieldId !== fieldId);
    updateConfig({ sorts: dir ? [...others, { fieldId, direction: dir }] : others });
  };

  // 隐藏字段
  const hideField = (fieldId: string) => {
    if (!cfg.hiddenFieldIds.includes(fieldId)) {
      updateConfig({ hiddenFieldIds: [...cfg.hiddenFieldIds, fieldId] });
    }
  };
  const deleteField = (fieldId: string) => {
    if (!permissions.canManageSchema) return;
    void m.deleteField.mutateAsync({ fieldId, tableId, viewId }).then(() => toast("字段已删除", "success"));
  };

  // 分组折叠
  const toggleGroup = (key: string) => {
    const collapsed = cfg.collapsedGroupKeys.includes(key)
      ? cfg.collapsedGroupKeys.filter((k) => k !== key)
      : [...cfg.collapsedGroupKeys, key];
    updateConfig({ collapsedGroupKeys: collapsed });
  };

  // ---------- 选中 / 编辑交互 ----------
  // checkbox 单击翻转的在途守卫：同一格 PATCH 未返回前忽略后续点击，
  // 避免快速连点时多个 PATCH 都基于过期 records 快照（!旧值相同）而乱序/终态错乱。
  const checkInflightRef = useRef<Set<string>>(new Set());
  const onCellClick = (recordId: string, fieldId: string) => {
    setActive({ recordId, fieldId });
    scrollRef.current?.focus();
    const field = visibleFields.find((f) => f.id === fieldId);
    if (field?.type === "checkbox" && permissions.canEditData) {
      const key = `${recordId}:${fieldId}`;
      if (checkInflightRef.current.has(key)) return;
      const rec = records.find((r) => r.id === recordId);
      checkInflightRef.current.add(key);
      void commitValue(recordId, fieldId, !rec?.fields[fieldId]).finally(() => {
        checkInflightRef.current.delete(key);
      });
    }
  };
  const onCellDoubleClick = (recordId: string, fieldId: string) => {
    if (!permissions.canEditData) return;
    const field = visibleFields.find((f) => f.id === fieldId);
    // checkbox 的权威入口是单击翻转；双击不再进入"挂载即翻转"的 CheckboxEditor，
    // 否则一次双击 = 单击翻转 + editor 挂载再翻转，快速连点产生重复/反向 PATCH。
    if (
      field &&
      !["formula", "rollup", "count", "lookup", "autoNumber", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy", "checkbox"].includes(field.type)
    ) {
      setActive({ recordId, fieldId });
      setEditing({ recordId, fieldId });
    }
  };
  const onStartEdit = (recordId: string, fieldId: string) => {
    setActive({ recordId, fieldId });
    setEditing({ recordId, fieldId });
  };
  const onCommitEdit = (next: CellValue, move: "down" | "right" | "none" = "none") => {
    if (editing) void commitValue(editing.recordId, editing.fieldId, next);
    setEditing(null);
    if (move !== "none") moveActive(move);
  };
  const onCancelEdit = () => setEditing(null);

  // 键盘导航（非编辑态）
  const moveActive = (dir: "up" | "down" | "left" | "right") => {
    if (!active) {
      if (records[0] && visibleFields[0]) setActive({ recordId: records[0].id, fieldId: visibleFields[0].id });
      return;
    }
    const ri = records.findIndex((r) => r.id === active.recordId);
    const fi = visibleFields.findIndex((f) => f.id === active.fieldId);
    let nri = ri;
    let nfi = fi;
    if (dir === "up") nri = Math.max(0, ri - 1);
    if (dir === "down") nri = Math.min(records.length - 1, ri + 1);
    if (dir === "left") nfi = Math.max(0, fi - 1);
    if (dir === "right") nfi = Math.min(visibleFields.length - 1, fi + 1);
    setActive({ recordId: records[nri].id, fieldId: visibleFields[nfi].id });
  };

  const onContainerKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return; // 编辑态由 CellEditor 处理
    if (!active) {
      if (e.key.startsWith("Arrow") || e.key === "Enter") {
        e.preventDefault();
        moveActive("down");
      }
      return;
    }
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveActive("up");
        break;
      case "ArrowDown":
        e.preventDefault();
        moveActive("down");
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveActive("left");
        break;
      case "ArrowRight":
        e.preventDefault();
        moveActive("right");
        break;
      case "Enter":
        e.preventDefault();
        if (permissions.canEditData) onStartEdit(active.recordId, active.fieldId);
        break;
      case "Escape":
        setActive(null);
        break;
    }
  };

  // 行颜色
  const rowColorOf = (rec: RecordDTO): string | null => {
    const rc = cfg.rowColor;
    if (rc.mode === "bySelect" && rc.fieldId) {
      const opt = resolveSelectOption(
        visibleFields.find((f) => f.id === rc.fieldId) as FieldDTO,
        rec.fields[rc.fieldId],
      );
      return opt?.color ?? null;
    }
    if (rc.mode === "byCondition") {
      for (const c of rc.conditions) {
        if (matchCondition(rec.fields[c.fieldId], c.op, c.value)) return c.color;
      }
    }
    return null;
  };

  // ---------- 工具栏动作 ----------
  // 就地新建草稿行：先建空记录再逐格补值，draft 跳过创建期必填（与编辑期允许临时为空一致）。
  const onNewRecord = () =>
    void m.createRecord
      .mutateAsync({ tableId, fields: {}, viewId, draft: true })
      .catch((e: unknown) => toast((e as Error)?.message || "新建记录失败", "error"));
  const onBulkDelete = () => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) return;
    void m.bulkDeleteRecords.mutateAsync({ ids, tableId, viewId }).then(() => {
      selection.clear();
      toast(`已删除 ${ids.length} 行`, "success");
    });
  };
  const onClearSelection = () => selection.clear();
  const onExport = () => exportCsv(visibleFields, records);
  const onImport = () => importRef.current?.click();
  const onCopyView = () => void m.duplicateView.mutateAsync({ viewId, tableId });
  const onClearTable = () => {
    if (!confirm("确定清空表中所有记录？此操作不可撤销。")) return;
    void m.clearTable.mutateAsync({ tableId, viewId });
  };
  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    const csv = await file.text();
    try {
      const res = await m.csvImport.mutateAsync({ tableId, csv, hasHeader: true, viewId });
      toast(`导入成功：新增 ${res.createdRecords} 条`, "success");
    } catch (e) {
      toast((e as Error).message ?? "导入失败", "error");
    }
  };

  // 记录映射（分组用）
  const recMap = useMemo(() => {
    const map = new Map<string, RecordDTO>();
    records.forEach((r) => map.set(r.id, r));
    return map;
  }, [records]);

  // 分组渲染
  const renderGrouped = () => (
    <>
      {groups!.map((g) => {
        const collapsed = cfg.collapsedGroupKeys.includes(g.key);
        return (
          <tbody key={g.key}>
            <tr className="bg-gx-bg">
              <td className="sticky left-0 z-20 border-b border-r border-gx-separator bg-gx-bg" style={{ width: ROW_HEADER_W, minWidth: ROW_HEADER_W }}>
                <button
                  type="button"
                  className="p-1 text-gx-text-hint hover:text-gx-text-primary"
                  onClick={() => toggleGroup(g.key)}
                >
                  <span className={clsx("inline-block transition-transform", collapsed ? "" : "rotate-90")}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </span>
                </button>
              </td>
              <td className="border-b border-gx-separator px-2 py-1.5" colSpan={visibleFields.length} style={{ height: 36 }}>
                <div className="flex items-center gap-2 text-gx-13">
                  {g.color && <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: g.color }} />}
                  <span className="font-semibold text-gx-text-primary">{g.label}</span>
                  <span className="text-gx-text-hint">（{g.recordIds.length}）</span>
                  {Object.keys(g.aggregations).length > 0 && (
                    <span className="ml-2 flex gap-3 text-gx-text-tertiary">
                      {Object.entries(g.aggregations).map(([fid, val]) => (
                        <span key={fid}>
                          {visibleFields.find((f) => f.id === fid)?.name}：
                          {degraded ? (
                            <b className="text-gx-text-hint">受限</b>
                          ) : (
                            <b className="text-gx-text-primary">{val == null ? "—" : val}</b>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </td>
            </tr>
            {!collapsed &&
              g.recordIds
                .map((id) => recMap.get(id))
                .filter((r): r is RecordDTO => !!r)
                .map((rec, i) => (
                  <GridRow
                    key={rec.id}
                    record={rec}
                    fields={visibleFields}
                    widthOf={widthOf}
                    rowHeight={ROW_HEIGHT_PX[cfg.rowHeight]}
                    zebra={i % 2 === 1}
                    selected={selection.isSelected(rec.id)}
                    activeFieldId={active?.recordId === rec.id ? active.fieldId : null}
                    editing={editing}
                    permissions={permissions}
                    rowHeaderWidth={ROW_HEADER_W}
                    primaryFieldId={primaryFieldId}
                    canEditData={permissions.canEditData}
                    onToggleRowSelect={selection.toggle}
                    onOpenRecord={(ref) => onOpenRecord?.(ref)}
                    onCellClick={onCellClick}
                    onCellDoubleClick={onCellDoubleClick}
                    onCellKeyDown={onContainerKeyDown}
                    onStartEdit={onStartEdit}
                    onCommitEdit={onCommitEdit}
                    onCancelEdit={onCancelEdit}
                  />
                ))}
          </tbody>
        );
      })}
    </>
  );

  // 虚拟滚动（仅非分组时）
  const rowH = ROW_HEIGHT_PX[cfg.rowHeight];
  const useVirtual = !groups && records.length > 300;
  const start = useVirtual ? Math.max(0, Math.floor(scrollTop / rowH) - 20) : 0;
  const end = useVirtual ? Math.min(records.length, start + Math.ceil(containerH / rowH) + 40) : records.length;

  const totalWidth = ROW_HEADER_W + visibleFields.reduce((s, f) => s + widthOf(f), 0);

  return (
    <div className="flex h-full flex-col bg-gx-surface">
      <GridToolbar
        config={cfg}
        allFields={visibleFields}
        visibleFields={visibleFields}
        filteredTotal={filteredTotal}
        permissions={{ canEditData: permissions.canEditData, canManageSchema: permissions.canManageSchema }}
        selectionCount={selection.count}
        onUpdateConfig={(p) => void updateConfig(p)}
        onNewRecord={onNewRecord}
        onBulkDelete={onBulkDelete}
        onBulkEdit={() => setBulkEditOpen(true)}
        onClearSelection={onClearSelection}
        onImport={onImport}
        onExport={onExport}
        onCopyView={onCopyView}
        onClearTable={onClearTable}
        onEditField={(id) => {
          if (id == null) {
            setEditingFieldId(null);
            setEditingFieldMeta(null);
          } else {
            setEditingFieldId(id);
            const found = allSchemaFields.find((f) => f.id === id) ?? null;
            setEditingFieldMeta(found);
          }
          setFieldEditorOpen(true);
        }}
        onFieldCreated={(id) => {
          const created = allSchemaFields.find((f) => f.id === id);
          if (created) {
            setEditingFieldId(id);
            setEditingFieldMeta(created);
            setFieldEditorOpen(true);
          }
        }}
      />

      <input
        ref={importRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={(e) => void onImportFile(e.target.files?.[0])}
      />

      {degraded && (
        <div className="shrink-0 border-b border-gx-separator px-3 py-1.5">
          <ResultNotice tone="warning" role="alert">
            数据量较大，当前为受限结果，精确统计需增加筛选条件。数据行仍可正常查看与编辑。
          </ResultNotice>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={24} />
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon="table" title="暂无记录" description="点击「新建记录」开始添加数据。" />
        </div>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={0}
          className="flex-1 overflow-auto outline-none"
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          onKeyDown={onContainerKeyDown}
        >
          <table className="table-fixed border-separate border-spacing-0" style={{ width: totalWidth, minWidth: "100%" }}>
            <thead className="sticky top-0 z-10">
              <tr>
                <th
                  className="sticky left-0 z-30 border-b border-r border-gx-separator bg-gx-table-header"
                  style={{ width: ROW_HEADER_W, minWidth: ROW_HEADER_W, height: 32 }}
                />
                {visibleFields.map((f) => (
                  <GridHeaderCell
                    key={f.id}
                    field={f}
                    width={widthOf(f)}
                    sortDirection={sortDirOf(f.id)}
                    canManageSchema={permissions.canManageSchema}
                    onSort={(d) => handleSort(f.id, d)}
                    onHide={() => hideField(f.id)}
                    onRename={() => {
                      setEditingFieldId(f.id);
                      setEditingFieldMeta(f);
                      setFieldEditorOpen(true);
                    }}
                    onDelete={() => deleteField(f.id)}
                    onResize={(delta) => resizeField(f.id, delta)}
                    stickyLeft={f.id === primaryFieldId ? ROW_HEADER_W : undefined}
                    z={f.id === primaryFieldId ? 20 : 10}
                  />
                ))}
              </tr>
            </thead>

            {groups && groups.length > 0 ? (
              renderGrouped()
            ) : (
              <tbody>
                {useVirtual && start > 0 && (
                  <tr style={{ height: start * rowH }}>
                    <td colSpan={visibleFields.length + 1} />
                  </tr>
                )}
                {records.slice(start, end).map((rec, i) => {
                  const realIdx = start + i;
                  const color = rowColorOf(rec);
                  return (
                    <GridRow
                      key={rec.id}
                      record={rec}
                      fields={visibleFields}
                      widthOf={widthOf}
                      rowHeight={rowH}
                      zebra={realIdx % 2 === 1}
                      selected={selection.isSelected(rec.id)}
                      activeFieldId={active?.recordId === rec.id ? active.fieldId : null}
                      editing={editing}
                      permissions={permissions}
                      rowHeaderWidth={ROW_HEADER_W}
                      primaryFieldId={primaryFieldId}
                      canEditData={permissions.canEditData}
                      onToggleRowSelect={selection.toggle}
                      onOpenRecord={(ref) => onOpenRecord?.(ref)}
                      onCellClick={onCellClick}
                      onCellDoubleClick={onCellDoubleClick}
                      onCellKeyDown={onContainerKeyDown}
                      onStartEdit={onStartEdit}
                      onCommitEdit={onCommitEdit}
                      onCancelEdit={onCancelEdit}
                      {...(color ? { rowColor: color } : {})}
                    />
                  );
                })}
                {useVirtual && end < records.length && (
                  <tr style={{ height: (records.length - end) * rowH }}>
                    <td colSpan={visibleFields.length + 1} />
                  </tr>
                )}
              </tbody>
            )}

            <tfoot>
              <AggregationBar
                fields={visibleFields}
                config={cfg.aggregations}
                values={aggregations}
                widthOf={widthOf}
                rowHeaderWidth={ROW_HEADER_W}
                primaryFieldId={primaryFieldId}
                onPick={(fieldId, func: AggFunc | null) =>
                  updateConfig({ aggregations: { ...cfg.aggregations, [fieldId]: func } })
                }
                degraded={degraded}
              />
            </tfoot>
          </table>

          {/* S8 续翻入口：仅服务端启用 keyset 且有下一页时出现。
              可见按钮保证键盘/读屏可达；平时滚动到底也会自动加载（见上方 scroll 监听）。 */}
          {hasNextPage && (
            <div className="flex justify-center py-3">
              <Button
                variant="secondary"
                size="sm"
                loading={isFetchingNextPage}
                onClick={() => loadMore()}
              >
                加载更多
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 状态栏 */}
      <div className="flex h-7 items-center gap-3 border-t border-gx-separator bg-gx-bg px-3 text-gx-11 text-gx-text-hint">
        <span>共 {total} 条</span>
        {filteredTotal !== total && <span>筛选后 {filteredTotal} 条</span>}
        {selection.count > 0 && <span className="text-gx-accent">已选 {selection.count} 行</span>}
        <span className="flex-1" />
        <span>{view.name}</span>
      </div>

      {bulkEditOpen && (
        <BulkEditModal
          fields={visibleFields}
          onClose={() => setBulkEditOpen(false)}
          onApply={async (fieldId, value) => {
            const ids = Array.from(selection.selectedIds);
            await m.bulkUpdateRecords.mutateAsync({ ids, fields: { [fieldId]: value }, tableId, viewId });
            toast(`已更新 ${ids.length} 行`, "success");
            setBulkEditOpen(false);
            selection.clear();
          }}
        />
      )}

      {/* 字段编辑器（新建 / 编辑字段） */}
      <FieldEditorSheet
        open={fieldEditorOpen}
        tableId={tableId}
        baseId={baseId}
        field={editingFieldMeta}
        allFields={allSchemaFields}
        tables={tablesData ?? []}
        permissions={permissions}
        onClose={() => {
          setFieldEditorOpen(false);
          setEditingFieldId(null);
          setEditingFieldMeta(null);
        }}
      />
    </div>
  );
}

// 简单条件匹配（行颜色用）
function matchCondition(value: CellValue, op: string, target: string): boolean {
  if (op === "isEmpty") return isEmptyValue(value);
  if (op === "isNotEmpty") return !isEmptyValue(value);
  const s = isEmptyValue(value) ? "" : formatCell(value, { type: "singleLineText" } as FieldDTO);
  if (op === "is") return s === target;
  if (op === "isNot") return s !== target;
  if (op === "contains") return s.includes(target);
  if (op === "gt") return Number(s) > Number(target);
  if (op === "lt") return Number(s) < Number(target);
  return false;
}

// 批量修改弹窗
function BulkEditModal({
  fields,
  onClose,
  onApply,
}: {
  fields: FieldDTO[];
  onClose: () => void;
  onApply: (fieldId: string, value: CellValue) => void;
}) {
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? "");
  const [value, setValue] = useState("");
  const field = fields.find((f) => f.id === fieldId);
  const numeric = ["number", "currency", "percent", "duration", "rating", "autoNumber"].includes(field?.type ?? "");
  const isSelect = field?.type === "singleSelect";

  return (
    <Modal open title="批量修改字段" onClose={onClose} footer={
      <>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          disabled={!fieldId}
          onClick={() => {
            let v: CellValue = value;
            if (numeric) v = value === "" ? null : Number(value);
            onApply(fieldId, v);
          }}
        >
          应用
        </Button>
      </>
    }>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-gx-12 text-gx-text-secondary">字段</span>
          <Select value={fieldId} onChange={(e) => { setFieldId(e.target.value as typeof fieldId); setValue(""); }} options={fields.map((f) => ({ value: f.id, label: f.name }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-gx-12 text-gx-text-secondary">新值</span>
          {isSelect && field?.options ? (
            <Select value={value} onChange={(e) => setValue(e.target.value)} options={[{ value: "", label: "清空" }, ...field.options.map((o) => ({ value: o.id, label: o.name }))]} />
          ) : (
            <Input type={numeric ? "number" : "text"} value={value} onChange={(e) => setValue(e.target.value)} placeholder="输入新值" />
          )}
        </div>
      </div>
    </Modal>
  );
}

// 客户端导出 CSV（避免绕过 API 直接请求）
function exportCsv(fields: FieldDTO[], records: RecordDTO[]) {
  // CSV 公式注入防护：=、+、-、@、制表符开头的单元格前导单引号强制为文本
  const esc = (raw: string) => {
    const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = fields.map((f) => esc(f.name));
  const rows = records.map((r) =>
    fields.map((f) => {
      const v = r.fields[f.id];
      if (v == null) return esc("");
      if (Array.isArray(v)) return esc(JSON.stringify(v));
      return esc(String(v));
    }),
  );
  const csv = [header, ...rows].map((row) => row.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "export.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export { GridView };
