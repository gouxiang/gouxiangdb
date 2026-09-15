// M4 权限面板：单条策略行的七动作勾选矩阵 + table 字段三态编辑入口。
// 纯受控：所有变更通过 onChange 回写父级 EditableRow；只读态仅展示。
import { Icon } from "../../components/icons";
import { Checkbox } from "../../components/ui";
import { ACTION_META, canAssignAction, subjectDisplay, type EditableRow } from "./lib/policy-model";
import type { NavKind } from "@gx/shared-types";

/** 动作短标记（矩阵列头用）：r/c/u/d/评论/分享/结构。 */
const ACTION_SHORT: Record<string, string> = {
  r: "查看",
  c: "新建",
  u: "编辑",
  d: "删除",
  comment: "评论",
  manage_share: "分享",
  manage_schema: "结构",
};

export function PolicyMatrixRow({
  row,
  nodeKind,
  readonly,
  onChange,
  onRemove,
  onEditFields,
}: {
  row: EditableRow;
  nodeKind: NavKind;
  readonly: boolean;
  onChange: (next: EditableRow) => void;
  onRemove: () => void;
  /** table 节点显示字段三态编辑入口；其它节点不传。 */
  onEditFields?: () => void;
}) {
  const name =
    row.original?.subjectName === null || row.original?.subjectName === undefined
      ? "已删除主体"
      : subjectDisplay(row.original.subjectName);
  const isLegacy = !!row.original?.reason && row.original.reason.startsWith("legacy:");

  return (
    <div className="flex flex-col gap-1 rounded-gx-md border border-gx-separator bg-gx-surface px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Icon name={row.subjectType === "user" ? "building" : "shield"} size={13} className="shrink-0 text-gx-text-hint" />
        <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary" title={name}>
          {name}
        </span>
        {isLegacy && (
          <span className="shrink-0 rounded-gx-pill bg-gx-row-hover px-1.5 py-0.5 text-gx-11 text-gx-text-hint">
            旧权限投影
          </span>
        )}
        {onEditFields && (
          <button
            type="button"
            disabled={readonly}
            onClick={onEditFields}
            className="shrink-0 rounded-gx-sm px-1.5 py-0.5 text-gx-12 text-gx-text-secondary hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-50"
            title="编辑字段可见/只读范围"
          >
            字段
            {row.fieldMask && (
              <span className="ml-0.5 text-gx-accent">
                ·{row.fieldMask.allowFields?.length ?? "全"}
              </span>
            )}
          </button>
        )}
        {!readonly && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-gx-sm p-1 text-gx-text-hint hover:bg-gx-row-hover hover:text-gx-text-primary"
            aria-label="移除该主体授权"
            title="移除（保存后生效）"
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {ACTION_META.map(({ action, hint }) => {
          const enabled = canAssignAction(action, nodeKind);
          const checked = row.actions.includes(action);
          return (
            <Checkbox
              key={action}
              checked={checked}
              disabled={readonly || !enabled}
              onChange={(on) => {
                const set = new Set(row.actions);
                if (on) set.add(action);
                else set.delete(action);
                const order = ACTION_META.map((m) => m.action);
                onChange({ ...row, actions: [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b)) });
              }}
              label={
                <span className={enabled ? "" : "text-gx-text-hint"} title={enabled ? hint : "该资源类型不支持此动作"}>
                  {ACTION_SHORT[action]}
                </span>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

/** cutoff 链祖先继承只读摘要行。 */
export function AncestorSummary({
  nodeName,
  subjectName,
  subjectType,
  actions,
}: {
  nodeName: string;
  subjectName: string | null;
  subjectType: string;
  actions: string[];
}) {
  return (
    <div className="flex items-center gap-2 rounded-gx-md bg-gx-row-hover px-2.5 py-1.5">
      <Icon name="inherit" size={13} className="shrink-0 text-gx-text-hint" />
      <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-secondary">
        <span className="text-gx-text-primary">{subjectDisplay(subjectName)}</span>
        <span className="text-gx-text-hint">（{SUBJECT_TYPE_LABEL[subjectType] ?? subjectType}）</span>
        <span className="text-gx-text-hint"> {`继承自 ${nodeName}`}</span>
      </span>
      <span className="shrink-0 font-mono text-gx-11 tabular-nums text-gx-text-hint">{actions.join(" ") || "—"}</span>
    </div>
  );
}

export const SUBJECT_TYPE_LABEL: Record<string, string> = {
  user: "成员",
  dept: "部门",
  role: "角色",
};
