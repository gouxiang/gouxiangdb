// apps/web/src/features/sharing/ShareModeField.tsx
// 分享档位选择（只读 / 可编辑）+ 降级提示。数据表分享弹窗与文档分享弹窗共用同一份。
//
// 两条纪律：
//   1) 置灰只是提示，不是防线。canGrantEdit 由调用方从后端结论取（数据表取库级权限位、
//      文档取后端现算的 degraded），这里不做任何"我猜他能编辑"的推导。后端 POST 仍会再判
//      一次，403 的 raw message 由调用方 toast（shareErrorMessage）。
//   2) 置灰必须带原因（R-D-09 同口径）：不给原因，用户只会觉得这个按钮坏了。

import type { ShareMode } from "@gx/shared-types";
import { Icon } from "../../components/icons";

export interface ShareModeFieldProps {
  value: ShareMode;
  onChange: (mode: ShareMode) => void;
  /** 分享人本人此刻能否授予「可编辑」（后端真值）。false → 可编辑置灰。 */
  canGrantEdit: boolean;
  /** 置灰原因（一行小字）。无编辑权时必须给，否则用户不知道为什么点不动。 */
  disabledReason?: string;
  /** 整组禁用（如本人没有管理/分享权限）。 */
  disabled?: boolean;
  /** 只读档位的说明文案。 */
  viewDesc?: string;
  /** 可编辑档位的说明文案。 */
  editDesc?: string;
  /**
   * 档位作用范围说明。文档/画布必须传：正文匿名写仍关闭，「可编辑」当前驱动的是
   * 文档里嵌入的数据表预览能不能写，不写清楚用户会以为选了就能改正文。
   */
  scopeNote?: string;
}

export function ShareModeField({
  value,
  onChange,
  canGrantEdit,
  disabledReason,
  disabled = false,
  viewDesc = "获得链接的人可以查看，不能修改",
  editDesc = "获得链接的人可以新增和修改记录",
  scopeNote,
}: ShareModeFieldProps) {
  const editBlocked = disabled || !canGrantEdit;
  return (
    <div>
      <div className="rounded-gx-lg border border-gx-separator bg-gx-bg p-1">
        <ModeOption
          active={value === "view"}
          title="只读"
          desc={viewDesc}
          disabled={disabled}
          onClick={() => onChange("view")}
        />
        <ModeOption
          active={value === "edit"}
          title="可编辑"
          desc={editDesc}
          disabled={editBlocked}
          onClick={() => onChange("edit")}
        />
      </div>
      {editBlocked && disabledReason ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-gx-11 text-gx-text-hint">
          <Icon name="lock" size={12} className="mt-0.5 shrink-0" />
          <span>{disabledReason}</span>
        </p>
      ) : null}
      {scopeNote ? <p className="mt-1.5 text-gx-11 text-gx-text-hint">{scopeNote}</p> : null}
    </div>
  );
}

/**
 * 降级提示：mode 申请的是「可编辑」，但分享人后来失去了编辑权，链接已自动回落只读。
 * 这是后端每次访问现算出来的（shareCaps.ts），前端只负责把它显示出来。
 */
export function ShareDegradedNote({ text }: { text?: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-1.5 rounded-gx-sm bg-gx-warning-bg px-2 py-1.5 text-gx-11 text-gx-text-secondary">
      <Icon name="alertCircle" size={12} className="mt-0.5 shrink-0" />
      <span>{text ?? "分享人已失去编辑权，此链接已自动变为只读"}</span>
    </div>
  );
}

function ModeOption({
  active,
  title,
  desc,
  onClick,
  disabled,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      // 禁用的可选项仍留在序列里（不隐藏）：隐藏会让用户以为产品根本没有这一档。
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center gap-2.5 rounded-gx-sm px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active ? "bg-gx-accent-bg" : "hover:bg-gx-surface"
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          active ? "border-gx-accent" : "border-gx-border"
        }`}
      >
        {active && <span className="h-2 w-2 rounded-full bg-gx-accent" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-gx-13 ${active ? "font-medium text-gx-text-primary" : "text-gx-text-primary"}`}>
          {title}
        </span>
        <span className="block text-gx-11 text-gx-text-hint">{desc}</span>
      </span>
    </button>
  );
}
