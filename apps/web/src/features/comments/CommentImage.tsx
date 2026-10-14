// apps/web/src/features/comments/CommentImage.tsx
// 评论里的内联图片：附件字节必须走鉴权通道（X-GX-Token），不能 <img src=相对url> 直连
// （飞牛门户会吞未带令牌的请求）。仿 FilePreviewModal：fetchAttachmentBytes → toBlobUrl，
// 卸载/换图时 revoke；cancelled 标志防快速切换竞态。
//
// svg 不在内联范围（FORCE_DOWNLOAD，见 logic.isInlineImageAttachment），调用方已先过滤。
// node/SSR 环境（单测）下 effect 不跑，渲染占位而非崩溃。

import { useEffect, useState } from "react";
import type { AttachmentDTO } from "@gx/shared-types";
import { fetchAttachmentBytes, toBlobUrl } from "../attachments/api";
import { previewMime } from "../attachments/policy";
import { openFilePreview } from "../attachments/preview-opener";
import { Spinner } from "../../components/ui";

export function CommentImage({
  file,
  maxHeight = 160,
}: {
  file: AttachmentDTO;
  maxHeight?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function")
      return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    void (async () => {
      try {
        const bytes = await fetchAttachmentBytes(file.url);
        if (cancelled) return;
        objectUrl = toBlobUrl(bytes, previewMime(file.name, file.mime));
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url, file.name, file.mime]);

  const alt = file.name || "评论图片";
  if (failed) {
    return (
      <span className="inline-flex items-center gap-1 text-gx-11 text-gx-text-hint">
        图片加载失败：{file.name}
      </span>
    );
  }
  if (!url) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-gx-lg bg-gx-row-hover text-gx-text-hint"
        style={{ width: 96, height: 72 }}
      >
        <Spinner size={14} />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openFilePreview(file)}
      title={`预览 ${file.name}`}
      aria-label={`预览图片 ${file.name}`}
      className="block overflow-hidden rounded-gx-lg border border-gx-hairline transition-opacity duration-[120ms] hover:opacity-90"
    >
      <img
        src={url}
        alt={alt}
        style={{ maxHeight, width: "auto", maxWidth: "100%" }}
        className="block object-cover"
        loading="lazy"
      />
    </button>
  );
}
