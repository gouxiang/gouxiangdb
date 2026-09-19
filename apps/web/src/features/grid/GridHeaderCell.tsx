// 表头单元格：字段图标 + 名称 + 排序徽标，点击弹出字段菜单（排序/隐藏/重命名/删除），右侧可拖拽改列宽。

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import type { FieldDTO, SortDirection } from "@gx/shared-types";
import { HEADER_HEIGHT_PX } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { FieldIcon } from "../../components/ui";
import { Popover, MenuItem, MenuDivider } from "../../components/ui";
// 阶段 4：R-I-29 截断带 title
import { TruncatedText } from "../../components/interaction";
import { cellTextAlign } from "../cells/format";

export interface GridHeaderCellProps {
  field: FieldDTO;
  width: number;
  sortDirection?: SortDirection;
  canManageSchema: boolean;
  onSort: (dir: SortDirection | null) => void;
  onHide: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onResize: (delta: number) => void;
  // 首列固定（主字段）时传入 left 偏移与层级
  stickyLeft?: number;
  z?: number;
}

export function GridHeaderCell({
  field,
  width,
  sortDirection,
  canManageSchema,
  onSort,
  onHide,
  onRename,
  onDelete,
  onResize,
  stickyLeft,
  z = 10,
}: GridHeaderCellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const lastX = useRef(0);

  // 拖拽改列宽
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      if (delta !== 0) onResize(delta);
    };
    const onUp = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing, onResize]);

  // 表头与数据列同侧：数值/工时/金额列右对齐，其余左对齐（与 CellRenderer 共用 cellTextAlign）
  const right = cellTextAlign(field) === "right";

  return (
    <th
      className={clsx(
        // 表头样式（参考图）：底 gx-surface-alt(#F9FAFC) / 12px / 中性弱色 / 无粗体
        // 列间不画竖线，表头与数据区之间用发丝线（gx-hairline）分隔
        "relative border-b border-gx-hairline bg-gx-table-header px-3",
        right ? "text-right" : "text-left",
        // 冻结列（主字段）保留右侧发丝线，与数据行的冻结列口径一致；其余列间不画竖线
        stickyLeft != null && "sticky border-r border-gx-hairline",
      )}
      style={{
        width,
        minWidth: width,
        height: HEADER_HEIGHT_PX,
        ...(stickyLeft != null ? { left: stickyLeft, zIndex: z } : {}),
      }}
    >
      <div className={clsx("flex h-full items-center gap-1", right && "justify-end")}>
        <FieldIcon type={field.type} size={14} />
        {/* R-I-29：长字段名截断必须带 title 全文 */}
        <TruncatedText text={field.name} className="flex-1 text-gx-12 font-medium text-gx-text-tertiary" />
        {sortDirection && (
          <Icon name={sortDirection === "asc" ? "sortAsc" : "sortDesc"} size={13} className="text-gx-accent" />
        )}
        <button
          type="button"
          className="rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-text-primary"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <Icon name="chevronDown" size={13} />
        </button>
      </div>

      {/* 字段菜单 */}
      {menuOpen && (
        <Popover open onClose={() => setMenuOpen(false)} align="left" width={200} className="p-1">
          <MenuInner
            field={field}
            sortDirection={sortDirection}
            canManageSchema={canManageSchema}
            onSort={(d) => {
              onSort(d);
              setMenuOpen(false);
            }}
            onHide={() => {
              onHide();
              setMenuOpen(false);
            }}
            onRename={() => {
              onRename?.();
              setMenuOpen(false);
            }}
            onDelete={() => {
              onDelete?.();
              setMenuOpen(false);
            }}
          />
        </Popover>
      )}

      {/* 右侧拖拽条 */}
      <div
        className={clsx(
          "absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-gx-accent-bg",
          resizing && "bg-gx-accent",
        )}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          lastX.current = e.clientX;
          setResizing(true);
        }}
      />
    </th>
  );
}

function MenuInner({
  field,
  sortDirection,
  canManageSchema,
  onSort,
  onHide,
  onRename,
  onDelete,
}: {
  field: FieldDTO;
  sortDirection?: SortDirection;
  canManageSchema: boolean;
  onSort: (dir: SortDirection | null) => void;
  onHide: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="py-1">
      <MenuItem icon="arrowUp" label="升序" active={sortDirection === "asc"} onClick={() => onSort("asc")} />
      <MenuItem icon="arrowDown" label="降序" active={sortDirection === "desc"} onClick={() => onSort("desc")} />
      {sortDirection && <MenuItem icon="close" label="取消排序" onClick={() => onSort(null)} />}
      <MenuDivider />
      <MenuItem icon="eye" label="隐藏此列" onClick={onHide} />
      {canManageSchema && (
        <>
          <MenuItem icon="edit" label="重命名 / 编辑字段" onClick={onRename} />
          <MenuItem icon="trash" label="删除字段" danger onClick={onDelete} />
        </>
      )}
    </div>
  );
}

export default GridHeaderCell;
