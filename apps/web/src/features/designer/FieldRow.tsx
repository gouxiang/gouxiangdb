// apps/web/src/features/designer/FieldRow.tsx
// FieldPickList 的单行：字段图标 + 名称 + 拖拽手柄 + 上移/下移/移除。
//
// 原生 HTML5 拖拽（不引 dnd 库）：
//   - canEdit 时整行 draggable，行首 grip 图标作视觉提示；
//   - 被拖行半透明，落点行边框高亮；松开 → onReorder(from,to) 由父级算新顺序；
//   - 拖拽与点击互不影响：浏览器仅在鼠标移动阈值后才判定为 drag，行内按钮点击正常触发；
//   - canEdit=false 时 draggable=false 且不响应 dragover/drop。

import { useState } from "react";
import type { FieldDTO } from "@gx/shared-types";
import { clsx } from "clsx";
import { FieldIcon } from "../../components/ui";
import { Icon } from "../../components/icons";

const rowBtn =
  "rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent disabled:opacity-40";

export interface FieldRowProps {
  field: FieldDTO | undefined;
  fallbackId: string;
  index: number;
  total: number;
  canEdit: boolean;
  onReorder: (from: number, to: number) => void;
  onMoveDir: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
}

export default function FieldRow({
  field,
  fallbackId,
  index,
  total,
  canEdit,
  onReorder,
  onMoveDir,
  onRemove,
}: FieldRowProps) {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);

  return (
    <div
      draggable={canEdit}
      onDragStart={(e) => {
        setDragging(true);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
      }}
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!dragging) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (Number.isInteger(from)) onReorder(from, index);
      }}
      onDragEnd={() => {
        setDragging(false);
        setOver(false);
      }}
      className={clsx(
        "flex items-center gap-1 rounded-gx-sm border px-1.5 py-1",
        over && canEdit ? "border-gx-accent" : "border-gx-border",
        dragging && "opacity-40",
        canEdit && "cursor-grab active:cursor-grabbing",
      )}
    >
      <Icon name="grip" size={12} className="shrink-0 text-gx-text-hint" />
      <FieldIcon type={field?.type ?? "singleLineText"} size={12} />
      <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">
        {field?.name ?? fallbackId}
      </span>
      <button
        type="button"
        title="上移"
        disabled={!canEdit || index === 0}
        onClick={() => onMoveDir(fallbackId, -1)}
        className={rowBtn}
      >
        <Icon name="arrowUp" size={12} />
      </button>
      <button
        type="button"
        title="下移"
        disabled={!canEdit || index === total - 1}
        onClick={() => onMoveDir(fallbackId, 1)}
        className={rowBtn}
      >
        <Icon name="arrowDown" size={12} />
      </button>
      <button
        type="button"
        title="移除"
        disabled={!canEdit}
        onClick={() => onRemove(fallbackId)}
        className={rowBtn}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
