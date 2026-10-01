// apps/web/src/features/designer/FieldPickList.tsx
// 可复用「已选字段列表 + 搜索添加」受控组件（戴总反馈点③：几十上百字段时长勾选框无法操作）。
//
// 交互：
//   - 已选字段渲染成行（类型图标 + 名称 + 移除 + 上移/下移）；
//   - 顶部「添加字段」打开 Popover：搜索框大小写不敏感按字段名过滤，列出未选字段，点击即添加；
//   - 候选集 = 该表全部可用字段（由调用方传入，通常已按 orderable 规则跳过 tabs 容器），
//     因此字段全部移除 / 被隐藏后仍可通过搜索找回。
//
// 纯受控：状态与提交由调用方持有，本组件只渲染 + 回调，不引新依赖。

import { useMemo, useState } from "react";
import type { FieldDTO } from "@gx/shared-types";
import { FieldIcon, Popover } from "../../components/ui";
import { Icon } from "../../components/icons";
import { moveField } from "./viewAdminFields";

const rowBtn =
  "rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent disabled:opacity-40";

export interface FieldPickListProps {
  /** 该表全部候选字段（已按场景过滤，如跳过 tabs）。 */
  fields: FieldDTO[];
  /** 已选字段 id（顺序即展示/生效顺序）。 */
  ids: readonly string[];
  canEdit: boolean;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (next: string[]) => void;
  /** 空列表时的占位文案。 */
  emptyText?: string;
}

export default function FieldPickList({
  fields,
  ids,
  canEdit,
  onAdd,
  onRemove,
  onMove,
  emptyText = "尚未选择字段",
}: FieldPickListProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const byId = useMemo(() => new Map(fields.map((f) => [f.id as string, f])), [fields]);

  // 候选 = 未选字段，按搜索词大小写不敏感过滤字段名。
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fields.filter(
      (f) => !ids.includes(f.id) && (q === "" || f.name.toLowerCase().includes(q)),
    );
  }, [fields, ids, query]);

  const add = (id: string) => {
    onAdd(id);
    // 添加后保留搜索词，方便连续添加多个字段。
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-gx-11 text-gx-text-hint">{ids.length} 个字段</span>
        <div className="relative">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => {
              setQuery("");
              setOpen((o) => !o);
            }}
            className="flex items-center gap-1 rounded-gx-sm border border-gx-border px-2 py-1 text-gx-12 text-gx-accent hover:bg-gx-accent-bg disabled:opacity-40"
          >
            <Icon name="plus" size={12} />
            添加字段
          </button>
          <FieldPickerPopover
            open={open}
            query={query}
            candidates={candidates}
            onClose={() => setOpen(false)}
            onQuery={setQuery}
            onAdd={add}
          />
        </div>
      </div>

      {ids.length === 0 ? (
        <div className="rounded-gx-sm bg-gx-bg px-2 py-3 text-center text-gx-11 text-gx-text-hint">
          {emptyText}
        </div>
      ) : (
        <div className="flex max-h-60 flex-col gap-1 overflow-y-auto">
          {ids.map((id, i) => {
            const f = byId.get(id);
            return (
              <div
                key={id}
                className="flex items-center gap-1 rounded-gx-sm border border-gx-border px-1.5 py-1"
              >
                <FieldIcon type={f?.type ?? "singleLineText"} size={12} />
                <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">
                  {f?.name ?? id}
                </span>
                <button
                  type="button"
                  title="上移"
                  disabled={!canEdit || i === 0}
                  onClick={() => onMove(moveField(ids, id, -1))}
                  className={rowBtn}
                >
                  <Icon name="arrowUp" size={12} />
                </button>
                <button
                  type="button"
                  title="下移"
                  disabled={!canEdit || i === ids.length - 1}
                  onClick={() => onMove(moveField(ids, id, 1))}
                  className={rowBtn}
                >
                  <Icon name="arrowDown" size={12} />
                </button>
                <button
                  type="button"
                  title="移除"
                  disabled={!canEdit}
                  onClick={() => onRemove(id)}
                  className={rowBtn}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface FieldPickerPopoverProps {
  open: boolean;
  query: string;
  candidates: FieldDTO[];
  onClose: () => void;
  onQuery: (q: string) => void;
  onAdd: (id: string) => void;
}

function FieldPickerPopover({
  open,
  query,
  candidates,
  onClose,
  onQuery,
  onAdd,
}: FieldPickerPopoverProps) {
  return (
    <Popover open={open} onClose={onClose} width={300}>
      <div className="flex flex-col gap-2 p-2">
        <div className="flex items-center gap-1.5 rounded-gx-sm border border-gx-border bg-gx-bg px-2 py-1">
          <Icon name="search" size={13} className="text-gx-text-hint" />
          <input
            autoFocus
            value={query}
            placeholder="搜索字段名"
            onChange={(e) => onQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
        </div>
        <div className="flex max-h-52 flex-col overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="px-2 py-3 text-center text-gx-11 text-gx-text-hint">
              {query.trim() ? "没有匹配的字段" : "已添加全部字段"}
            </div>
          ) : (
            candidates.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onAdd(f.id)}
                className="flex items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-12 text-gx-text-primary hover:bg-gx-bg"
              >
                <FieldIcon type={f.type} size={12} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <Icon name="plus" size={12} className="text-gx-text-hint" />
              </button>
            ))
          )}
        </div>
      </div>
    </Popover>
  );
}
