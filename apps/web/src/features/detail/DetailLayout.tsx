// apps/web/src/features/detail/DetailLayout.tsx
// 字段详情布局编辑器 + 渲染器
// 编辑器体验对齐 v1 DrawerLayout.swift：自动按行内字段数均分；行内/行间插入点；宽字段规则

import type { CellValue, DetailLayout, DetailLayoutRow, DetailRowColumns, FieldDTO, FieldIdT, FieldType, FieldWidthPct, FilterNode, PermissionSet, RecordDTO, RecordIdT, TabConfig, TableDTO } from "@gx/shared-types";
import { evalFilter, fieldWidth, layoutRowLines } from "@gx/shared-types";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { Button, FieldIcon, Modal, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { MdContent } from "../../components/MdContent";
import { optionTone } from "../../components/interaction";
import { AttachmentLinks } from "../cells/AttachmentLinks";
import { openFilePreview } from "../attachments/preview-opener";
import { attachmentFromLink } from "../attachments/policy";
// 抽屉里的只读值此前完全没有日期分支，日期/公式时间值按原串直出；统一走
// formatCell 的日期口径，与网格单元格、卡片保持同一套显示规则。
import { fmtDateTime, formatCell, isIsoDatetimeLike } from "../cells/format";
import { useFields, useGXMutations, useRecords } from "../../api/hooks";
import { useLinkCandidates } from "../../api/records-paging-hooks";
import { ResultNotice, LINK_NARROW_TEXT } from "../common/ResultNotice";
import { FieldInput, FieldValue, isReadonlyField } from "../views/field-controls";
import { MemberDisplay, useMemberRoster } from "../contacts/member-roster";
import { FormDesigner } from "./FormDesigner";
import { deriveDefaultDetailLayout } from "./default-detail-layout";

// 宽字段类型（与 v1 DrawerLayoutStore.isWide 一致）：独占一行
const WIDE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["longText", "richText", "attachment", "links", "tabs", "subtable"]);
const isWide = (t: FieldType): boolean => WIDE_TYPES.has(t);

