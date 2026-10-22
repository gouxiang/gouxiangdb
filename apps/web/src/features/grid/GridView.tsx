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
import { ROW_HEIGHT_PX, HEADER_HEIGHT_PX } from "@gx/shared-types";
import { useFields, useTables, useGXMutations } from "../../api/hooks";
import { Tables } from "../../api/client";
import { useRecordsInfinite } from "../../api/records-paging-hooks";
import { isComputedInMem } from "../../api/records-paging";
import { EmptyState, IconButton, Modal, Select, Input, Button, toast, COLOR_PALETTE } from "../../components/ui";
import { SkeletonTable } from "../../components/states";
import { confirmSoftDelete } from "../../components/feedback";
// 阶段 4：R-D-15 延迟加载态 / R-I-26 防重复提交 / R-I-02 已加载 N 条 / R-I-05 列宽下限
import {
  BulkActionBar,
  MIN_COL_WIDTH,
  TriStateCheckbox,
  bulkDeleteText,
  loadedCountText,
  refreshingClass,
  toastDeleted,
  useDelayedFlag,
  useWriteGuard,
} from "../../components/interaction";
import { ResultNotice, DEGRADED_RESULT_TEXT } from "../common/ResultNotice";
import { useBreakpointTier } from "../../lib/breakpoint";
import { csvFileName } from "../../lib/file-name";
import GridToolbarSettingsRow from "./GridToolbarSettingsRow";
import { ImportWizard } from "./ImportWizard";
import { ExportDialog, type ExportScope } from "./ExportDialog";
import { RecordCardList } from "./RecordCardList";
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
  /** 视图配置由统一外壳（features/views/ViewShell）持有：第二行的搜索框写回同一份 config */
  config: ViewConfig;
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  /** 外壳第二行「新建记录」的同一个实现：网格空态复用它，避免两处各建一条草稿行 */
  onNewRecord: () => void;
}

const ROW_HEADER_W = 56;

// 「按选择」模式兜底色：选项缺 color（CSV 导入 / API 创建）时取调色板首色，避免整行不着色
const ROW_COLOR_FALLBACK = COLOR_PALETTE[0];

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

