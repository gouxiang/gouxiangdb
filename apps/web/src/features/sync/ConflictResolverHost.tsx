// apps/web/src/features/sync/ConflictResolverHost.tsx
// 冲突人工解决的【命令式全局宿主】：与 ToastHost/ConfirmHost 平级挂一次（main.tsx）。
//
// 范式照 components/feedback.tsx ConfirmHost：模块级挂起态 + listeners + Host 用 useEffect 订阅，
// 无请求 return null（SSR 安全）。冲突队列来自 useSyncStore（useSyncStatus 在线轮询侧车代理
// /api/local-sync/conflicts?status=conflict；离线保留最近一次队列只读展示）。
//
// 双栏宽布局：左「我的值」右「服务器值」，字段逐行（fieldCompare）；底部三裁决：
//   采用服务器值(theirs→dropped) / 保留我的值(mine→重放) / 自定义合并(custom→编辑 JSON 重放)。
// 缺服务端快照(theirs=null)时 custom 禁用并给 title 原因；未知 reasonCode 走 reasonText 兜底，不崩。

import { useEffect, useMemo, useState } from "react";
import { Modal, Button, toast } from "../../components/ui";
import {
  resolveSyncConflict,
  isSyncUpstreamError,
  type ResolveDecision,
} from "../../api/localSync";
import { ApiError } from "../../api/client";
import { useSyncStore, type PendingConflict } from "../../store/sync";
import { buildFieldRows, hasAnyDifference } from "./fieldCompare";
import { reasonText } from "./reasonCodes";
import {
  canCustomResolve,
  canUseTheirs,
  isConflictResolved,
  CUSTOM_DISABLED_REASON,
} from "./resolveFlow";

// ── 命令式挂起态（照 ConfirmHost）──
let openRequested = false;
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

/** 打开冲突解决弹窗（外部命令式入口，如同步中心「去处理」）。无冲突时为空操作。 */
export function openConflictResolver(): void {
  openRequested = true;
  emit();
}

/** 关闭弹窗（不改变服务端/队列；未处理冲突下次轮询仍会提示）。 */
export function closeConflictResolver(): void {
  openRequested = false;
  emit();
}

const ENTITY_LABEL: Record<string, string> = {
  record: "记录",
  table: "数据表",
  field: "字段",
  view: "视图",
  navnode: "导航项",
};
function entityLabel(t: string): string {
  return ENTITY_LABEL[t] ?? "内容";
}
const OP_LABEL: Record<string, string> = {
  create: "新建",
  update: "更新",
  delete: "删除",
  restore: "恢复",
};
function opLabel(op: string): string {
  return OP_LABEL[op] ?? "修改";
}

