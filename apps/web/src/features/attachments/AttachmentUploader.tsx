// apps/web/src/features/attachments/AttachmentUploader.tsx
// 附件字段的「选择 / 上传 / 预览 / 移除」控件。抽屉内联编辑与网格单元格编辑共用同一份实现。
//
// 取代旧的纯前端 base64 方案（FileReader.readAsDataURL 塞进记录 JSON）的三点理由：
//   · 单文件 2MB 上限是用户能直接撞到的天花板，且大 base64 会拖垮 hydrate / 导出；
//   · 详情抽屉编辑态完全没有上传入口（用户报的根因）；
//   · 存量 dataURL 仍然照旧渲染，本组件只是不再**新增** dataURL。
//
// 失败口径（产品要求「格式不符或上传失败要有明确提示」）：
//   · 发请求前先本地校验，给出具体原因（「文件 xxx 超过 20MB 上限」/「不支持的文件格式：xxx」）；
//   · 服务端返回的 error 原样呈现（服务端掌握更精确的判定，如空文件、单次文件数超限）；
//   · 移除附件**绝不**因为 DELETE 失败而阻塞（记录行留着只是垃圾数据，不能挡住用户操作）。

import { useCallback, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { clsx } from "clsx";
import type { AttachmentDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Button, toast } from "../../components/ui";
import { withBase } from "../../api/client";
import { deleteAttachment, uploadAttachmentFiles } from "./api";
import { openFilePreview } from "./preview-opener";
import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  attachmentIcon,
  canPreviewInline,
  formatBytes,
  isServerAttachmentId,
  resolvePreviewKind,
  toAttachmentDtos,
  validateAttachmentFiles,
} from "./policy";

/**
 * 无库上下文时的兼容通道上限（2MB）。
 *
 * 触发条件很窄：上传需要 baseId（后端据此鉴权），而画布里嵌入的数据表预览
 * （/kb/:kbId/doc/:docId）与公开分享页的嵌入表拿不到 baseId —— 这两处若直接禁掉上传，
 * 等于把原本可用的能力删掉。故这条路径保留旧的「读成 dataURL 存进记录 JSON」实现，
 * 上限仍是 2MB（base64 会膨胀 ~33%，再大就会拖垮 hydrate / 导出）。
 * 正常的数据表网格 / 详情抽屉 / 表单视图都能解析出 baseId，走的是服务端上传（20MB）。
 *
 * 关于后端的**整包**档（GX_BODY_LIMIT_ATTACHMENT，默认 40MB）：本组件是「一个文件一个
 * 请求」（见 api.ts uploadAttachmentFiles），单包 = 单文件 + 边界开销，够不着 40MB，
 * 所以整包档在这里不是约束，UI 也不必提示它。若将来改成多文件一个 multipart，
 * 必须先按 policy.ATTACHMENT_MAX_REQUEST_BYTES 分批。
 */
const LOCAL_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/** 旧通道：本地读成 dataURL（仅在拿不到 baseId 时使用）。 */
function readAsAttachment(file: File): Promise<AttachmentDTO> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: `${Date.now()}-${file.name}`,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        url: typeof reader.result === "string" ? reader.result : "",
      });
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export interface AttachmentUploaderProps {
  /** 原始单元格值（附件数组） */
  value: unknown;
  /** 提交下一个值（与 FieldInput / CellEditor 的 onChange 同签名语义） */
  onChange: (next: AttachmentDTO[]) => void;
  disabled?: boolean;
  /** 上传上下文；缺省时从路由 /base/:baseId/table/:tableId 推导（抽屉/网格都在这条路由下）。 */
  baseId?: string | null;
  tableId?: string | null;
  fieldId?: string | null;
  recordId?: string | null;
  /** 单元格内嵌编辑：更紧凑、列表更矮。 */
  compact?: boolean;
}

/** 上传中的临时条目（成功后并入正式列表）。 */
interface PendingUpload {
  key: string;
  name: string;
  percent: number;
}

