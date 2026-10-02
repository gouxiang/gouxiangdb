// apps/web/src/features/drawer/RecordChangesModal.tsx
// 记录详情抽屉 → 标题栏「查看日志」弹窗：按时间倒序展示一条记录的变更历史。
//
// 为什么单独成文件：抽屉本体已经很长，日志的「取数 + 空态 + 条目渲染」自成一块，
// 拆出来既守住单文件行数，也让纯函数（值格式化 / 操作人解析）能脱离 DOM 单测。
//
// 空态是**一等状态**不是兜底：后端 /api/records/:id/changes 尚未落地时会 404，
// hook 已把它降级成空列表，这里照常渲染「暂无变更记录」，不报错、不白屏。

import { useMemo } from "react";
import { colors } from "@gx/design-tokens";
import { useRecordChanges } from "../../api/hooks";
import type { RecordChangeEntry, RecordChangeOp } from "../../api/client";
import { fmtDateTime } from "../cells/format";
import { useMemberRoster, type RosterMember } from "../contacts/member-roster";
import { Badge, EmptyState, Modal, Spinner } from "../../components/ui";

/** 操作类型 → 中文标签 + 语义色（色值一律取 design-tokens，不写死 hex）。 */
const OP_META: Record<RecordChangeOp, { label: string; color: string }> = {
  create: { label: "新建", color: colors.success },
  update: { label: "编辑", color: colors.accent },
  delete: { label: "删除", color: colors.danger },
};

export const EMPTY_CHANGES_TEXT = "暂无变更记录";

/** 单个值的展示长度上限：超长正文只截断，不撑爆弹窗布局。 */
const VALUE_MAX_LEN = 120;

/**
 * 把变更的 before/after 渲染成可显示文本（纯函数）。
 * 空值统一「空」（符合要求：旧值为空显示「空」）；数组/对象给可读展开，绝不渲染 [object Object]。
 */
export function formatChangeValue(value: unknown): string {
  let text: string;
  if (value === null || value === undefined || value === "") {
    return "空";
  }
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else if (Array.isArray(value)) {
    if (value.length === 0) return "空";
    text = value.map((v) => formatChangeValue(v)).join("、");
  } else if (typeof value === "object") {
    // 关联/附件这类结构化值：给 JSON 摘要，好过 [object Object]
    try {
      text = JSON.stringify(value);
    } catch {
      text = "复杂值";
    }
  } else {
    text = String(value);
  }
  return text.length > VALUE_MAX_LEN ? `${text.slice(0, VALUE_MAX_LEN)}…` : text;
}

/**
 * 操作人显示名（纯函数）：后端给的名字优先，其次查成员名册，最后退回 userId / 「系统」。
 * 「解析不出来就显示原文」——绝不因为拿不到名字就留空白。
 */
export function resolveActorName(
  entry: Pick<RecordChangeEntry, "actorName" | "actorId">,
  rosterById: Map<string, RosterMember>,
): string {
  if (entry.actorName) return entry.actorName;
  if (entry.actorId) return rosterById.get(entry.actorId)?.displayName ?? entry.actorId;
  return "系统";
}

export interface RecordChangesModalProps {
  open: boolean;
  /** 当前记录 id；null（未选中记录）时不发请求。 */
  recordId: string | null;
  onClose: () => void;
}

export function RecordChangesModal({ open, recordId, onClose }: RecordChangesModalProps) {
  // 关闭时传 null → enabledOf 拦住请求，弹窗没打开就一个字节都不发
  const { data, isLoading, isError } = useRecordChanges(open ? recordId : null);
  const { byId: rosterById } = useMemberRoster();
  const entries = useMemo(() => data ?? [], [data]);

  return (
    <Modal open={open} title="数据日志" onClose={onClose} width={640} ariaLabel="数据日志">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : isError || entries.length === 0 ? (
        // 404（端点未上线）已被 hook 降级为空列表，和「真没有变更」共用同一空态
        <EmptyState
          icon="history"
          title={EMPTY_CHANGES_TEXT}
          description={isError ? "变更记录读取失败，请稍后重试" : "这条记录还没有被修改过"}
          className="py-10"
        />
      ) : (
        <ol className="flex flex-col gap-3">
          {entries.map((entry) => {
            const meta = OP_META[entry.op];
            return (
              <li
                key={entry.id}
                className="flex flex-col gap-1.5 border-b border-gx-separator pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-x-gx-sm gap-y-gx-xxs">
                  <Badge variant="soft" color={meta.color}>
                    {meta.label}
                  </Badge>
                  <span className="text-gx-12 text-gx-text-secondary">
                    {resolveActorName(entry, rosterById)}
                  </span>
                  <span className="text-gx-11 text-gx-text-hint">
                    {fmtDateTime(entry.changedAt) || "—"}
                  </span>
                </div>
                {entry.changes.length === 0 ? (
                  <div className="text-gx-12 text-gx-text-hint">无字段级明细</div>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {entry.changes.map((d, i) => (
                      <li key={`${entry.id}-${d.fieldId || i}`} className="text-gx-12 text-gx-text-primary">
                        <span className="text-gx-text-secondary">{d.fieldName || "未命名字段"}：</span>
                        <span className="text-gx-text-hint">{formatChangeValue(d.before)}</span>
                        <span className="px-1 text-gx-text-faint">→</span>
                        <span>{formatChangeValue(d.after)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Modal>
  );
}

export default RecordChangesModal;
