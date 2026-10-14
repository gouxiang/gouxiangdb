// apps/web/src/features/comments/MentionPopover.tsx
// @ 成员候选浮层：纯展示组件。开关/过滤/键盘移动都在 CommentComposer 里决策，
// 这里只负责把候选渲染成可滚动列表并标出当前高亮项（aria-activedescendant 对齐）。
//
// 不复用通用 Popover：@ 浮层需要 ArrowUp/Down/Enter/Tab 在 textarea 的 onKeyDown 内
// 统一裁决（要阻止默认插入、要回写正文），通用 Popover 的 Esc/外部点击关闭语义会打架。
// 面板用 absolute（相对 composer 的相对定位容器），不 portal —— 评论区在抽屉内无裁剪问题。

import { clsx } from "clsx";
import type { RosterMember } from "../contacts/member-roster";
import { MemberAvatar } from "../contacts/member-roster";
import { Spinner } from "../../components/ui";

export interface MentionPopoverProps {
  candidates: readonly RosterMember[];
  activeIndex: number;
  loading?: boolean;
  onPick: (member: RosterMember) => void;
  onHover: (index: number) => void;
}

export function MentionPopover({
  candidates,
  activeIndex,
  loading,
  onPick,
  onHover,
}: MentionPopoverProps) {
  return (
    <div
      role="listbox"
      aria-label="选择要 @ 的成员"
      data-gx-mention-popover="true"
      className="absolute bottom-full left-0 z-40 mb-1 max-h-56 w-64 overflow-y-auto overscroll-contain rounded-gx-lg border border-gx-border bg-gx-surface shadow-gx-lg"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-gx-12 text-gx-text-hint">
          <Spinner size={14} />
          <span>加载成员…</span>
        </div>
      ) : candidates.length === 0 ? (
        <div className="px-3 py-3 text-gx-12 text-gx-text-hint">无匹配成员</div>
      ) : (
        candidates.map((m, i) => (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            id={`gx-mention-opt-${i}`}
            onMouseDown={(e) => {
              // mousedown 而非 click：避免 textarea 先失焦导致选区/光标丢失
              e.preventDefault();
              onPick(m);
            }}
            onMouseEnter={() => onHover(i)}
            className={clsx(
              "flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-[120ms]",
              i === activeIndex ? "bg-gx-accent-bg" : "hover:bg-gx-row-hover",
            )}
          >
            <MemberAvatar member={m} size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-gx-13 text-gx-text-primary">
                {m.displayName}
              </span>
              {m.email && (
                <span className="block truncate text-gx-11 text-gx-text-hint">
                  {m.email}
                </span>
              )}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
