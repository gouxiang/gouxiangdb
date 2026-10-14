// apps/web/src/features/comments/CommentComposer.tsx
// 评论 / 回复输入器：
//   · @ 成员：输入 @ 触发候选浮层，↑/↓ 移动、Enter/Tab 选中、Esc 关闭、点击选中；
//   · 附件：点按钮选择 + 拖拽到输入区 + 粘贴图片，选中即传（XHR 带进度，purpose:"comment"），
//     三态（上传中/就绪/失败重试），发送成功后清空（编排见 useCommentAttachments）；
//   · 回复态：顶部显示「回复 @某人」条，payload 带 parentId/replyToUserId；
//   · 空内容禁发（正文与就绪附件至少一个非空；上传中禁止发）。
//
// textarea 走「非受控 ref + state 镜像」：node 单测无 DOM 时逻辑仍可读 value/selection，
// 浏览器里按键裁决统一在 onKeyDown 内完成，避免 @ 浮层与回车提交互相打架。

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type { CreateCommentRequest } from "@gx/shared-types";
import { Button, IconButton, Textarea } from "../../components/ui";
import type { RosterMember } from "../contacts/member-roster";
import {
  activeMention,
  applyMention,
  buildCommentPayload,
  canSubmit,
  collectFiles,
  collectPastedImages,
  mentionCandidates,
  mentionIdsFromPicked,
  type PickedMention,
  type ReplyTarget,
} from "./logic";
import { MentionPopover } from "./MentionPopover";
import { PendingAttachments } from "./PendingAttachments";
import { useCommentAttachments } from "./useCommentAttachments";

export interface CommentComposerProps {
  baseId: string;
  tableId: string;
  recordId: string;
  canComment: boolean;
  members: readonly RosterMember[];
  rosterLoading?: boolean;
  replyTarget: ReplyTarget | null;
  onCancelReply: () => void;
  submitting?: boolean;
  autoFocus?: boolean;
  /** 返回 true 表示发送成功（清空草稿）；false 保留草稿与附件以便重试。 */
  onSubmit: (
    data: CreateCommentRequest,
  ) => Promise<boolean | void> | boolean | void;
}

export function CommentComposer({
  baseId,
  tableId,
  recordId,
  canComment,
  members,
  rosterLoading,
  replyTarget,
  onCancelReply,
  submitting,
  autoFocus,
  onSubmit,
}: CommentComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const att = useCommentAttachments({
    baseId,
    tableId,
    recordId,
    enabled: canComment,
  });

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    if (replyTarget) taRef.current?.focus();
  }, [replyTarget]);

  const mention = useMemo(
    () => (mentionClosed ? null : activeMention(text, caret)),
    [text, caret, mentionClosed],
  );
  const candidates = useMemo(
    () => (mention ? mentionCandidates(members, mention.query) : []),
    [mention, members],
  );
  useEffect(() => setActiveIndex(0), [mention?.query, mention?.start]);

  const sendable =
    canComment && canSubmit(text, att.readyCount, att.uploadingCount);

  const pickMember = (member: RosterMember) => {
    if (!mention) return;
    const { text: next, caret: nextCaret } = applyMention(
      text,
      caret,
      mention.start,
      member.displayName,
    );
    setText(next);
    setCaret(nextCaret);
    setMentionClosed(true);
    setPicked((prev) =>
      prev.some((p) => p.id === member.id)
        ? prev
        : [...prev, { id: member.id, name: member.displayName }],
    );
    requestAnimationFrame(() =>
      taRef.current?.setSelectionRange(nextCaret, nextCaret),
    );
  };

  const syncCaret = () => {
    const el = taRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  const submit = async () => {
    if (!sendable) return;
    const payload = buildCommentPayload({
      body: text,
      attachmentIds: att.readyAttachmentIds(),
      mentionIds: mentionIdsFromPicked(text.trim(), picked),
      parentId: replyTarget?.rootId ?? null,
      replyToUserId: replyTarget?.userId ?? null,
    });
    let ok: boolean | void = true;
    try {
      ok = await onSubmit(payload);
    } catch {
      ok = false;
    }
    if (ok === false) return; // 发送失败：保留草稿与已传附件，允许重试
    setText("");
    setCaret(0);
    setPicked([]);
    setMentionClosed(false);
    att.reset();
    onCancelReply();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMember(candidates[Math.min(activeIndex, candidates.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  if (!canComment) return null;

  return (
    <div
      className={clsx(
        "relative flex flex-col gap-2 rounded-gx-lg border bg-gx-surface p-2 transition-colors duration-[120ms]",
        dragging
          ? "border-gx-accent ring-2 ring-gx-accent/40"
          : "border-gx-border",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        att.addFiles(collectFiles(e.dataTransfer));
      }}
    >
      {mention && (
        <MentionPopover
          candidates={candidates}
          activeIndex={activeIndex}
          loading={rosterLoading}
          onPick={pickMember}
          onHover={setActiveIndex}
        />
      )}

      {replyTarget && (
        <div className="flex items-center gap-1.5 rounded-gx-sm bg-gx-accent-bg px-2 py-1 text-gx-12 text-gx-accent">
          <span className="min-w-0 flex-1 truncate">
            回复 @{replyTarget.displayName}
          </span>
          <IconButton
            icon="close"
            size={18}
            label="取消回复"
            onClick={onCancelReply}
          />
        </div>
      )}

      <Textarea
        ref={taRef}
        value={text}
        rows={2}
        placeholder={
          replyTarget
            ? `回复 @${replyTarget.displayName}…`
            : "写下评论，@ 可提及成员，可拖入/粘贴图片…"
        }
        onChange={(e) => {
          setText(e.target.value);
          setMentionClosed(false);
          syncCaret();
        }}
        onKeyDown={onKeyDown}
        onSelect={syncCaret}
        onClick={syncCaret}
        onPaste={(e) => {
          const imgs = collectPastedImages(e.clipboardData);
          if (imgs.length > 0) {
            e.preventDefault();
            att.addFiles(imgs);
          }
        }}
      />

      <PendingAttachments
        slots={att.slots}
        onRetry={att.retry}
        onRemove={att.removeSlot}
      />

      <div className="flex items-center gap-1">
        <IconButton
          icon="paperclip"
          label="添加附件"
          title="添加附件（也可直接拖入或粘贴图片）"
          onClick={() => fileInputRef.current?.click()}
        />
        <span className="text-gx-11 text-gx-text-hint">
          拖入/粘贴图片 · Enter 发送 · Shift+Enter 换行
        </span>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="primary"
            loading={submitting}
            disabled={!sendable}
            onClick={() => void submit()}
          >
            {replyTarget ? "回复" : "发表"}
          </Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          att.addFiles(e.target.files ? Array.from(e.target.files) : null);
          e.target.value = "";
        }}
      />
    </div>
  );
}
