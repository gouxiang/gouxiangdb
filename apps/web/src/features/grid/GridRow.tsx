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
  /**
   * 斑马纹（v1 遗留口径）。参考图数据行是「白底 + 行间发丝线」，故主表格不再传该档；
   * 属性保留（默认 false）以便随时回退，不删能力。
   */
  zebra?: boolean;
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
      className={clsx(
        // 行底只出一个 bg 类（三选一），避免同权重类名互相覆盖导致 hover/选中丢色；
        // 固定列用 bg-inherit 继承这里的底色，hover / 选中才能整行一致（含行首复选框列）。
        zebra ? "bg-gx-zebra" : selected ? "bg-gx-accent-bg" : "bg-gx-surface",
        // 选中态优先于 hover：选中行恒为 gx-accent-bg(#EAF2FC)，不被 hover 覆盖
        selected ? "" : "hover:bg-gx-row-hover",
        // group：行首展开按钮靠 group-hover 才淡入（常态只显示复选框，1:1 底板 .ckcell）。
        "group cursor-pointer",
      )}
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
        // 行首固定列：右侧保留发丝线 hairline（冻结列与横向滚动内容的层级边界，去线会有"文字被切断"错觉）；
        // 行间横线走更浅的表格内线 line-2（底板 tbody td 用 --line-2，区别于结构线 --line）。
        // 底/右边各挂方向性颜色类，避免两个同权重 border 色类在同一元素互相覆盖。
        className="sticky left-0 z-20 border-b border-b-gx-line-2 border-r border-r-gx-hairline bg-inherit"
        style={{
          width: rowHeaderWidth,
          minWidth: rowHeaderWidth,
          height: rowHeight,
          ...(rowColor ? { boxShadow: `inset ${ROW_COLOR_BAR_PX}px 0 0 ${rowColor}` } : {}),
        }}
      >
        {/* 1:1 底板 .ckcell（width40 / padding-left12 / 14px 复选框）：复选框恒在左 12px 对齐；
            展开按钮常态透明、仅整行 hover（或自身键盘聚焦）时淡入，既不挤占复选框、也不丢功能。
            本列固定 56px，透明按钮仍占位故无布局位移；其行为（打开记录抽屉）与点整行一致。 */}
        <div className="flex h-full items-center pl-3 pr-1">
          <Checkbox checked={selected} onChange={() => onToggleRowSelect(record.id)} />
          <button
            type="button"
            className="ml-auto rounded p-0.5 text-gx-text-hint opacity-0 transition-opacity duration-150 hover:bg-gx-bg hover:text-gx-text-primary focus-visible:opacity-100 group-hover:opacity-100"
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
            // 单元格内点击不应穿透到行 onClick 打开记录抽屉（见行首守卫对
            // [data-cell-content] 的判定）；td 本身就是单元格区域，故在此打标。
            data-cell-content="true"
            className={clsx(
              // 行间横线走更浅的表格内线 line-2（底板 tbody td 用 --line-2）；列间不画竖线，靠 12px 列间距分隔
              "relative border-b border-b-gx-line-2 align-middle",
              // 只有冻结列（首列文本）保留右侧发丝线 hairline，与行首固定列同一口径
              isPrimary && "sticky z-10 border-r border-r-gx-hairline bg-inherit",
              active && "ring-2 ring-inset ring-gx-accent",
            )}
            style={{
              width: widthOf(field),
              minWidth: widthOf(field),
              height: rowHeight,
              ...(isPrimary ? { left: rowHeaderWidth } : {}),
            }}
            onClick={() => onCellClick(record.id, field.id)}
            onDoubleClick={() => onCellDoubleClick(record.id, field.id)}
            onKeyDown={(e) => onCellKeyDown(e, record.id, field.id)}
          >
            {editHere ? (
              <div
                className={clsx(
                  "absolute inset-0 z-30 bg-gx-surface",
                  // 编辑态与只读态同侧对齐（数值列编辑框也右对齐）
                  align === "right" && "text-right",
                )}
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
                // 主键列（首列文本）比其余列重一档，建立层级
                emphasis={isPrimary}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}

export default GridRow;
