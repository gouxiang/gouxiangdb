// apps/web/src/features/designer/viewAdminSections.tsx
// 视图管理员配置（#560）各分区的展示子块：字段列序列表 / 封面 / checkbox 列表。
// 全部为受控组件，状态与提交由 ViewAdminConfigSection 统一持有，这里只负责渲染与回调。

import type { FieldDTO } from "@gx/shared-types";
import { Checkbox, FieldIcon, Select } from "../../components/ui";
import { Icon } from "../../components/icons";

const rowBtn =
  "rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent disabled:opacity-40";

/** A：字段显示范围与顺序。按 order（已覆盖全部参与排序字段）渲染，上移/下移 + 可见性。 */
export function FieldOrderList({
  fields,
  order,
  hidden,
  canEdit,
  onToggleHidden,
  onMove,
}: {
  fields: FieldDTO[];
  order: string[];
  hidden: readonly string[];
  canEdit: boolean;
  onToggleHidden: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const byId = new Map(fields.map((f) => [f.id as string, f]));
  if (order.length === 0) {
    return (
      <div className="rounded-gx-sm bg-gx-bg px-2 py-3 text-center text-gx-11 text-gx-text-hint">
        该表暂无可用字段
      </div>
    );
  }
  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
      {order.map((id, i) => {
        const f = byId.get(id);
        return (
          <div
            key={id}
            className="flex items-center gap-1 rounded-gx-sm border border-gx-border px-1.5 py-1"
          >
            <Checkbox
              checked={!hidden.includes(id)}
              disabled={!canEdit}
              onChange={() => onToggleHidden(id)}
            />
            <FieldIcon type={f?.type ?? "singleLineText"} size={12} />
            <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">
              {f?.name ?? id}
            </span>
            <button
              type="button"
              title="上移"
              disabled={!canEdit || i === 0}
              onClick={() => onMove(id, -1)}
              className={rowBtn}
            >
              <Icon name="arrowUp" size={12} />
            </button>
            <button
              type="button"
              title="下移"
              disabled={!canEdit || i === order.length - 1}
              onClick={() => onMove(id, 1)}
              className={rowBtn}
            >
              <Icon name="arrowDown" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** B：画廊封面（attachment 字段或无）。无 attachment 字段时禁用并说明。 */
export function CoverSelect({
  attachments,
  value,
  canEdit,
  onChange,
}: {
  attachments: FieldDTO[];
  value: string | null;
  canEdit: boolean;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      disabled={!canEdit || attachments.length === 0}
      disabledReason="该表暂无附件字段"
      onChange={(e) => onChange(e.target.value || null)}
      options={[
        { value: "", label: "无封面" },
        ...attachments.map((f) => ({ value: f.id, label: f.name })),
      ]}
    />
  );
}

/** C / D 复用：字段 checkbox 列表（按 fields 给定顺序）。 */
export function FieldCheckList({
  fields,
  selected,
  canEdit,
  onToggle,
}: {
  fields: FieldDTO[];
  selected: readonly string[];
  canEdit: boolean;
  onToggle: (id: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <div className="rounded-gx-sm bg-gx-bg px-2 py-3 text-center text-gx-11 text-gx-text-hint">
        暂无可选字段
      </div>
    );
  }
  return (
    <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
      {fields.map((f) => (
        <label
          key={f.id}
          className="flex items-center gap-2 rounded-gx-sm px-1.5 py-1 text-gx-12 text-gx-text-primary hover:bg-gx-bg"
        >
          <Checkbox
            checked={selected.includes(f.id)}
            disabled={!canEdit}
            onChange={() => onToggle(f.id)}
          />
          <FieldIcon type={f.type} size={12} />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
        </label>
      ))}
    </div>
  );
}
