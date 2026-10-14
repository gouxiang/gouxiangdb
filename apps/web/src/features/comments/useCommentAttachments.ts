// apps/web/src/features/comments/useCommentAttachments.ts
// 评论附件的待发编排（从 CommentComposer 抽出以守住「单文件 ≤300 行」）：
//   · 选中/拖入/粘贴 → 本地校验 → 选中即传（XHR 带进度，purpose:"comment"）；
//   · 三态 slot：uploading（进度）/ ready（拿到服务端附件）/ error（可重试）；
//   · 图片生成本地 blob 预览，移除/发送成功/卸载统一 revoke；
//   · 暴露发送所需的就绪附件 id 与发送门控计数。
// 纯 DOM 交互（选择 input / 拖放事件）留在组件里，这里只管状态与上传。

import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentDTO } from "@gx/shared-types";
import { toast } from "../../components/ui";
import { uploadAttachmentFile } from "../attachments/api";
import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  validateAttachmentFiles,
} from "../attachments/policy";
import { isInlineImageAttachment } from "./logic";
import type { CommentAttachmentSlot } from "./PendingAttachments";

/** 回收一个本地预览 object URL 并从登记集合移除（环境不支持时静默）。 */
function revokePreviewUrl(set: Set<string>, url: string): void {
  if (!set.delete(url)) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

/** 为图片文件生成本地预览 URL 并登记；非图片或环境不支持返回 null。 */
function makePreviewUrl(set: Set<string>, file: File): string | null {
  if (!isInlineImageAttachment({ name: file.name, mime: file.type }))
    return null;
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function")
    return null;
  try {
    const url = URL.createObjectURL(file);
    set.add(url);
    return url;
  } catch {
    return null;
  }
}

export interface UseCommentAttachmentsArgs {
  baseId: string;
  tableId: string;
  recordId: string;
  enabled: boolean;
}

export interface UseCommentAttachments {
  slots: CommentAttachmentSlot[];
  readyCount: number;
  uploadingCount: number;
  addFiles: (list: File[] | null) => void;
  removeSlot: (key: string) => void;
  retry: (key: string) => void;
  readyAttachmentIds: () => string[];
  /** 发送成功后清空全部 slot 并回收预览。 */
  reset: () => void;
}

export function useCommentAttachments({
  baseId,
  tableId,
  recordId,
  enabled,
}: UseCommentAttachmentsArgs): UseCommentAttachments {
  const [slots, setSlots] = useState<CommentAttachmentSlot[]>([]);
  const filesRef = useRef<Map<string, File>>(new Map());
  const previewsRef = useRef<Set<string>>(new Set());
  // 待发数量的 ref 镜像：addFiles 用 useCallback 保持稳定，数量读 ref 而非把 slots 放进依赖。
  const countRef = useRef(0);
  useEffect(() => {
    countRef.current = slots.length;
  }, [slots.length]);

  // 卸载时回收所有本地预览 object URL，杜绝泄漏。
  useEffect(() => {
    const live = previewsRef;
    return () => {
      for (const u of [...live.current]) revokePreviewUrl(live.current, u);
      live.current.clear();
    };
  }, []);

  const patchSlot = useCallback(
    (key: string, p: Partial<CommentAttachmentSlot>) => {
      setSlots((prev) => prev.map((s) => (s.key === key ? { ...s, ...p } : s)));
    },
    [],
  );

  const uploadOne = useCallback(
    async (key: string) => {
      const file = filesRef.current.get(key);
      if (!file || !baseId) return;
      patchSlot(key, { status: "uploading", percent: 0, error: undefined });
      try {
        const dto: AttachmentDTO = await uploadAttachmentFile(
          file,
          { baseId, tableId, recordId, purpose: "comment" },
          (percent) => patchSlot(key, { percent }),
        );
        patchSlot(key, { status: "ready", percent: 100, dto });
      } catch (e) {
        patchSlot(key, {
          status: "error",
          percent: 0,
          error: e instanceof Error ? e.message : "上传失败",
        });
      }
    },
    [baseId, tableId, recordId, patchSlot],
  );

  const addFiles = useCallback(
    (list: File[] | null) => {
      if (!enabled || !list || list.length === 0) return;
      const { accepted, errors } = validateAttachmentFiles(
        list,
        countRef.current,
        ATTACHMENT_MAX_FILES,
        ATTACHMENT_MAX_FILE_BYTES,
      );
      for (const e of errors) toast(e, "error");
      if (accepted.length === 0) return;
      const created: CommentAttachmentSlot[] = accepted.map((f, i) => {
        const key = `ca-${Date.now()}-${i}-${f.name}`;
        filesRef.current.set(key, f);
        return {
          key,
          name: f.name,
          size: f.size,
          status: "uploading",
          percent: 0,
          localPreviewUrl: makePreviewUrl(previewsRef.current, f),
        };
      });
      setSlots((prev) => [...prev, ...created]);
      for (const ckey of created) void uploadOne(ckey.key);
    },
    [enabled, uploadOne],
  );

  const removeSlot = useCallback((key: string) => {
    setSlots((prev) => {
      const target = prev.find((s) => s.key === key);
      if (target?.localPreviewUrl)
        revokePreviewUrl(previewsRef.current, target.localPreviewUrl);
      return prev.filter((s) => s.key !== key);
    });
    filesRef.current.delete(key);
  }, []);

  const retry = useCallback(
    (key: string) => {
      void uploadOne(key);
    },
    [uploadOne],
  );

  const reset = useCallback(() => {
    setSlots((prev) => {
      for (const s of prev)
        if (s.localPreviewUrl)
          revokePreviewUrl(previewsRef.current, s.localPreviewUrl);
      return [];
    });
    filesRef.current.clear();
  }, []);

  const readyCount = slots.filter((s) => s.status === "ready").length;
  const uploadingCount = slots.filter((s) => s.status === "uploading").length;
  const readyAttachmentIds = useCallback(
    () =>
      slots.filter((s) => s.status === "ready" && s.dto).map((s) => s.dto!.id),
    [slots],
  );

  return {
    slots,
    readyCount,
    uploadingCount,
    addFiles,
    removeSlot,
    retry,
    readyAttachmentIds,
    reset,
  };
}