export function AttachmentUploader({
  value,
  onChange,
  disabled = false,
  baseId,
  tableId,
  fieldId,
  recordId,
  compact = false,
}: AttachmentUploaderProps) {
  // 路由兜底：抽屉（DetailLayout）与网格都挂在 /base/:baseId/table/:tableId 下，
  // 拿不到 baseId 时后端鉴权必然失败，故这里宁可不放行也不要让用户拿到一个假的成功。
  const params = useParams<{ baseId?: string; tableId?: string }>();
  const resolvedBaseId = baseId || params.baseId || "";
  const resolvedTableId = tableId || params.tableId || undefined;

  const items = useMemo(() => toAttachmentDtos(value), [value]);
  // 异步上传完成时可能已经过了一轮渲染，用 ref 取最新值，避免把并发改动覆盖掉。
  const latestRef = useRef(items);
  latestRef.current = items;

  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const serverMode = resolvedBaseId !== "";
  const maxBytes = serverMode ? ATTACHMENT_MAX_FILE_BYTES : LOCAL_FALLBACK_MAX_BYTES;
  const canAdd = !disabled && items.length < ATTACHMENT_MAX_FILES;

  const addFiles = useCallback(
    async (list: FileList | File[] | null) => {
      if (!list || disabled) return;
      const incoming = Array.from(list);
      if (incoming.length === 0) return;

      const { accepted, errors } = validateAttachmentFiles(
        incoming,
        latestRef.current.length,
        ATTACHMENT_MAX_FILES,
        maxBytes,
      );
      for (const e of errors) toast(e, "error");
      if (accepted.length === 0) return;

      setBusy(true);
      setPending(accepted.map((f, i) => ({ key: `up-${Date.now()}-${i}-${f.name}`, name: f.name, percent: 0 })));
      const bump = (index: number, percent: number) =>
        setPending((prev) => prev.map((p, i) => (i === index ? { ...p, percent: Math.max(p.percent, percent) } : p)));

      let added: AttachmentDTO[] = [];
      const uploadErrors: string[] = [];
      if (serverMode) {
        const r = await uploadAttachmentFiles(
          accepted,
          { baseId: resolvedBaseId, tableId: resolvedTableId, fieldId: fieldId ?? undefined, recordId: recordId ?? undefined },
          bump,
        );
        added = r.added;
        uploadErrors.push(...r.errors);
      } else {
        // 兼容通道：逐个本地读取，任一失败不影响其余文件。
        for (let i = 0; i < accepted.length; i++) {
          const f = accepted[i]!;
          try {
            const dto = await readAsAttachment(f);
            bump(i, 100);
            added.push(dto);
          } catch (e) {
            uploadErrors.push(`${f.name}：${e instanceof Error ? e.message : "读取失败"}`);
          }
        }
      }

      setPending([]);
      setBusy(false);
      for (const e of uploadErrors) toast(e, "error");
      if (added.length > 0) {
        onChange([...latestRef.current, ...added]);
      }
    },
    [disabled, fieldId, maxBytes, onChange, recordId, resolvedBaseId, resolvedTableId, serverMode],
  );

  const remove = useCallback(
    (item: AttachmentDTO) => {
      const next = latestRef.current.filter((f) => f.id !== item.id);
      onChange(next);
      // 存量 dataURL 附件没有服务端记录，调删除必然 404 —— 前端直接跳过。
      if (isServerAttachmentId(item.id)) void deleteAttachment(item.id);
    },
    [onChange],
  );

  return (
    <div className={clsx("w-full", compact ? "text-gx-12" : "text-gx-13")}>
      {items.length > 0 && (
        <ul className={clsx("space-y-1", compact ? "max-h-32" : "max-h-64", "overflow-y-auto")}>
          {items.map((f) => {
            const kind = resolvePreviewKind(f.name, f.mime);
            return (
              <li
                key={f.id}
                className="flex items-center gap-1.5 rounded-gx-sm px-1 py-0.5 hover:bg-gx-bg"
              >
                <Icon name={attachmentIcon(f.name, f.mime)} size={compact ? 12 : 14} className="shrink-0 text-gx-text-hint" />
                <button
                  type="button"
                  title={f.name}
                  onClick={() => openFilePreview(f)}
                  className="min-w-0 flex-1 truncate text-left text-gx-text-primary underline decoration-gx-border hover:text-gx-accent"
                >
                  {f.name}
                </button>
                {f.size > 0 && (
                  <span className="shrink-0 text-gx-11 text-gx-text-hint tabular-nums">{formatBytes(f.size)}</span>
                )}
                {canPreviewInline(kind) && (
                  <IconButtonMini label={`预览 ${f.name}`} icon="eye" onClick={() => openFilePreview(f)} />
                )}
                <a
                  href={withBase(f.url)}
                  download={f.name}
                  target="_blank"
                  rel="noreferrer"
                  title={`下载 ${f.name}`}
                  aria-label={`下载 ${f.name}`}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-gx-lg text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
                >
                  <Icon name="download" size={13} />
                </a>
                <IconButtonMini
                  label={`移除 ${f.name}`}
                  icon="close"
                  danger
                  disabled={disabled}
                  onClick={() => remove(f)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {pending.map((p) => (
        <div key={p.key} className="mt-1 flex items-center gap-1.5 px-1">
          <Icon name="upload" size={compact ? 12 : 14} className="shrink-0 text-gx-accent" />
          <span className="min-w-0 flex-1 truncate text-gx-text-secondary">{p.name}</span>
          <span className="shrink-0 text-gx-11 text-gx-text-hint tabular-nums">{p.percent}%</span>
        </div>
      ))}

      <div className="mt-1.5">
        <Button
          size="sm"
          icon="upload"
          loading={busy}
          disabled={!canAdd}
          disabledReason={
            disabled ? "当前无编辑权限" : items.length >= ATTACHMENT_MAX_FILES ? `最多 ${ATTACHMENT_MAX_FILES} 个附件` : undefined
          }
          onClick={() => inputRef.current?.click()}
        >
          添加附件
        </Button>
        <span className="ml-2 text-gx-11 text-gx-text-hint">
          {items.length}/{ATTACHMENT_MAX_FILES} · 单个 ≤{formatBytes(maxBytes)}
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** 列表行内的 24×24 图标按钮（触摸目标由外层的行高 + padding 补足到可点区域）。 */
function IconButtonMini({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: "eye" | "close";
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-gx-lg text-gx-text-tertiary",
        "transition-colors duration-[120ms] hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-50",
        danger ? "hover:text-gx-danger" : "hover:text-gx-text-primary",
      )}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}

export default AttachmentUploader;
