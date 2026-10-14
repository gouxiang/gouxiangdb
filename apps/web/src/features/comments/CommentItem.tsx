// apps/web/src/features/comments/CommentItem.tsx
// 单条评论（根评论与其回复共用）：头像 + 名字 + 时间 + 正文（@ 高亮 chip，
// React 自动转义、无 dangerouslySetInnerHTML）+ 图片（鉴权字节 blob）/文件附件行 +
// 回复 / 删除动作。删除走 L2 确认（禁 window.confirm），门控 = 管理员或本人。

import { useState } from "react";
import { clsx } from "clsx";
import type { CommentDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { IconButton } from "../../components/ui";
import { confirmAction } from "../../components/feedback";
import { useWriteGuard } from "../../components/interaction";
import { MemberAvatar, type RosterMember } from "../contacts/member-roster";
import { attachmentIcon, formatBytes, extOfName } from "../attachments/policy";
import { openFilePreview } from "../attachments/preview-opener";
import { withBase } from "../../api/client";
import { fmtDateTime } from "../cells/format";
import {
  bodySegments,
  isInlineImageAttachment,
  type ReplyTarget,
} from "./logic";
import { CommentImage } from "./CommentImage";

export interface CommentItemProps {
  comment: CommentDTO;
  currentUserId: string | null;
  canComment: boolean;
  canManage: boolean;
  member?: RosterMember | null;
  busy?: boolean;
  onReply: (target: ReplyTarget) => void;
  onDelete: (commentId: string) => Promise<void> | void;
}

/** @ 高亮 chip：展示名来自后端 mention 快照，正文匹配不到时不会渲染（防越权/脏数据乱高亮）。 */
function MentionChip({ name }: { name: string }) {
  return (
    <span className="rounded-gx-sm bg-gx-accent-bg px-1 font-medium text-gx-accent">
      {name}
    </span>
  );
}

function CommentBody({ comment }: { comment: CommentDTO }) {
  const segments = bodySegments(comment.body, comment.mentions);
  return (
    <p className="whitespace-pre-wrap break-words text-gx-13 leading-5 text-gx-text-primary">
      {segments.map((seg, i) =>
        seg.type === "mention" ? (
          <MentionChip key={i} name={seg.text} />
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

function AttachmentRow({
  file,
}: {
  file: { id: string; name: string; size: number; mime: string; url: string };
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-gx-sm bg-gx-row-hover px-1.5 py-1">
      <Icon
        name={attachmentIcon(file.name, file.mime)}
        size={14}
        className="shrink-0 text-gx-text-hint"
      />
      <button
        type="button"
        title={`预览 ${file.name}`}
        onClick={() => openFilePreview(file)}
        className="min-w-0 flex-1 truncate text-left text-gx-12 text-gx-text-secondary underline decoration-gx-border hover:text-gx-accent"
      >
        {file.name}
      </button>
      {file.size > 0 && (
        <span className="shrink-0 text-gx-11 text-gx-text-hint tabular-nums">
          {formatBytes(file.size)}
        </span>
      )}
      <a
        href={withBase(file.url)}
        download={file.name}
        target="_blank"
        rel="noreferrer"
        title={`下载 ${file.name}`}
        aria-label={`下载 ${file.name}`}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-gx-lg text-gx-text-tertiary hover:bg-gx-surface hover:text-gx-text-primary"
      >
        <Icon name="download" size={13} />
      </a>
    </div>
  );
}

export function CommentItem({
  comment,
  currentUserId,
  canComment,
  canManage,
  member,
  busy,
  onReply,
  onDelete,
}: CommentItemProps) {
  const guard = useWriteGuard();
  const [confirming, setConfirming] = useState(false);
  const canDelete = canManage || comment.userId === currentUserId;
  const isReply = comment.parentId != null;

  const handleDelete = async () => {
    setConfirming(true);
    try {
      const ok = await confirmAction({
        title: "删除这条评论？",
        confirmText: "删除评论",
        level: 2,
        description: "删除后不可恢复，该评论下的回复也可能随之移除。",
      });
      if (ok) await onDelete(comment.id);
    } finally {
      setConfirming(false);
    }
  };

  const images = comment.attachments.filter(
    (a) => isInlineImageAttachment(a) && extOfName(a.name) !== "svg",
  );
  const files = comment.attachments.filter(
    (a) => !isInlineImageAttachment(a) || extOfName(a.name) === "svg",
  );
  const rosterMember: RosterMember | null = member ?? {
    id: comment.userId,
    displayName: comment.displayName,
    email: "",
    avatarUrl: comment.avatarUrl,
  };

  return (
    <div
      className={clsx("flex gap-2", isReply && "pl-6")}
      data-gx-comment-id={comment.id}
      data-gx-comment-reply={isReply ? "true" : undefined}
    >
      <MemberAvatar member={rosterMember} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-gx-12 font-medium text-gx-text-primary">
            {comment.displayName || "成员"}
          </span>
          {isReply && comment.replyToDisplayName && (
            <span className="text-gx-11 text-gx-text-hint">
              回复{" "}
              <span className="text-gx-accent">
                @{comment.replyToDisplayName}
              </span>
            </span>
          )}
          <span
            className="text-gx-11 text-gx-text-hint"
            title={fmtDateTime(comment.createdAt)}
          >
            {fmtDateTime(comment.createdAt)}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {canComment && (
              <IconButton
                icon="reply"
                size={15}
                label="回复"
                onClick={() =>
                  onReply({
                    rootId: comment.parentId ?? comment.id,
                    userId: comment.userId,
                    displayName: comment.displayName,
                  })
                }
              />
            )}
            {canDelete && (
              <IconButton
                icon="trash"
                size={15}
                danger
                label="删除评论"
                disabled={
                  busy || confirming || guard.isBusy(`del:${comment.id}`)
                }
                onClick={() => void handleDelete()}
              />
            )}
          </div>
        </div>

        {comment.body && <CommentBody comment={comment} />}

        {(images.length > 0 || files.length > 0) && (
          <div className="mt-1 flex flex-col gap-1.5">
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {images.map((f) => (
                  <CommentImage key={f.id} file={f} />
                ))}
              </div>
            )}
            {files.length > 0 && (
              <div className="flex flex-col gap-1">
                {files.map((f) => (
                  <AttachmentRow key={f.id} file={f} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