const READONLY_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(["formula", "rollup", "count", "lookup", "autoNumber", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy", "tabs"]);

interface DetailLayoutEditorProps {
  open: boolean;
  fields: FieldDTO[];
  layout: DetailLayout | null;
  tableId: string;
  baseId: string;
  tables: TableDTO[];
  permissions: PermissionSet;
  /**
   * 布局版本历史的归属视图 id（版本是视图级的）。缺省时设计器的「历史」入口禁用。
   */
  viewId?: string | null;
  onClose: () => void;
  /**
   * 保存布局。**必须返回 Promise，失败必须 reject**（三个调用方统一改用 mutateAsync）。
   * 成功/失败的 toast 与「是否关闭面板」由 FormDesigner 判定，这里只做透传 —— 避免
   * 两层各弹一次 toast、且其中一层拿不到失败信号（P1 静默数据丢失）。
   */
  onSave: (next: DetailLayout) => Promise<void>;
  /** inline=true：作为页面主体渲染，不包 Modal */
  inline?: boolean;
}

export function DetailLayoutEditor({ open, fields, layout, tableId, baseId, tables, permissions, viewId, onClose, onSave, inline }: DetailLayoutEditorProps) {
  // 只透传 Promise：成功 toast + 关闭面板交给 FormDesigner（它 await 得到结果）。
  const handleSave = (next: DetailLayout): Promise<void> => onSave(next);

  return (
    <FormDesigner
      open={open}
      inline={inline}
      fields={fields}
      layout={layout}
      tableId={tableId}
      baseId={baseId}
      tables={tables}
      permissions={permissions}
      viewId={viewId}
      onClose={onClose}
      onSave={handleSave}
    />
  );
}

// ============ 详情渲染器（按 widths 流体布局；宽字段自动整行；tabs 字段独立渲染为选项卡） ============

interface DetailLayoutRendererProps {
  fields: FieldDTO[];
  values: Record<string, CellValue>;
  layout: DetailLayout | null;
  tableId: string;
  recordId: string;
  permissions: PermissionSet;
}

export function DetailLayoutRenderer({ fields, values, layout, tableId, recordId, permissions }: DetailLayoutRendererProps) {
  const canEdit = permissions.canEditData;
  // 归属任一选项卡容器的字段：只在对应 TabsPanel 内渲染，顶层普通流不再重复
  const inTabs = new Set<string>();
  for (const f of fields) {
    if (f.type === "tabs") for (const t of f.tabsConfig ?? []) for (const id of t.fieldIds ?? []) inTabs.add(id);
  }
  // 没保存过布局（或布局为空）时用与设计器同一份推导，避免「详情页看到的」与
  // 「第一次打开设计器看到的」不一致、必须先保存一次才生效。
  const effective = !layout || layout.rows.length === 0 ? deriveDefaultDetailLayout(fields) : layout;
  return (
    <div className="space-y-4 p-3">
      {effective.rows.map((row, idx) => {
        const rowFields = row.fieldIds.map((id) => fields.find((f) => f.id === id)).filter((f): f is FieldDTO => !!f);
        const tabFields = rowFields.filter((f) => f.type === "tabs");
        const subtableFields = rowFields.filter((f) => f.type === "subtable");
        // 归属选项卡的字段只在 TabsPanel 内渲染；这里排除，避免重复
        const normalFields = rowFields.filter((f) => f.type !== "tabs" && f.type !== "subtable" && !inTabs.has(f.id));
        // 按 widths 把一行拆成若干自动换行的"行线"（隐式行）
        const lines = layoutRowLines(row).map((lineIds) =>
          lineIds.map((id) => normalFields.find((f) => f.id === id)).filter((f): f is FieldDTO => !!f)
        );

        return (
          <div key={idx} className="space-y-2">
            {tabFields.map((f) => (
              <TabsPanel key={f.id} field={f} allFields={fields} values={values} tableId={tableId} recordId={recordId} canEdit={canEdit} />
            ))}
            {lines.map((line, li) => (
              <div key={li} className="flex flex-wrap">
                {line.map((f, idx) => {
                  const w = fieldWidth(row, f.id);
                  return (
                    <div key={f.id} style={{ flex: `0 0 ${w}%`, maxWidth: `${w}%` }} className="min-w-0 px-1 first:pl-0 last:pr-0">
                      <DetailCell field={f} value={values[f.id]} tableId={tableId} recordId={recordId} canEdit={canEdit} />
                    </div>
                  );
                })}
              </div>
            ))}
            {subtableFields.map((f) => (
              <SubtablePanel
                key={f.id}
                field={f}
                allFields={fields}
                values={values}
                tableId={tableId}
                recordId={recordId}
                canEdit={canEdit}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ============ Tabs 字段面板（选项卡 + 当前 tab 下的字段）============

interface TabsPanelProps {
  field: FieldDTO;
  allFields: FieldDTO[];
  values: Record<string, CellValue>;
  tableId: string;
  recordId: string;
  canEdit: boolean;
}

/** 把单个 TabConfig 解析为显式行（每行 FieldDTO[]），与设计器所见即所得一致。
 *  有 rows 用 rows（保留 ▼ 拆出的行边界）；无 rows（旧数据）用 fieldIds+widths 按宽度自动切行。 */
function tabToRows(tab: TabConfig | undefined, allFields: FieldDTO[]): { fields: FieldDTO[]; widths: Record<string, number> }[] {
  if (!tab) return [];
  const resolve = (id: string): { f: FieldDTO; w: number } | null => {
    const f = allFields.find((x) => x.id === id);
    if (!f || f.type === "tabs") return null;
    const w = tab.widths?.[id] ?? (WIDE_TYPES.has(f.type) ? 100 : 50);
    return { f, w };
  };
  if (tab.rows && tab.rows.length > 0) {
    return tab.rows.map((r) => {
      const resolved = r.items.map((it) => resolve(it.fieldId)).filter((x): x is { f: FieldDTO; w: number } => !!x);
      return { fields: resolved.map((x) => x.f), widths: Object.fromEntries(resolved.map((x) => [x.f.id, x.w])) };
    });
  }
  // 旧数据：按 widths 累加切行
  const rows: { fields: FieldDTO[]; widths: Record<string, number> }[] = [];
  let curFields: FieldDTO[] = [];
  let curWidths: Record<string, number> = {};
  let sum = 0;
  for (const id of tab.fieldIds ?? []) {
    const r = resolve(id);
    if (!r) continue;
    if (curFields.length > 0 && sum + r.w > 100) {
      rows.push({ fields: curFields, widths: curWidths });
      curFields = []; curWidths = {}; sum = 0;
    }
    curFields.push(r.f); curWidths[r.f.id] = r.w; sum += r.w;
  }
  if (curFields.length > 0) rows.push({ fields: curFields, widths: curWidths });
  return rows;
}

function TabsPanel({ field, allFields, values, tableId, recordId, canEdit }: TabsPanelProps) {
  const [activeTab, setActiveTab] = useState(0);
  const tabs = field.tabsConfig ?? [];
  const safeIdx = Math.max(0, Math.min(activeTab, Math.max(0, tabs.length - 1)));
  const currentTab = tabs[safeIdx];
  // 显式行模型：有 rows 按 rows 渲染（保留行边界），否则回退 fieldIds 自动切行
  const rows = tabToRows(currentTab, allFields);
  const totalFields = rows.reduce((s, r) => s + r.fields.length, 0);

  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-surface">
      {/* tab bar */}
      <div className="flex border-b border-gx-separator">
        {tabs.length === 0 && <span className="px-3 py-1.5 text-gx-12 text-gx-text-hint">该字段尚未配置选项卡</span>}
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(i)}
            className={clsx(
              "border-b-2 px-3 py-1.5 text-gx-13 transition-colors",
              safeIdx === i
                ? "border-gx-accent font-medium text-gx-accent"
                : "border-transparent text-gx-text-secondary hover:bg-gx-bg",
            )}
          >
            {tab.name || `选项卡 ${i + 1}`}
          </button>
        ))}
      </div>
      {/* 当前 tab 下的字段：按显式行横向多列排列（与设计器所见即所得） */}
      <div className="p-2">
        {totalFields === 0 ? (
          <div className="py-4 text-center text-gx-12 text-gx-text-hint">该选项卡下还没有字段</div>
        ) : (
          <div className="space-y-1">
            {rows.map((row, ri) => (
              <div key={ri} className="flex flex-wrap">
                {row.fields.map((f) => {
                  // 子表格在选项卡内也渲染为完整子表面板（全宽）
                  if (f.type === "subtable") {
                    return (
                      <div key={f.id} className="min-w-0 flex-[0_0_100%] max-w-full px-1 py-1">
                        <SubtablePanel
                          field={f}
                          allFields={allFields}
                          values={values}
                          tableId={tableId}
                          recordId={recordId}
                          canEdit={canEdit}
                        />
                      </div>
                    );
                  }
                  const w = row.widths[f.id] ?? 50;
                  return (
                    <div key={f.id} style={{ flex: `0 0 ${w}%`, maxWidth: `${w}%` }} className="min-w-0 px-1 py-1">
                      <DetailCell field={f} value={values[f.id]} tableId={tableId} recordId={recordId} canEdit={canEdit} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 子表格字段面板（内嵌网格 + 添加/选择/编辑/删除 完整闭环）============

interface SubtablePanelProps {
  field: FieldDTO;
  allFields: FieldDTO[];
  values: Record<string, CellValue>;
  tableId: string;
  recordId: string;
  canEdit: boolean;
}

interface SubRef {
  recordId: string;
  title: string;
}

function SubtablePanel({ field, values, tableId, recordId, canEdit }: SubtablePanelProps) {
  const m = useGXMutations();
  // 本记录子表格字段当前已链接的对面表记录（来自 hydration 后的 LinkRef 数组）
  const linkedRefs = useMemo<SubRef[]>(() => {
    const v = values[field.id];
    if (!Array.isArray(v)) return [];
    return (v as { recordId: string; title: string }[]).map((r) => ({ recordId: r.recordId, title: r.title }));
  }, [values, field.id]);

  const peerTableId = field.relatedTableId ?? "";
  const { data: peerTableFieldsData } = useFields(peerTableId || null);
  const { data: peerRecordsRes } = useRecords({ tableId: peerTableId || null });

  // 展示列：优先设计器勾选的 displayedFieldIds（保序），未配置取对面表前 4 个可显示字段
  const columns = useMemo(() => {
    const all = (peerTableFieldsData ?? []).filter((f) => f.type !== "tabs" && f.type !== "subtable");
    if (field.displayedFieldIds && field.displayedFieldIds.length > 0) {
      const order = new Map((field.displayedFieldIds as string[]).map((id, i) => [id, i]));
      return all
        .filter((f) => (field.displayedFieldIds as string[]).includes(f.id))
        .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
    }
    return all.slice(0, 4);
  }, [peerTableFieldsData, field.displayedFieldIds]);

  // 「选择数据」弹窗列：优先 visibleFieldIds（与内嵌显示列独立），未配置回退显示列
  const pickerColumns = useMemo(() => {
    const all = (peerTableFieldsData ?? []).filter((f) => f.type !== "tabs" && f.type !== "subtable");
    const vis = (field as { visibleFieldIds?: string[] | null }).visibleFieldIds;
    if (vis && vis.length > 0) {
      const order = new Map(vis.map((id, i) => [id, i]));
      return all
        .filter((f) => vis.includes(f.id))
        .sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
    }
    return columns;
  }, [peerTableFieldsData, field, columns]);

  // 对面表记录按 id 索引（用于取各列真实值渲染）
  const peerRecordById = useMemo(() => {
    const map = new Map<string, RecordDTO>();
    for (const r of peerRecordsRes?.records ?? []) map.set(r.id, r);
    return map;
  }, [peerRecordsRes]);

  // recordFilter：字段级关联筛选（选择数据时只列满足条件的对面表记录）
  const recordFilter = field.recordFilter ?? null;

  const commitLinks = async (nextRefs: SubRef[]) => {
    try {
      await m.updateRecord.mutateAsync({
        recordId,
        tableId,
        fields: { [field.id]: nextRefs },
      });
    } catch (err) {
      toast((err as Error).message || "更新关联失败", "error");
    }
  };

  // 弹窗状态：select=选择数据；add=添加数据（二级新建）
  const [modal, setModal] = useState<null | "select" | "add">(null);
  // 编辑中的对面表记录 id
  const [editingPeerId, setEditingPeerId] = useState<string | null>(null);

  const handleUnlink = (childRecordId: string) => {
    const next = linkedRefs.filter((r) => r.recordId !== childRecordId);
    void commitLinks(next);
  };

  // 添加数据：新建对面表记录并自动挂接到本子表格
  const handleCreatePeer = async (fields2: Record<string, unknown>) => {
    try {
      const { record: created } = await m.createRecord.mutateAsync({ tableId: peerTableId, fields: fields2 });
      if (!created) return;
      const newId = created.id;
      const titleField = columns[0];
      const title = titleField ? String((created.fields as Record<string, unknown>)[titleField.id] ?? newId.slice(0, 8)) : newId.slice(0, 8);
      await commitLinks([...linkedRefs, { recordId: newId, title }]);
      toast("已添加并关联", "success");
      setModal(null);
    } catch (err) {
      toast((err as Error).message || "添加失败", "error");
    }
  };

  // 选择数据：把勾选的对面表记录加入本子表格
  const handlePick = (picked: SubRef[]) => {
    const existing = new Set(linkedRefs.map((r) => r.recordId));
    const merged = [...linkedRefs];
    for (const p of picked) if (!existing.has(p.recordId)) merged.push(p);
    void commitLinks(merged);
    setModal(null);
  };

  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-surface">
      <div className="flex items-center gap-2 border-b border-gx-separator px-3 py-2">
        <FieldIcon type={field.type} size={13} />
        <span className="text-gx-12 font-medium text-gx-text-primary">{field.name}</span>
        <span className="text-gx-10 text-gx-text-hint">{linkedRefs.length} 条</span>
        {canEdit && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setModal("add")}
              className="inline-flex items-center gap-1 rounded-gx-sm border border-gx-border px-2 py-0.5 text-gx-11 text-gx-text-secondary hover:bg-gx-accent-bg hover:text-gx-accent"
              title="在关联表新建一条记录并加入本子表格"
            >
              <Icon name="plus" size={11} /> 添加数据
            </button>
            <button
              type="button"
              onClick={() => setModal("select")}
              className="inline-flex items-center gap-1 rounded-gx-sm border border-gx-border px-2 py-0.5 text-gx-11 text-gx-text-secondary hover:bg-gx-accent-bg hover:text-gx-accent"
              title="从关联表现有记录中勾选加入本子表格"
            >
              <Icon name="check" size={11} /> 选择数据
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-gx-12">
          <thead>
            <tr className="border-b border-gx-separator bg-gx-bg/40">
              {/* 即使无数据也按设计器勾选字段渲染表头（④空态表头） */}
              {columns.map((c) => (
                <th key={c.id} className="px-2 py-1 text-left text-gx-11 font-medium text-gx-text-secondary">
                  <div className="flex items-center gap-1">
                    <FieldIcon type={c.type} size={11} />
                    <span className="truncate">{c.name}</span>
                  </div>
                </th>
              ))}
              {canEdit && <th className="w-16 px-2 py-1 text-right text-gx-11 font-medium text-gx-text-tertiary">操作</th>}
            </tr>
          </thead>
          <tbody>
            {linkedRefs.length === 0 && (
              <tr>
                <td colSpan={columns.length + (canEdit ? 1 : 0)} className="px-2 py-6 text-center text-gx-12 text-gx-text-hint">
                  暂无数据 — 点击右上角「添加数据」新建，或「选择数据」从关联表勾选
                </td>
              </tr>
            )}
            {linkedRefs.map((ref) => {
              const peer = peerRecordById.get(ref.recordId);
              return (
                <tr key={ref.recordId} className="border-b border-gx-separator last:border-b-0 hover:bg-gx-bg/30">
                  {columns.map((c, i) => (
                    <td key={c.id} className="max-w-[220px] truncate px-2 py-1 align-top">
                      {peer ? (
                        <FieldValue field={c} value={(peer.fields as Record<string, CellValue>)[c.id] ?? null} emptyText="—" />
                      ) : i === 0 ? (
                        <span className="rounded-gx-sm bg-gx-bg px-1.5 py-0.5 text-gx-11 text-gx-text-secondary">{ref.title}</span>
                      ) : (
                        <span className="text-gx-11 text-gx-text-hint">—</span>
                      )}
                    </td>
                  ))}
                  {canEdit && (
                    <td className="whitespace-nowrap px-2 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => setEditingPeerId(ref.recordId)}
                        className="mr-1 rounded-full p-1 text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent"
                        title="编辑该关联记录"
                      >
                        <Icon name="edit" size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUnlink(ref.recordId)}
                        className="rounded-full p-1 text-gx-text-hint hover:bg-gx-danger-bg hover:text-gx-danger"
                        title="从本子表格移除（解除关联，不删除关联表记录）"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 选择数据弹窗：Portal 到 body——抽屉带 transform 会破坏 fixed 定位/层叠 */}
      {modal === "select" && createPortal(
        <PeerRecordPickerModal
          peerTableId={peerTableId}
          columns={pickerColumns}
          recordFilter={recordFilter}
          selfValues={values as Record<string, never>}
          linkedIds={new Set(linkedRefs.map((r) => r.recordId))}
          onClose={() => setModal(null)}
          onConfirm={handlePick}
        />,
        document.body,
      )}

      {/* 添加数据弹窗：二级新建对面表记录 */}
      {modal === "add" && createPortal(
        <PeerRecordCreateModal
          peerTableId={peerTableId}
          columns={columns}
          allPeerFields={peerTableFieldsData ?? []}
          onClose={() => setModal(null)}
          onCreate={handleCreatePeer}
        />,
        document.body,
      )}

      {/* 编辑数据弹窗：编辑已关联的对面表记录 */}
      {editingPeerId && createPortal(
        <PeerRecordEditModal
          peerTableId={peerTableId}
          peerRecordId={editingPeerId}
          columns={columns}
          allPeerFields={peerTableFieldsData ?? []}
          onClose={() => setEditingPeerId(null)}
          onSaved={() => { setEditingPeerId(null); toast("已保存", "success"); }}
        />,
        document.body,
      )}
    </div>
  );
}

/** 取对面表记录的标题（用于 LinkRef.title） */
function peerTitle(rec: { fields: Record<string, unknown> } | undefined, columns: FieldDTO[], fallback: string): string {
  const titleField = columns[0];
  if (titleField && rec) {
    const v = rec.fields[titleField.id];
    if (v != null && v !== "") return String(v);
  }
  return fallback.slice(0, 8);
}

/** 选择数据弹窗：搜索 + 应用 recordFilter + 复选勾选 */
function PeerRecordPickerModal({
  peerTableId,
  columns,
  recordFilter,
  selfValues,
  linkedIds,
  onClose,
  onConfirm,
}: {
  peerTableId: string;
  columns: FieldDTO[];
  recordFilter: FilterNode | null;
  selfValues?: Record<string, CellValue>;
  linkedIds: Set<string>;
  onClose: () => void;
  onConfirm: (picked: SubRef[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // 服务端限量（50/页）+ 关键字搜索（hook 内 250ms 防抖），绝不一次拉全表。
  const candidatesQuery = useLinkCandidates({ tableId: peerTableId, search: query });

  const titleField = columns[0];
  const selfVals = selfValues ?? {};
  const candidates = useMemo(() => {
    return candidatesQuery.records.filter((r) => {
      if (linkedIds.has(r.id)) return false;
      // 应用字段级关联筛选（「匹配字段」取父记录本表值）。关键字搜索由服务端完成。
      if (recordFilter) {
        const ok = evalFilter(
          recordFilter,
          (fid) => (r.fields as Record<string, unknown>)[fid] as never,
          (selfFid) => (selfVals as Record<string, unknown>)[selfFid] as never,
        );
        if (!ok) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesQuery.records, linkedIds, recordFilter, selfValues]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    const picked: SubRef[] = [];
    for (const r of candidatesQuery.records) {
      if (checked.has(r.id)) {
        picked.push({ recordId: r.id, title: peerTitle(r as { fields: Record<string, unknown> }, columns, r.id) });
      }
    }
    // 已勾选但不在当前候选页（搜索后翻页/换关键字）的项：用 columns 首列取不到标题时回退 id 前缀。
    for (const id of checked) {
      if (candidatesQuery.records.some((r) => r.id === id)) continue;
      picked.push({ recordId: id, title: id.slice(0, 8) });
    }
    onConfirm(picked);
  };

  return (
    <Modal open onClose={onClose} title="选择关联记录" width={640}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={checked.size === 0} onClick={confirm}>
            添加选中（{checked.size}）
          </Button>
        </>
      }
    >
      <div className="mb-2 flex items-center gap-2 rounded-gx-lg border border-gx-border bg-gx-bg px-2 py-1.5">
        <Icon name="search" size={13} className="text-gx-text-hint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索（按首列字段）"
          className="flex-1 bg-transparent text-gx-13 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
        />
      </div>
      {recordFilter && (
        <div className="mb-2 rounded-gx-sm bg-gx-accent-bg/50 px-2 py-1 text-gx-11 text-gx-accent">已应用字段默认筛选条件</div>
      )}
      {candidatesQuery.needNarrow && (
        <div className="mb-2">
          <ResultNotice tone="warning">{LINK_NARROW_TEXT}</ResultNotice>
        </div>
      )}
      <div className="max-h-[50vh] overflow-y-auto rounded-gx-lg border border-gx-border">
        <table className="w-full text-gx-12">
          <thead className="sticky top-0">
            <tr className="border-b border-gx-separator bg-gx-table-header">
              <th className="w-8 px-2 py-1.5" />
              {columns.map((c) => (
                <th key={c.id} className="px-2 py-1.5 text-left text-gx-11 font-medium text-gx-text-secondary">{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {candidatesQuery.isLoading ? (
              <tr><td colSpan={columns.length + 1} className="px-2 py-8 text-center text-gx-12 text-gx-text-hint">加载中…</td></tr>
            ) : candidates.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-2 py-8 text-center text-gx-12 text-gx-text-hint">没有可选择的记录</td></tr>
            ) : candidates.map((r) => (
              <tr
                key={r.id}
                onClick={() => toggle(r.id)}
                className={clsx("cursor-pointer border-b border-gx-separator last:border-b-0 hover:bg-gx-accent-bg/30", checked.has(r.id) && "bg-gx-accent-bg/40")}
              >
                <td className="px-2 py-1.5">
                  <input type="checkbox" checked={checked.has(r.id)} readOnly className="h-3.5 w-3.5 accent-gx-accent" />
                </td>
                {columns.map((c) => (
                  <td key={c.id} className="max-w-[200px] truncate px-2 py-1.5">
                    <FieldValue field={c} value={(r.fields as Record<string, CellValue>)[c.id] ?? null} emptyText="—" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/** 可编辑字段（排除只读/计算/系统/容器） */
function editablePeerFields(all: FieldDTO[]): FieldDTO[] {
  return all.filter((f) => !isReadonlyField(f) && f.type !== "tabs" && f.type !== "subtable" && f.type !== "links");
}

/**
 * 子表格添加/编辑弹窗的字段顺序：子表格配置的显示字段（displayedFieldIds）优先，
 * 其余可编辑字段追加在后——保证用户首先编辑的就是子表格里看得到的列。
 */
function buildPeerEditFields(columns: FieldDTO[], allPeerFields: FieldDTO[]): FieldDTO[] {
  const colIds = new Set(columns.map((c) => c.id));
  const inCols = columns.filter((c) => !isReadonlyField(c) && c.type !== "links");
  const rest = editablePeerFields(allPeerFields).filter((f) => !colIds.has(f.id));
  return [...inCols, ...rest];
}

/** 添加数据：二级新建表单 */
function PeerRecordCreateModal({
  peerTableId,
  columns,
  allPeerFields,
  onClose,
  onCreate,
}: {
  peerTableId: string;
  columns: FieldDTO[];
  allPeerFields: FieldDTO[];
  onClose: () => void;
  onCreate: (fields: Record<string, unknown>) => void;
}) {
  const editFields = useMemo(
    () => buildPeerEditFields(columns, allPeerFields),
    [columns, allPeerFields],
  );
  const [draft, setDraft] = useState<Record<string, CellValue>>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await onCreate(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="添加数据（新建关联记录）" width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={saving} onClick={submit}>保存并加入</Button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-2 overflow-y-auto">
        {editFields.length === 0 && <div className="py-6 text-center text-gx-12 text-gx-text-hint">该关联表无可编辑字段</div>}
        {editFields.map((f) => (
          <div key={f.id} className="flex items-start gap-2">
            <div className="flex w-24 shrink-0 items-center gap-1 pt-1.5 text-gx-12 text-gx-text-secondary">
              <FieldIcon type={f.type} size={11} />
              <span className="truncate">{f.name}</span>
            </div>
            <div className="min-w-0 flex-1">
              <FieldInput field={f} value={draft[f.id] ?? null} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** 编辑数据：编辑已关联的对面表记录 */
function PeerRecordEditModal({
  peerTableId,
  peerRecordId,
  columns,
  allPeerFields,
  onClose,
  onSaved,
}: {
  peerTableId: string;
  peerRecordId: string;
  columns: FieldDTO[];
  allPeerFields: FieldDTO[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data } = useRecords({ tableId: peerTableId });
  const m = useGXMutations();
  const rec = data?.records.find((r) => r.id === peerRecordId);
  const editFields = useMemo(() => buildPeerEditFields(columns, allPeerFields), [columns, allPeerFields]);
  const [draft, setDraft] = useState<Record<string, CellValue>>({});
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (rec && !ready) {
      const init: Record<string, CellValue> = {};
      for (const f of editFields) init[f.id] = (rec.fields as Record<string, CellValue>)[f.id] ?? null;
      setDraft(init);
      setReady(true);
    }
  }, [rec, editFields, ready]);

  const save = async () => {
    setSaving(true);
    try {
      // 只提交有变化的字段
      const changed: Record<string, unknown> = {};
      for (const f of editFields) {
        const orig = (rec?.fields as Record<string, CellValue> | undefined)?.[f.id] ?? null;
        if (JSON.stringify(draft[f.id] ?? null) !== JSON.stringify(orig)) changed[f.id] = draft[f.id] ?? null;
      }
      if (Object.keys(changed).length > 0) {
        await m.updateRecord.mutateAsync({ recordId: peerRecordId, tableId: peerTableId, fields: changed });
      }
      onSaved();
    } catch (err) {
      toast((err as Error).message || "保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="编辑关联记录" width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={saving || !rec} onClick={save}>保存</Button>
        </>
      }
    >
      {!rec ? (
        <div className="py-8 text-center text-gx-12 text-gx-text-hint">加载中…</div>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {editFields.map((f) => (
            <div key={f.id} className="flex items-start gap-2">
              <div className="flex w-24 shrink-0 items-center gap-1 pt-1.5 text-gx-12 text-gx-text-secondary">
                <FieldIcon type={f.type} size={11} />
                <span className="truncate">{f.name}</span>
              </div>
              <div className="min-w-0 flex-1">
                <FieldInput field={f} value={draft[f.id] ?? null} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function DetailCell({ field, value, tableId, recordId, canEdit }: { field: FieldDTO; value: CellValue | undefined; tableId: string; recordId: string; canEdit: boolean }) {
  const [draft, setDraft] = useState<CellValue | undefined>(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const m = useGXMutations();
  const readOnly = !canEdit || READONLY_TYPES.has(field.type);
  // 附件字段必须「onChange 即提交」，不能等失焦：AttachmentUploader 没有也不需要
  // onBlur 通道（上传/移除都是显式动作，不存在"改了一半"的中间态），而 DetailCell
  // 的失焦提交对它永远不触发 → 文件传上去了、记录字段却存不进，刷新后附件全丢
  // （2026-10-03 飞牛真机实测踩到）。与网格 CellEditor 的 AttachmentEditor 同口径：
  // onChange(next) 直接 onCommit(next)。
  const commitWith = async (next: CellValue | undefined) => {
    setEditing(false);
    if (JSON.stringify(next) === JSON.stringify(value)) return;
    try { await m.updateRecord.mutateAsync({ recordId, fields: { [field.id]: next }, tableId }); }
    catch (err) { toast((err as Error).message, "error"); setDraft(value); }
  };
  const commit = async () => commitWith(draft);
  const isImmediateCommit = field.type === "attachment";
  const handleChange = (v: CellValue) => {
    setDraft(v);
    if (isImmediateCommit) void commitWith(v);
  };
  return (
    // 标签上置（UI-SPEC R-F-06：标签统一上置，左置仅允许行内编辑/筛选条）。
    // 旧实现是左置 label + flex-1 值区，一行放两个字段时值区只剩几十像素被挤压；
    // 且 label 写了内联的像素级宽度上限（绕开间距令牌）。改为纵向两行后
    // 值区始终占满整格宽度，长字段名由容器 min-w-0 + 文本 truncate 收口。
    <div className="flex min-w-0 flex-col gap-1.5 rounded-gx-sm border border-gx-border bg-gx-surface px-3 py-2">
      {/* 第一行：字段名（图标 + 名称） */}
      <div className="flex min-w-0 items-center gap-1 text-gx-12 text-gx-text-secondary">
        <span className="flex shrink-0 items-center">
          <FieldIcon type={field.type} size={12} />
        </span>
        <span className="truncate">{field.name}</span>
      </div>
      {/* 第二行：值区，占满整格宽度 */}
      <div className="min-w-0">
        {editing && !readOnly
          // 附件上下文：tableId/recordId 本组件本来就有，必须透传给上传器。
          // 不传的话上传器只能靠路由兜底拿到 baseId/tableId，recordId 为空 —— 附件行
          // 落库时没有归属记录，记录删除/清空时后端按 recordId 的悬挂清理与「仍被引用」
          // 判定都覆盖不到它，文件会一直留在磁盘上。baseId 仍留给上传器从
          // /base/:baseId/table/:tableId 路由推导（本组件拿不到）。
          ? <FieldInput field={field} value={draft ?? null} onChange={handleChange} autoFocus onBlur={commit} attachmentContext={{ tableId, recordId }} />
          : (
            <button type="button" disabled={readOnly} onClick={() => !readOnly && setEditing(true)} className={clsx("block w-full rounded-gx-sm px-1 py-0.5 text-left", readOnly ? "cursor-default text-gx-text-tertiary" : "hover:bg-gx-bg")}>
              <ReadValue field={field} value={value} />
            </button>
          )}
      </div>
    </div>
  );
}

function ReadValue({ field, value }: { field: FieldDTO; value: CellValue | undefined }) {
  if (value === null || value === undefined || value === "") return <span className="text-gx-13 text-gx-text-hint">—</span>;
  if (field.type === "checkbox") {
    return value === true
      ? <Icon name="check" size={14} className="text-gx-accent" />
      : <span className="inline-block h-3.5 w-3.5 rounded border border-gx-border" />;
  }
  if (field.type === "rating") {
    const n = Math.min(5, Math.max(0, Number(value) || 0));
    return (
      <span className="inline-flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Icon key={i} name="star" size={13} className={i <= n ? "text-gx-warning" : "text-gx-text-hint"} fill={i <= n ? "currentColor" : "none"} />
        ))}
      </span>
    );
  }
  if (field.type === "links") {
    const arr = Array.isArray(value) ? value : [];
    return (
      <span className="inline-flex flex-wrap gap-1">
        {arr.map((v: unknown, i: number) => {
          const ref = v as { title: string };
          return <span key={i} className="inline-flex items-center rounded-gx-sm bg-gx-accent-bg px-2 py-0.5 text-gx-12 text-gx-accent">{ref?.title ?? "..."}</span>;
        })}
      </span>
    );
  }
  if (field.type === "singleSelect" || field.type === "multiSelect") {
    const arr = Array.isArray(value) ? value : [value];
    return (
      <span className="inline-flex flex-wrap gap-1">
        {arr.map((v, i) => {
          const opt = (field.options ?? []).find((o) => o.id === v || o.name === v);
          // 与 StatusPill/SelectPill 同一混色口径（#693）；缺色/非法走 gx token
          const style = optionTone(opt?.color);
          return (
            <span
              key={i}
              className={clsx(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-gx-11 font-medium",
                style ? "" : "border-gx-border bg-gx-row-hover text-gx-text-secondary",
              )}
              style={style}
            >
              {opt?.name ?? (typeof v === "string" ? v : JSON.stringify(v))}
            </span>
          );
        })}
      </span>
    );
  }
  // 附件：要在进入编辑之前拦掉——下方 Array 兜底会把整个数组 join("、 ") 成死文本，
  // 用户看得见文件名却拿不到文件。AttachmentLinks 自带 stopPropagation，点链接不会
  // 冒泡到外层「进入编辑」按钮；点这行空白处仍然是进入编辑（既有行为不变）。
  // onPreview：与网格/看板画廊同口径——点文件名开在线预览，名字后另给显式下载按钮，
  // 下载入口不被预览吞掉（不传该 prop 时行为与改造前一致）。
  if (field.type === "attachment") {
    return <AttachmentLinks value={value} onPreview={(f) => openFilePreview(attachmentFromLink(f))} />;
  }
  if (field.type === "member") {
    return <ReadMember value={value} />;
  }
  // 日期/时间：抽屉此前连普通 date 字段都没有格式化分支，后端存的 UTC ISO 串
  // （2026-10-02T13:38:39.086Z）会整串直出。统一走 formatCell，与网格同口径。
  if (
    field.type === "date" ||
    field.type === "datetime" ||
    field.type === "createdTime" ||
    field.type === "lastModifiedTime"
  ) {
    const text = formatCell(value, field);
    // 解析不出合法日期时原样显示，不静默吞成空串
    return <span className="text-gx-13">{text !== "" ? text : String(value)}</span>;
  }
  // 公式/查阅可能带回时间串（如 NOW() 的 ISO 输出）：按形态识别后再格式化，
  // 普通文本/数字一律不被误判成时间（isIsoDatetimeLike 的判定刻意保守）。
  if ((field.type === "formula" || field.type === "lookup") && isIsoDatetimeLike(value)) {
    return <span className="text-gx-13">{fmtDateTime(value)}</span>;
  }
  if (Array.isArray(value)) return <span className="text-gx-13">{(value as unknown[]).map(String).join("、 ")}</span>;
  if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
  if (field.type === "longText" && typeof value === "string") {
    return <MdContent md={value} variant="block" className="md-cell-block text-gx-13" />;
  }
  return <span className="text-gx-13">{String(value)}</span>;
}

/** 记录抽屉/详情布局里成员字段的只读值：复用成员名册把 userId 映射成头像+名字。 */
function ReadMember({ value }: { value: CellValue | undefined }) {
  const { byId } = useMemberRoster();
  return <MemberDisplay userId={value} byId={byId} />;
}
