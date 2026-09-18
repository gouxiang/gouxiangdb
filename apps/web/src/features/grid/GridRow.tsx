// 数据行：渲染复选框 + 行号 + 展开按钮（sticky 首列），以及各字段单元格。
// 单元格在 active 时高亮、在 editing 时渲染 CellEditor。
// 行颜色（rowColor）：按 RowColorPanel 约定以左侧色条呈现，不覆盖 zebra/selected/hover 背景。

import { clsx } from "clsx";
import type { FieldDTO, RecordDTO, LinkRefDTO, PermissionSet } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Checkbox } from "../../components/ui";
import { CellRenderer } from "../cells/CellRenderer";
import { CellEditor } from "../cells/CellEditor";
import { cellTextAlign, isReadOnlyField } from "../cells/format";

// 行颜色左侧色条宽度（px）
const ROW_COLOR_BAR_PX = 3;

export interface GridRowProps {
  record: RecordDTO;
  fields: FieldDTO[];
  widthOf: (field: FieldDTO) => number;
  rowHeight: number;
  zebra: boolean;
  selected: boolean;
  /** 行颜色（左侧色条），null/缺省表示不着色 */
  rowColor?: string | null;
  activeFieldId: string | null;
  editing: { recordId: string; fieldId: string } | null;
  permissions: PermissionSet;
  rowHeaderWidth: number;
  primaryFieldId: string;
  canEditData: boolean;
  onToggleRowSelect: (id: string) => void;
  onOpenRecord: (ref: LinkRefDTO) => void;
  onCellClick: (recordId: string, fieldId: string) => void;
  onCellDoubleClick: (recordId: string, fieldId: string) => void;
  onCellKeyDown: (e: React.KeyboardEvent, recordId: string, fieldId: string) => void;
  onStartEdit: (recordId: string, fieldId: string) => void;
  onCommitEdit: (next: import("@gx/shared-types").CellValue, move?: "down" | "right" | "none") => void;
  onCancelEdit: () => void;
}

export function GridRow(props: GridRowProps) {
  const {
    record,
    fields,
    widthOf,
    rowHeight,
    zebra,
    selected,
    rowColor,
    activeFieldId,
    editing,
    permissions,
    rowHeaderWidth,
    primaryFieldId,
    canEditData,
    onToggleRowSelect,
    onOpenRecord,
    onCellClick,
    onCellDoubleClick,
    onCellKeyDown,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
  } = props;

  const isEditing = (fieldId: string) =>
    editing != null && editing.recordId === record.id && editing.fieldId === fieldId;

  return (
    <tr
      className={clsx(zebra && "bg-gx-zebra", selected && "bg-gx-accent-bg", "hover:bg-gx-row-hover cursor-pointer")}
      onClick={(e) => {
        // 行任意空白点击 = 打开抽屉
        // 但不要在选中/编辑/点单元格/点展开按钮时触发
        const target = e.target as HTMLElement;
        if (target.closest("button, input, textarea, a, [data-cell-content]")) return;
        onOpenRecord({ tableId: record.tableId, recordId: record.id, title: "" });
      }}
    >
      {/* 行首固定列：复选框 + 行号 + 展开 */}
      <td
        className="sticky left-0 z-20 border-b border-r border-gx-separator bg-gx-surface"
        style={{
          width: rowHeaderWidth,
          minWidth: rowHeaderWidth,
          height: rowHeight,
          ...(rowColor ? { boxShadow: `inset ${ROW_COLOR_BAR_PX}px 0 0 ${rowColor}` } : {}),
        }}
      >
        <div className="flex h-full items-center gap-1 px-1.5">
          <Checkbox checked={selected} onChange={() => onToggleRowSelect(record.id)} />
          <span className="w-5 text-center text-gx-11 text-gx-text-hint">{/* 行号占位 */}</span>
          <button
            type="button"
            className="rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-text-primary"
            title="展开记录"
            onClick={() =>
              onOpenRecord({ tableId: record.tableId, recordId: record.id, title: "" })
            }
          >
            <Icon name="expand" size={13} />
          </button>
        </div>
      </td>

      {/* 数据列 */}
      {fields.map((field, idx) => {
        const isPrimary = field.id === primaryFieldId;
        const active = activeFieldId === field.id && !isEditing(field.id);
        const readonly = !canEditData || isReadOnlyField(field);
        const align = cellTextAlign(field);
        const editHere = isEditing(field.id);

        return (
          <td
            key={field.id}
            className={clsx(
              "relative border-b border-r border-gx-separator align-middle",
              isPrimary && "sticky z-10 bg-gx-surface",
              active && "ring-2 ring-inset ring-gx-accent",
            )}
            style={{
              width: widthOf(field),
              minWidth: widthOf(field),
              height: rowHeight,
              ...(isPrimary ? { left: rowHeaderWidth } : {}),
              ...(selected ? { backgroundColor: "var(--gx-accent-bg)" } : {}),
            }}
            onClick={() => onCellClick(record.id, field.id)}
            onDoubleClick={() => onCellDoubleClick(record.id, field.id)}
            onKeyDown={(e) => onCellKeyDown(e, record.id, field.id)}
          >
            {editHere ? (
              <div
                className="absolute inset-0 z-30 bg-gx-surface"
                onClick={(e) => e.stopPropagation()}
              >
                <CellEditor
                  value={record.fields[field.id] ?? null}
                  field={field}
                  recordFields={record.fields as Record<string, never>}
                  permissions={permissions}
                  onCommit={(next, move) => onCommitEdit(next, move)}
                  onCancel={onCancelEdit}
                />
              </div>
            ) : (
              <CellRenderer
                value={record.fields[field.id] ?? null}
                field={field}
                record={record}
                permissions={permissions}
                onOpenRecord={onOpenRecord}
              />
            )}
            {/* 对齐辅助：仅用于非编辑器时的容器对齐由 CellRenderer 内部处理 */}
            {!editHere && align === "right" ? null : null}
          </td>
        );
      })}
    </tr>
  );
}

export default GridRow;
