// apps/web/src/features/kb/canvas/TableEmbedPreview.tsx
// 文档 / 画布里【嵌入的数据表预览】。
//
// 两条取数通道（见 table-embed-data.ts）：
//   - 登录态：/api/records（已按当前用户库权限过滤），写权限由调用方裁决传入；
//   - 分享态：/api/public/s/:token/embed/:tableId，canEdit 由**宿主文档/画布的分享档位**决定，
//     与该数据表自身的分享开关无关；没有宿主 token 就没有这条通道。
//
// 渲染口径（硬约束）：
//   - canEdit=false 时是**纯只读**——不渲染任何编辑入口（无新增/无删除/单元格不可点开编辑）；
//   - canEdit=true 时才允许增删改，写入走上面两条通道各自的接口。
// 单元格用共享的 CellRenderer / CellEditor 渲染（不重写一套表格单元格）。
//
// 生效写权限 = 调用方传入的 canEdit ∧ 后端响应里的 canEdit（fail-closed：任一侧拒绝即只读）。

import { useMemo, useState } from "react";
import type { CellValue } from "@gx/shared-types";
import { permissionsForRole } from "@gx/shared-types";
import { Icon } from "../../../components/icons";
import { Spinner, toast } from "../../../components/ui";
import { CellRenderer } from "../../cells/CellRenderer";
import { CellEditor } from "../../cells/CellEditor";
import { isReadOnlyField } from "../../cells/format";
import { useEmbedTable, useEmbedWrites, cellValueOf, EMBED_PAGE_LIMIT } from "./table-embed-data";

export interface TableEmbedPreviewProps {
  tableId: string;
  /** 插入时快照的视图 id；null/undefined → 用该表默认第一个视图 */
  viewId?: string | null;
  /** 宿主分享 token：有值 = 分享态（匿名通道）；无值 = 登录态 */
  publicToken?: string;
  /**
   * 调用方裁决的写权限：
   *   - 登录态：宿主画布/文档本身是否可编辑
   *   - 分享态：宿主分享档位（mode === "edit"）
   * 组件内部还会与后端响应的 canEdit 取与。
   */
  canEdit: boolean;
  /** 无权限 / 已删除时的兜底标题（插入时的快照） */
  fallbackTitle?: string;
  /** 紧凑模式：嵌在正文里时用（行高更小、无外层标题条） */
  compact?: boolean;
  className?: string;
}

const CELL_PX = { normal: 30, compact: 26 } as const;
const MAX_COL_PX = 220;