function ValueColumn({
  title,
  rows,
  side,
  badge,
}: {
  title: string;
  rows: ReturnType<typeof buildFieldRows>;
  side: "mine" | "theirs";
  badge: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-gx-lg border border-gx-border bg-gx-bg">
      <div className="flex items-center justify-between border-b border-gx-separator px-3 py-2">
        <span className="text-gx-13 font-semibold text-gx-text-primary">{title}</span>
        <span className="rounded-full bg-gx-surface px-2 py-0.5 text-gx-11 text-gx-text-tertiary">
          {badge}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 ? (
          <div className="px-1 py-2 text-gx-12 text-gx-text-hint">无可对比的字段值</div>
        ) : (
          rows.map((r) => (
            <div key={r.key} className="px-1 py-1.5">
              <div className="text-gx-11 text-gx-text-tertiary">{r.key}</div>
              <div
                className={
                  "mt-0.5 break-words rounded-gx-sm px-2 py-1 text-gx-12 " +
                  (r.changed
                    ? side === "mine"
                      ? "bg-gx-accent-bg/40 text-gx-text-primary"
                      : "bg-gx-surface text-gx-text-primary"
                    : "text-gx-text-secondary")
                }
              >
                {side === "mine" ? r.mine : r.theirs}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConflictDialog({ conflict, onSettled, onSkip }: {
  conflict: PendingConflict;
  onSettled: (decision: ResolveDecision, ref: { incomingId: string; clientOpId: string }) => void;
  onSkip: () => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customJson, setCustomJson] = useState("");
  const [busy, setBusy] = useState<ResolveDecision | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // 裁决必须远端在线（侧车代理）；离线时三裁决置灰，仅保留「稍后处理」。
  const online = useSyncStore((s) => s.online);

  const rows = useMemo(
    () => buildFieldRows(conflict.mine, conflict.theirs),
    [conflict],
  );
  const anyDiff = hasAnyDifference(rows);
  const reason = reasonText(conflict.reasonCode, conflict.reasonDetail);
  const customAllowed = canCustomResolve(conflict);
  const theirsAllowed = canUseTheirs(conflict);

  function enterCustom() {
    if (!customAllowed || !online) return;
    // 以服务端当前值为编辑基底（缺则已在按钮禁用处拦住）。
    setCustomJson(JSON.stringify(conflict.theirs ?? {}, null, 2));
    setCustomMode(true);
    setFormError(null);
  }

  async function decide(decision: ResolveDecision) {
    if (!online) return; // 离线时代理到不了远端，按钮已置灰；双保险。
    let patch: Record<string, unknown> | undefined;
    if (decision === "custom") {
      if (!customAllowed) return;
      try {
        const parsed = JSON.parse(customJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setFormError("合并值必须是一个字段对象");
          return;
        }
        patch = parsed as Record<string, unknown>;
      } catch {
        setFormError("JSON 格式不正确，请检查后重试");
        return;
      }
    }
    setBusy(decision);
    setFormError(null);
    try {
      const result = await resolveSyncConflict({
        resolveOf: conflict.clientOpId,
        decision,
        patch,
      });
      if (isConflictResolved(decision, result)) {
        toast(decision === "theirs" ? "已采用服务器值" : "你的改动已提交同步", "success");
        onSettled(decision, { incomingId: conflict.incomingId, clientOpId: conflict.clientOpId });
      } else {
        // 重放再被拒：服务端把新终态原因带回；原冲突保留，让用户改选。
        const why = result?.reasonCode ? reasonText(result.reasonCode, result.reasonDetail) : "";
        setFormError(why || "服务器暂未接受该选择，请改用其它方式或稍后重试");
        setBusy(null);
      }
    } catch (e) {
      // 就地提示，绝不挂全局 onError（push 冲突不是 HTTP 错；只有用户主动裁决才产生这些）：
      //   502 侧车到不了远端（不通，可重试）；409 该冲突状态已被另一端改变（须刷新重选）。
      let msg: string;
      if (isSyncUpstreamError(e)) msg = "无法连接远端服务器，请确认联网后重试";
      else if (e instanceof ApiError && e.status === 409) msg = "该冲突状态已变化，关闭后将自动刷新";
      else if (e instanceof ApiError) msg = e.body?.error ?? "提交失败，请重试";
      else msg = "网络异常，请重试";
      setFormError(msg);
      setBusy(null);
    }
  }

  return (
    <Modal
      open
      width={760}
      zClass="gx-z-modal-nested"
      onClose={onSkip}
      ariaLabel="解决同步冲突"
      title={
        <span className="flex items-center gap-2">
          解决同步冲突 · {entityLabel(conflict.entityType)}
          <span className="text-gx-12 font-normal text-gx-text-tertiary">
            {opLabel(conflict.op)}
          </span>
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip} disabled={busy !== null}>
            稍后处理
          </Button>
          <div className="flex items-center gap-2">
            {customMode ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setCustomMode(false)}
                  disabled={busy !== null || !online}
                >
                  返回对比
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === "custom"}
                  disabled={!online}
                  disabledReason={online ? undefined : "联网后处理冲突"}
                  onClick={() => void decide("custom")}
                >
                  提交合并值
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "theirs"}
                  disabled={!theirsAllowed || busy !== null || !online}
                  disabledReason={
                    !online
                      ? "联网后处理冲突"
                      : theirsAllowed
                        ? undefined
                        : "缺少服务器当前值，无法采用服务器版本"
                  }
                  onClick={() => void decide("theirs")}
                >
                  采用服务器值
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "mine"}
                  disabled={busy !== null || !online}
                  disabledReason={online ? undefined : "联网后处理冲突"}
                  onClick={() => void decide("mine")}
                >
                  保留我的值
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!customAllowed || busy !== null || !online}
                  disabledReason={
                    !online
                      ? "联网后处理冲突"
                      : customAllowed
                        ? undefined
                        : CUSTOM_DISABLED_REASON
                  }
                  title={!online ? "联网后处理冲突" : customAllowed ? undefined : CUSTOM_DISABLED_REASON}
                  onClick={enterCustom}
                >
                  自定义合并
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {!online ? (
          <div role="status" className="rounded-gx-lg bg-gx-accent-bg/50 px-3 py-2 text-gx-12 text-gx-text-secondary">
            当前离线，冲突明细为只读展示；联网后处理冲突。
          </div>
        ) : null}
        {reason ? (
          <div className="rounded-gx-lg bg-gx-accent-bg/50 px-3 py-2 text-gx-12 text-gx-text-secondary">
            {reason}
          </div>
        ) : null}
        {!anyDiff ? (
          <div className="rounded-gx-lg bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-tertiary">
            两侧字段值相同，可能只是版本或结构变化导致的冲突。
          </div>
        ) : null}

        {customMode ? (
          <div className="space-y-2">
            <div className="text-gx-12 text-gx-text-tertiary">
              以服务器当前值为基底编辑合并后的字段（JSON）：
            </div>
            <textarea
              value={customJson}
              onChange={(e) => setCustomJson(e.target.value)}
              spellCheck={false}
              className="h-64 w-full rounded-gx-lg border border-gx-border bg-gx-surface p-2 font-mono text-gx-12 text-gx-text-primary focus:border-gx-accent focus:outline-none focus:ring-2 focus:ring-gx-accent/50"
            />
          </div>
        ) : (
          <div className="flex gap-3" style={{ maxHeight: "46vh" }}>
            <ValueColumn title="我的值" side="mine" badge="本地待同步" rows={rows} />
            <ValueColumn title="服务器值" side="theirs" badge="当前版本" rows={rows} />
          </div>
        )}

        {formError ? (
          <div role="alert" className="text-gx-12 text-gx-danger">
            {formError}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * 全局宿主：挂一次。队列来自 store；自动在出现冲突且无已打开弹窗时呈现，
 * 也响应 openConflictResolver()。处理完一条自动出队并展示下一条；全部处理完关闭。
 */
export function ConflictResolverHost() {
  const conflicts = useSyncStore((s) => s.conflicts);
  const dismissConflict = useSyncStore((s) => s.dismissConflict);
  const [open, setOpen] = useState(false);
  // 本地「稍后处理」跳过的 clientOpId（不动服务端；下次轮询仍会重新进入队列）。
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const l = () => {
      // 手动 openConflictResolver（区别于队列自动弹窗）：清掉「稍后处理」跳过集，允许再次打开。
      if (openRequested) setSkipped(new Set());
      setOpen(openRequested);
      setVersion((v) => v + 1);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // 出现新冲突（非已跳过）自动弹窗；切源/队列清空时复位。
  useEffect(() => {
    if (open) return;
    const hasFresh = conflicts.some((c) => !skipped.has(c.clientOpId));
    if (hasFresh) {
      openRequested = true;
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts]);

  // 队列被清空（切源/重置）：复位跳过集并关闭。
  useEffect(() => {
    if (conflicts.length === 0) {
      setSkipped(new Set());
      if (open) {
        openRequested = false;
        setOpen(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts.length]);

  const current = conflicts.find((c) => !skipped.has(c.clientOpId)) ?? null;

  if (!open || !current) return null;

  const handleSettled = (_decision: ResolveDecision, ref: { incomingId: string; clientOpId: string }) => {
    dismissConflict(ref);
    setSkipped((prev) => {
      const next = new Set(prev);
      next.delete(ref.clientOpId);
      return next;
    });
    setVersion((v) => v + 1); // 重置下一条对话框内部状态（custom 模式/JSON/错误）
  };

  const handleSkip = () => {
    setSkipped((prev) => {
      const next = new Set(prev);
      next.add(current.clientOpId);
      return next;
    });
    setVersion((v) => v + 1);
  };

  // 全部跳过后关闭。
  const remaining = conflicts.filter((c) => !skipped.has(c.clientOpId) && c.clientOpId !== current.clientOpId);
  const maybeClose = () => {
    if (remaining.length === 0) {
      openRequested = false;
      setOpen(false);
    }
  };

  return (
    <ConflictDialog
      key={`${current.clientOpId}-${version}`}
      conflict={current}
      onSettled={(d, ref) => {
        handleSettled(d, ref);
      }}
      onSkip={() => {
        handleSkip();
        maybeClose();
      }}
    />
  );
}
