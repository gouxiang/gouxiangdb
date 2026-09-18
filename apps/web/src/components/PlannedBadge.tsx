// R-N-17「规划中」徽标：未实现的规划入口保留位置 + 挂徽标，点击不得静默失败。
//
// 取值（UI-SPEC R-N-17）：10px / #F1F3F9 底 / #8A94AC 字 / 圆角 4。
// 落地偏差说明（两处，均为规范内部冲突，取更严格的一条）：
//   ① 底色 #F1F3F9 未进附录 A 令牌表，按「业务代码禁止写死 hex」取语义最接近的
//      gx-row-hover（#F1F5FB）；字色 #8A94AC = gx-text-hint，圆角 4 = rounded-gx-sm。
//   ② 字号 10px 不在 R-D-02 的九档（11/12/13/14/15/16/18/20/24）内，取 11px（text-gx-11）。
import { clsx } from "clsx";

export function PlannedBadge({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded-gx-sm bg-gx-row-hover px-1 py-px text-gx-11 leading-none text-gx-text-hint",
        className,
      )}
      title="该功能规划中，尚未开放"
    >
      规划中
    </span>
  );
}

/**
 * 规划入口的统一点击反馈（R-N-17「点击后不做静默失败，弹出占位提示」）。
 * 走 toast 而非静默 return：用户点得到明确结果，且不与表单级错误提示（R-F-11）混淆。
 */
export const PLANNED_HINT_KIND = "info" as const;

export function plannedHint(feature: string): string {
  return `${feature} · 规划中，尚未开放`;
}
