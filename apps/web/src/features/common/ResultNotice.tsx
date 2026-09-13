// apps/web/src/features/common/ResultNotice.tsx
// S8 结果口径提示条：两种非阻断、可被读屏感知的场景共用一个组件。
//  - bounded：结果超过前端有界上限 / 仍有未取页，当前仅渲染前 N 条（看板/画廊/月历/选择器）。
//  - degraded：服务端 degraded 含 computedInMem，统计/聚合为受限口径（数据行仍可正常编辑）。
// 全部使用 gx-* token 与自建图标，不用 emoji，不用阻断式弹窗。

import type { ReactNode } from "react";
import { clsx } from "clsx";
import { Icon } from "../../components/icons";

export type ResultNoticeTone = "warning" | "info";

export interface ResultNoticeProps {
  tone?: ResultNoticeTone;
  /** 提示正文（已由调用方定稿的中性专业文案）。 */
  children: ReactNode;
  /** 语义化 role：默认 status（不打断）；强提醒可用 alert。 */
  role?: "status" | "alert";
  className?: string;
}

export function ResultNotice({
  tone = "warning",
  children,
  role = "status",
  className,
}: ResultNoticeProps) {
  const isWarning = tone === "warning";
  return (
    <div
      role={role}
      aria-live="polite"
      className={clsx(
        "flex items-start gap-2 rounded-gx-md border px-3 py-2 text-gx-12 leading-5 text-gx-text-secondary",
        isWarning ? "border-gx-warning bg-gx-warning-bg" : "border-gx-border bg-gx-accent-bg",
        className,
      )}
    >
      <Icon
        name="alertCircle"
        size={14}
        className={clsx("mt-0.5 shrink-0", isWarning ? "text-gx-warning" : "text-gx-accent")}
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default ResultNotice;

/**
 * 有界全量截断的统一文案：诚实声明总量与已渲染条数，不假装有全部数据。
 * 总数未知（0/异常）时只说已显示条数与上限建议。
 */
export function boundedResultText(declaredTotal: number, shownCount: number): string {
  const shown = shownCount.toLocaleString("en-US");
  if (declaredTotal > shownCount) {
    return `结果共 ${declaredTotal.toLocaleString("en-US")} 条，当前仅显示前 ${shown} 条，请增加筛选条件缩小范围。`;
  }
  return `结果较多，当前仅显示前 ${shown} 条，请增加筛选条件缩小范围。`;
}

/** 关联选择器满页（可能还有更多候选）时的统一提示。 */
export const LINK_NARROW_TEXT = "匹配结果较多，请输入关键字缩小范围。";

/** 大表受限口径（computedInMem）的统一文案。 */
export const DEGRADED_RESULT_TEXT =
  "数据量较大，当前为受限结果，精确统计需增加筛选条件。数据仍可正常查看与编辑。";
