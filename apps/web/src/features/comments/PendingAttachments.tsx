// apps/web/src/features/comments/PendingAttachments.tsx
// 评论框「待发附件」条：选中即传，三态呈现——
//   uploading 进度条 + 取消、error 错误原因 + 重试、ready 缩略图/文件名 + 移除。
// 上传编排（XHR、purpose:"comment"）在 CommentComposer，这里只负责渲染与回调，
// 便于在 node 单测里用 renderToStaticMarkup 断言各态。

import { clsx } from "clsx";
import type { AttachmentDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { formatBytes } from "../attachments/policy";

export type SlotStatus = "uploading" | "ready" | "error";

export interface CommentAttachmentSlot {
  key: string;
  name: string;
  size: number;
  /** 本地预览（仅图片）：blob/object URL，移除/卸载时由 composer 统一 revoke。 */
  localPreviewUrl?: string | null;
  status: SlotStatus;
  percent: number;
  error?: string;
  /** ready 后拿到的服务端附件，发送时取其 id。 */
  dto?: AttachmentDTO;
}

export interface PendingAttachmentsProps {
  slots: readonly CommentAttachmentSlot[];
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
}

function SlotCard({
  slot,
  onRetry,
  onRemove,
}: {
  slot: CommentAttachmentSlot;
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div
      data-gx-comment-attachment={slot.status}
      title={slot.name}
      className={clsx(
        "relative flex w-28 flex-col gap-1 rounded-gx-lg border p-1.5",
        slot.status === "error" ? "border-gx-danger" : "border-gx-hairline",
      )}
    >
      <button
        type="button"
        aria-label={`移除附件 ${slot.name}`}
        title="移除"
        onClick={() => onRemove(slot.key)}
        className="absolute right-1 top-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full bg-gx-surface/90 text-gx-text-tertiary transition-colors duration-[120ms] hover:bg-gx-row-hover hover:text-gx-danger"
      >
        <Icon name="close" size={11} />
      </button>

      <div className="flex h-16 items-center justify-center overflow-hidden rounded-gx-sm bg-gx-row-hover">
        {slot.localPreviewUrl ? (
          <img
            src={slot.localPreviewUrl}
            alt={slot.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon
            name={slot.status === "error" ? "alertCircle" : "paperclip"}
            size={20}
            className="text-gx-text-hint"
          />
        )}
      </div>

      <div className="min-w-0">
        <div className="truncate text-gx-11 text-gx-text-secondary">
          {slot.name}
        </div>
        <div className="text-gx-11 text-gx-text-hint tabular-nums">
          {formatBytes(slot.size)}
        </div>
      </div>

      {slot.status === "uploading" && (
        <div className="flex flex-col gap-0.5">
          <div className="h-1 w-full overflow-hidden rounded-full bg-gx-row-hover">
            <div
              className="h-full bg-gx-accent transition-[width] duration-[150ms]"
              style={{ width: `${slot.percent}%` }}
            />
          </div>
          <span className="text-gx-11 text-gx-text-hint tabular-nums">
            {slot.percent}%
          </span>
        </div>
      )}

      {slot.status === "error" && (
        <button
          type="button"
          onClick={() => onRetry(slot.key)}
          className="inline-flex items-center gap-1 rounded-gx-sm text-gx-11 text-gx-danger hover:underline"
        >
          <Icon name="refresh" size={11} />
          重试
        </button>
      )}
    </div>
  );
}

export function PendingAttachments({
  slots,
  onRetry,
  onRemove,
}: PendingAttachmentsProps) {
  if (slots.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-gx-comment-attachments="true">
      {slots.map((s) => (
        <SlotCard key={s.key} slot={s} onRetry={onRetry} onRemove={onRemove} />
      ))}
    </div>
  );
}