export default function GridView({
  baseId,
  tableId,
  viewId,
  view,
  permissions,
  onOpenRecord,
  config: cfg,
  onUpdateConfig,
  onNewRecord,
}: GridViewProps) {
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
  // 字段显隐面板的候选集：必须是「全部可列字段」而非「当前可见字段」。
  // 旧实现把 visibleFields（已按 view.hiddenFieldIds 过滤后的结果）传给面板，导致取消勾选后
  // 该字段立刻从面板列表里消失、用户无法再从界面勾回来（隐藏不可逆）。2026-09-18 真机验收发现。
  const gridManageableFields = useMemo(
    () => allSchemaFields.filter((f) => f.type !== "tabs" && f.type !== "subtable"),
    [allSchemaFields],
  );
  const groups = infiniteData.groups;
  const aggregations = infiniteData.aggregations;
  const filteredTotal = infiniteData.filteredTotal;
  const total = infiniteData.total;
  // S8：受限口径（computedInMem）——聚合/统计置灰标注，数据行仍正常显示可编辑。
  const degraded = isComputedInMem(infiniteData.degraded);

  const primaryFieldId = visibleFields[0]?.id ?? "";

  // 配置不再由网格自持：统一外壳 ViewShell 持有（第二行的搜索框要写同一份 config），
  // 这里只读 + 经 onUpdateConfig 写。切视图时外壳带 key={view.id} 重挂，配置随之重置。

  const [editing, setEditing] = useState<{ recordId: string; fieldId: string } | null>(null);
  const [active, setActive] = useState<{ recordId: string; fieldId: string } | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(600);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  // 字段编辑器的目标字段由 editingFieldMeta 单向驱动（FieldEditorSheet 只收这个 prop）。
  // 2026-09-20 清半截链路：原先还有一个只读不写的 editingFieldId state 与
  // 从未被调用的 onFieldCreated 回调（「新建字段后自动再开编辑器」能力实际没接上），
  // 两者全仓零读取，留着只会让人误以为有这条能力，故摘除。
  const [editingFieldMeta, setEditingFieldMeta] = useState<FieldDTO | null>(null);
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  // 表列表只供字段编辑器（关联字段候选表）使用；数据表图标入口已随外壳上提（六类视图都能改）。
  const { data: tablesData } = useTables(baseId);
  // R-I-26 写操作在途守卫（批量删除）
  const bulkGuard = useWriteGuard();
  // 导入 / 导出向导由统一外壳挂载（表级操作，六类视图共用），见 TableViewIoDialogs。
  // R-D-15：骨架屏 ≥300ms 才显示，避免「空白 → 骨架 → 内容」闪烁
  const showSkeleton = useDelayedFlag(isLoading);
  // R-D-27：局部刷新（续翻 / 筛选）保留旧内容 + 降透明度，不用骨架屏
  const locallyRefreshing = isFetchingNextPage;

  const scrollRef = useRef<HTMLDivElement>(null);
  const selection = useGridSelection();
  // R-D-32 / R-D-33：<1024 表格转卡片列表（表格在窄屏必然横向溢出；卡片单栏不横滚）。
  // 档位走 JS 是因为「表格 → 卡片」是结构替换，不是同一元素换 class。
  const tier = useBreakpointTier();
  const cardMode = tier === "sm" || tier === "md";

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

  // 写回 view.config 由外壳持有（见 ViewShell），网格只发局部更新。

  const widthOf = useCallback((f: FieldDTO) => colWidths[f.id] ?? defaultColWidth(f), [colWidths]);
  const resizeField = useCallback(
    (fieldId: string, delta: number) => {
      const f = visibleFields.find((x) => x.id === fieldId);
      if (!f) return;
      setColWidths((prev) => ({
        ...prev,
        // R-I-05：列宽拖拽最小 80px（此前是 60，低于规范下限）
        [fieldId]: Math.max(MIN_COL_WIDTH, (prev[fieldId] ?? defaultColWidth(f)) + delta),
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
    onUpdateConfig({ sorts: dir ? [...others, { fieldId, direction: dir }] : others });
  };

  // 隐藏字段
  const hideField = (fieldId: string) => {
    if (!cfg.hiddenFieldIds.includes(fieldId)) {
      onUpdateConfig({ hiddenFieldIds: [...cfg.hiddenFieldIds, fieldId] });
    }
  };
  // 阶段 4 · R-D-23 L2（软删除进回收站，可恢复）+ R-I-08（toast 带撤销）
  const deleteField = async (fieldId: string) => {
    if (!permissions.canManageSchema) return;
    const name = visibleFields.find((f) => f.id === fieldId)?.name ?? "该字段";
    const ok = await confirmSoftDelete({
      title: `删除字段「${name}」`,
      confirmText: "删除字段",
      description: "字段会移入回收站，30 天内可恢复；该列的数据会一并移入。",
    });
    if (!ok) return;
    try {
      await m.deleteField.mutateAsync({ fieldId, tableId, viewId });
      toastDeleted({
        message: `已删除字段「${name}」`,
        restoredMessage: `已恢复字段「${name}」`,
        onUndo: () => m.restoreTrash.mutateAsync({ id: fieldId, kind: "field", baseId }),
      });
    } catch (e) {
      toast((e as Error)?.message ?? "删除失败", "error");
    }
  };

  // 分组折叠
  const toggleGroup = (key: string) => {
    const collapsed = cfg.collapsedGroupKeys.includes(key)
      ? cfg.collapsedGroupKeys.filter((k) => k !== key)
      : [...cfg.collapsedGroupKeys, key];
    onUpdateConfig({ collapsedGroupKeys: collapsed });
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

  // PERM-03：无数据编辑权限（阅读者/评论者）不进入单元格编辑态。
  // 编辑坐标只在有权限时下发给 GridRow——「不渲染编辑器」而非「渲染到一半再 403」，
  // 与 PERM-01/02（导入/清空表入口无权限即不渲染）同一口径。
  // 判定复用 GridView 既有口径 permissions.canEditData（来自 base.permissions），不新造权限逻辑。
  const editingForRows = permissions.canEditData ? editing : null;

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
      const field = visibleFields.find((f) => f.id === rc.fieldId);
      if (!field) return null;
      const opt = resolveSelectOption(field, rec.fields[rc.fieldId]);
      // 无值或解析不到选项 → 不着色；选项存在但缺 color（CSV 导入 / API 创建）→ 调色板首色兜底
      if (!opt) return null;
      return opt.color ?? ROW_COLOR_FALLBACK;
    }
    if (rc.mode === "byCondition") {
      for (const c of rc.conditions) {
        if (matchCondition(rec.fields[c.fieldId], c.op, c.value)) return c.color;
      }
    }
    return null;
  };

  // ---------- 工具栏动作 ----------
  // 「新建记录」由统一外壳 ViewShell 提供（六类视图共用，见 ViewShell.onNewRecord），
  // 网格经 props.onNewRecord 复用同一个实现——空态入口与外壳按钮是同一条链路。
  //
  // R-I-15 批量删除 = L2 确认 + 可撤销；R-D-22 撤销窗口 6s
  // R-I-26：批量删除同样走写在途守卫，防止连点把同一批记录删两次。
  const onBulkDelete = async () => {
    const ids = Array.from(selection.selectedIds);
    if (ids.length === 0) return;
    const ok = await confirmSoftDelete({
      title: bulkDeleteText(ids.length, "行记录"),
      confirmText: bulkDeleteText(ids.length, "行记录"),
      description: "记录会先进入回收站，30 天内可恢复。",
      count: ids.length,
    });
    if (!ok) return;
    void bulkGuard.run("bulk-delete", async () => {
      try {
        await m.bulkDeleteRecords.mutateAsync({ ids, tableId, viewId });
        selection.clear();
        toastDeleted({
          message: `已删除 ${ids.length} 行`,
          restoredMessage: `已恢复 ${ids.length} 行`,
          onUndo: () => Promise.all(ids.map((id) => m.restoreTrash.mutateAsync({ id, kind: "record", baseId }))),
        });
      } catch (e) {
        toast((e as Error)?.message ?? "删除失败", "error");
      }
    });
  };
  const onClearSelection = () => selection.clear();
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
              <td className="sticky left-0 z-20 border-b border-r border-gx-hairline bg-gx-bg" style={{ width: ROW_HEADER_W, minWidth: ROW_HEADER_W }}>
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
              <td className="border-b border-gx-hairline px-2 py-1.5" colSpan={visibleFields.length} style={{ height: 36 }}>
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
                .map((rec) => (
                  <GridRow
                    key={rec.id}
                    record={rec}
                    fields={visibleFields}
                    widthOf={widthOf}
                    rowHeight={ROW_HEIGHT_PX[cfg.rowHeight]}
                    selected={selection.isSelected(rec.id)}
                    rowColor={rowColorOf(rec)}
                    activeFieldId={active?.recordId === rec.id ? active.fieldId : null}
                    editing={editingForRows}
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

  // R-I-13 表头三态：全选 / 部分选 / 未选（只按当前已加载行判定，符合"全选只作用于当前页"）
  const headerCheckState: "none" | "partial" | "all" =
    records.length > 0 && selection.count >= records.length
      ? "all"
      : selection.count > 0
        ? "partial"
        : "none";

  return (
    // v6 #984：白卡片已由 ViewShell 内层承载，网格根不再自带白底；三行之下直接是表格滚动区。
    <div className="flex h-full flex-col">
      {/* 统一外壳第三行：网格专属设置行（行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色）。
          这六项是网格行列概念，数据来自网格自己的无限滚动查询（filteredTotal / degradedCodes）
          与网格内的字段编辑器，所以留在这里渲染，而不是上提到外壳（见 ViewShell 文件头）。
          R-I-12：勾选后本行整行换成批量操作条；外壳前两行（标签条 / 搜索·导入导出）保持不变——
          批量操作时仍要能切视图、改搜索条件。 */}
      {selection.count > 0 ? (
        <BulkActionBar
          count={selection.count}
          total={filteredTotal}
          onSelectAll={() => selection.toggleAll(records.map((r) => r.id))}
          onClearSelection={onClearSelection}
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => setBulkEditOpen(true)}>
                批量修改字段…
              </Button>
              {/* R-I-14：批量操作前展示影响条数——按钮文案直接带条数 */}
              <Button size="sm" variant="danger" icon="trash" onClick={onBulkDelete}>
                {bulkDeleteText(selection.count, "行")}
              </Button>
            </>
          }
        />
      ) : (
        <GridToolbarSettingsRow
          config={cfg}
          allFields={gridManageableFields}
          degradedCodes={infiniteData.degraded ?? []}
          filteredTotal={filteredTotal}
          permissions={{ canEditData: permissions.canEditData, canManageSchema: permissions.canManageSchema }}
          onUpdateConfig={onUpdateConfig}
          onEditField={(id) => {
            if (id == null) {
              setEditingFieldMeta(null);
            } else {
              const found = allSchemaFields.find((f) => f.id === id) ?? null;
              setEditingFieldMeta(found);
            }
            setFieldEditorOpen(true);
          }}
        />
      )}

      {degraded && (
        <div className="shrink-0 border-b border-gx-separator px-3 py-1.5">
          <ResultNotice tone="warning" role="alert">
            数据量较大，当前为受限结果，精确统计需增加筛选条件。数据行仍可正常查看与编辑。
          </ResultNotice>
        </div>
      )}

      {showSkeleton ? (
        // R-D-15 / R-D-25 / R-D-26：首屏加载用与表格同构的骨架屏（3–8 行），不用全屏遮罩。
        // 且只有请求超过 300ms 才走到这里（R-D-15）；局部刷新按 R-D-27 保留旧内容。
        <div className="flex-1 overflow-hidden">
          <SkeletonTable rows={6} cols={Math.min(Math.max(visibleFields.length, 3), 6)} />
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          {/* R-D-13 首次空态必须有行动入口；只读角色隐藏写入口（R-N-16） */}
          <EmptyState
            icon="table"
            title="暂无记录"
            description={
              permissions.canEditData ? "点击「新建记录」开始添加数据。" : "这张表还没有数据。"
            }
            action={
              permissions.canEditData ? (
                <Button variant="primary" size="sm" icon="plus" onClick={onNewRecord}>
                  新建记录
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : cardMode ? (
        // R-D-32 / R-D-33：卡片列表（<1024）。能力与表格态一致：勾选、展开记录、
        // 行颜色、分组标题、续翻；仅呈现形态不同。
        <RecordCardList
          records={records}
          fields={visibleFields}
          primaryFieldId={primaryFieldId}
          groups={groups ?? null}
          selectedIds={selection.selectedIds}
          rowColorOf={rowColorOf}
          onToggleRowSelect={selection.toggle}
          onOpenRecord={(ref) => onOpenRecord?.(ref)}
          hasNextPage={hasNextPage}
          loadingMore={isFetchingNextPage}
          onLoadMore={() => loadMore()}
        />
      ) : (
        <div
          ref={scrollRef}
          tabIndex={0}
          className={clsx("flex-1 overflow-auto outline-none", refreshingClass(locallyRefreshing))}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          onKeyDown={onContainerKeyDown}
        >
          <table className="table-fixed border-separate border-spacing-0" style={{ width: totalWidth, minWidth: "100%" }}>
            <thead className="sticky top-0 z-10">
              <tr>
                <th
                  className="sticky left-0 z-30 border-b border-r border-gx-hairline bg-gx-table-header"
                  style={{ width: ROW_HEADER_W, minWidth: ROW_HEADER_W, height: HEADER_HEIGHT_PX }}
                >
                  {/* R-I-13 表头复选框三态：未选 / 部分选（横线）/ 全选，只作用于当前页。
                      1:1 底板 thead th.ckcell（padding-left12）：左对齐到与各行复选框同一条 12px 基线，不再居中。 */}
                  <div className="flex h-full items-center pl-3">
                    <TriStateCheckbox
                      state={headerCheckState}
                      onChange={() => selection.toggleAll(records.map((r) => r.id))}
                      label="选择本页全部记录"
                    />
                  </div>
                </th>
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
                {records.slice(start, end).map((rec) => {
                  const color = rowColorOf(rec);
                  return (
                    <GridRow
                      key={rec.id}
                      record={rec}
                      fields={visibleFields}
                      widthOf={widthOf}
                      rowHeight={rowH}
                      selected={selection.isSelected(rec.id)}
                      activeFieldId={active?.recordId === rec.id ? active.fieldId : null}
                      editing={editingForRows}
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
                      rowColor={color}
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
                  onUpdateConfig({ aggregations: { ...cfg.aggregations, [fieldId]: func } })
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

      {/* 状态栏（底板 .tfoot：h32、卡白底、border-top line-2、11.5 ink-4；卡圆角由卡 overflow 收） */}
      <div className="flex h-8 items-center gap-3 border-t border-t-gx-line-2 bg-gx-surface px-3 text-gx-11 text-gx-text-hint">
        <span>共 {total} 条</span>
        {/* R-I-02：无限滚动口径下底部要告诉用户「已加载 N 条」 */}
        <span>{loadedCountText(records.length, total)}</span>
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
          setEditingFieldMeta(null);
        }}
      />
    </div>
  );
}

/**
 * 导入 / 导出向导宿主：表级操作，与视图类型无关，故由统一外壳 ViewShell 为六类视图挂载一份。
 *
 * 执行侧（Tables.exportCsvText / ImportWizard 落库）一直放在本文件，不重写、不并行第二套实现：
 * 导出走服务端（按视图 / 整表），不受前端已加载行数限制；原先「客户端按当前可见字段拼 CSV」
 * 的实现已移除。未打开时不挂载数据 hook（ImportWizard 的门面已保证），首屏无额外请求。
 */
export function TableViewIoDialogs({
  baseId,
  tableId,
  viewId,
  viewName,
  tableName,
  importOpen,
  exportOpen,
  onCloseImport,
  onCloseExport,
}: {
  baseId: string;
  tableId: string;
  viewId: string;
  viewName?: string;
  tableName?: string | null;
  importOpen: boolean;
  exportOpen: boolean;
  onCloseImport: () => void;
  onCloseExport: () => void;
}) {
  // R-I-26：导出是写派生 + 下载，同样按 key 去重，防止连点触发两次服务端导出。
  const exportGuard = useWriteGuard();

  const runExport = async (scope: ExportScope) => {
    await exportGuard.run("export", async () => {
      try {
        const csv = await Tables.exportCsvText(tableId, scope === "view" ? viewId : undefined);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        // E-1：文件名用真实表名，不再把内部 tableId/viewId 抛给用户；表名缺失时退回 id 前缀。
        a.download = csvFileName(tableName, tableId, scope === "view" ? { name: viewName, id: viewId } : null);
        a.click();
        URL.revokeObjectURL(url);
        toast(scope === "view" ? "已导出当前视图" : "已导出整表", "success");
        onCloseExport();
      } catch (e) {
        toast(e instanceof Error ? e.message : "导出失败", "error");
      }
    });
  };

  return (
    <>
      <ImportWizard
        open={importOpen}
        tableId={tableId}
        viewId={viewId}
        baseId={baseId}
        onClose={onCloseImport}
      />
      <ExportDialog
        open={exportOpen}
        viewId={viewId}
        viewName={viewName}
        busy={exportGuard.isBusy("export")}
        onExport={runExport}
        onClose={onCloseExport}
      />
    </>
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

export { GridView };