export function TableEmbedPreview({
  tableId,
  viewId,
  publicToken,
  canEdit,
  fallbackTitle,
  compact = false,
  className = "",
}: TableEmbedPreviewProps) {
  const data = useEmbedTable({ tableId, viewId, publicToken });
  const writes = useEmbedWrites({ tableId, viewId, publicToken });
  const [editing, setEditing] = useState<{ recordId: string; fieldId: string } | null>(null);

  // fail-closed：调用方允许 且 后端允许（登录态后端不裁决 → 只看调用方）
  const effectiveCanEdit = canEdit && (data.serverCanEdit ?? true);
  const perms = useMemo(() => permissionsForRole(effectiveCanEdit ? "editor" : "viewer"), [effectiveCanEdit]);
  const cellPx = compact ? CELL_PX.compact : CELL_PX.normal;

  const run = async (p: Promise<unknown>, failText: string) => {
    try {
      await p;
      setEditing(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : failText, "error");
    }
  };

  if (data.isLoading) {
    return (
      <div className={`flex min-h-[80px] items-center justify-center bg-gx-surface ${className}`}>
        <Spinner size={16} />
      </div>
    );
  }

  if (data.isError) {
    return (
      <div className={`flex min-h-[80px] flex-col items-center justify-center gap-1 bg-gx-surface px-3 text-center ${className}`}>
        <Icon name="lock" size={16} className="text-gx-text-hint" />
        <div className="text-gx-12 text-gx-text-secondary">
          {publicToken ? "该数据表未包含在本次分享范围内" : "没有该数据表的访问权限"}
        </div>
        {fallbackTitle && <div className="text-gx-11 text-gx-text-hint">{fallbackTitle}</div>}
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-[80px] flex-col bg-gx-surface ${className}`}>
      {!compact && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-gx-hairline px-2.5 py-1.5">
          <Icon name="table" size={13} className="shrink-0 text-gx-text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-gx-12 font-medium text-gx-text-primary">
            {data.title || fallbackTitle || "数据表"}
          </span>
          {data.viewName && (
            <span className="shrink-0 rounded-gx-sm bg-gx-bg px-1.5 py-0.5 text-gx-11 text-gx-text-tertiary">
              {data.viewName}
            </span>
          )}
          {/* 只读时不给任何编辑入口；这里仅提示档位 */}
          {!effectiveCanEdit && (
            <span className="inline-flex shrink-0 items-center gap-1 text-gx-11 text-gx-text-hint">
              <Icon name="eye" size={11} />
              只读
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {data.fields.length === 0 || data.records.length === 0 ? (
          <div className="flex h-full min-h-[60px] items-center justify-center px-3 text-gx-12 text-gx-text-hint">
            {data.fields.length === 0 ? "该视图没有可显示的字段" : "暂无记录"}
          </div>
        ) : (
          <table className="w-full border-collapse text-gx-12">
            <thead>
              <tr className="bg-gx-table-header">
                {data.fields.map((f) => (
                  <th
                    key={f.id}
                    style={{ maxWidth: MAX_COL_PX }}
                    className="sticky top-0 z-10 truncate border-b border-gx-hairline bg-gx-table-header px-2 py-1 text-left text-gx-11 font-medium text-gx-text-tertiary"
                  >
                    {f.name}
                  </th>
                ))}
                {effectiveCanEdit && <th className="w-8 border-b border-gx-hairline bg-gx-table-header" />}
              </tr>
            </thead>
            <tbody>
              {data.records.map((rec) => (
                <tr key={rec.id} className="border-b border-gx-hairline last:border-b-0 hover:bg-gx-bg">
                  {data.fields.map((f) => {
                    const isEditing = editing?.recordId === rec.id && editing.fieldId === f.id;
                    const editable = effectiveCanEdit && !isReadOnlyField(f);
                    return (
                      <td
                        key={f.id}
                        style={{ height: cellPx, maxWidth: MAX_COL_PX }}
                        className="overflow-hidden px-2 text-gx-text-primary"
                      >
                        {isEditing ? (
                          <CellEditor
                            value={cellValueOf(rec, f.id)}
                            field={f}
                            allFields={data.allFields}
                            recordFields={rec.fields}
                            permissions={perms}
                            onCommit={(next: CellValue) =>
                              void run(writes.update(rec.id, { [f.id]: next }), "保存失败")
                            }
                            onCancel={() => setEditing(null)}
                          />
                        ) : editable ? (
                          <button
                            type="button"
                            onClick={() => setEditing({ recordId: rec.id, fieldId: f.id })}
                            className="flex h-full w-full min-w-0 items-center text-left"
                          >
                            <CellRenderer value={cellValueOf(rec, f.id)} field={f} record={rec} permissions={perms} />
                          </button>
                        ) : (
                          <CellRenderer value={cellValueOf(rec, f.id)} field={f} record={rec} permissions={perms} />
                        )}
                      </td>
                    );
                  })}
                  {effectiveCanEdit && (
                    <td className="w-8 px-1 text-right">
                      <button
                        type="button"
                        title="删除记录"
                        onClick={() => void run(writes.remove(rec.id), "删除失败")}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-gx-sm text-gx-text-hint hover:bg-gx-bg hover:text-danger"
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-gx-hairline px-2.5 py-1 text-gx-11 text-gx-text-hint">
        <span className="min-w-0 flex-1 truncate">
          共 {data.filteredTotal || data.total} 条
          {data.filteredTotal > EMBED_PAGE_LIMIT ? `（显示前 ${EMBED_PAGE_LIMIT} 条）` : ""}
          {data.degraded ? " · 分享档位已降级为只读" : ""}
        </span>
        {/* 新增入口只在可编辑时出现——只读态不得有任何编辑入口 */}
        {effectiveCanEdit && (
          <button
            type="button"
            onClick={() => void run(writes.create({}), "新增失败")}
            className="inline-flex shrink-0 items-center gap-1 rounded-gx-sm border border-gx-border px-1.5 py-0.5 text-gx-11 text-gx-text-secondary hover:bg-gx-bg"
          >
            <Icon name="plus" size={11} />
            新增记录
          </button>
        )}
      </div>
    </div>
  );
}
