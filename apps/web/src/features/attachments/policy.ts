// apps/web/src/features/attachments/policy.ts
// 附件策略纯函数层：白名单 / 体积 / 数量 / 预览分派 / 展示格式化。
//
// 为什么单独抽一层（本项目 web 侧测试跑在 node 环境，无 jsdom、无 testing-library）：
//   · 上传前校验、预览分派、dataURL 判定这些**决策**必须可单测，否则只能靠手点；
//   · 组件层（AttachmentUploader / FilePreviewModal）只消费这里的结论，自己不写规则，
//     避免"同一条规则两处实现、改一处漏一处"。
//
// 白名单与 apps/api/src/domain/attachmentStore.ts 的 EXT_MIME **逐项对齐**（顺序一致）：
// 服务端是最终裁决者，前端只是提前给出可读提示，两边必须同口径，否则会出现
// "前端放行、服务端 400" 的错位体验。改任一侧都要同步另一侧。

import type { IconName } from "../../components/icons";
import type { AttachmentDTO } from "@gx/shared-types";

/** 允许的扩展名（顺序与后端 EXT_MIME 声明顺序一致）。 */
export const ATTACHMENT_ALLOWED_EXTENSIONS: readonly string[] = [
  // 图片
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  // 文档
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  // 文本
  "txt",
  "csv",
  // 压缩包
  "zip",
  "rar",
  // 音视频
  "mp4",
  "mp3",
];

/** 「不支持的文件格式」提示里的人类可读清单。 */
export const ATTACHMENT_ALLOWED_LABEL = ATTACHMENT_ALLOWED_EXTENSIONS.join("、");

/** 单文件上限（与后端 config.bodyLimitAttachmentBytes 同口径，缺省 20MB）。 */
export const ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 单字段最多附件数（与后端 ATTACHMENT_MAX_FILES 对齐）。 */
export const ATTACHMENT_MAX_FILES = 20;

/** 预览解析超时（ms）。Office 解析在大文件上可能长时间不返回，必须兜住。 */
export const PREVIEW_TIMEOUT_MS = 15_000;
/** 预览体积上限：与上传上限同口径，超过直接走「下载后打开」降级，不尝试解析。 */
export const PREVIEW_MAX_BYTES = ATTACHMENT_MAX_FILE_BYTES;

/**
 * 取文件名的小写扩展名；无扩展名 / 隐藏文件（.gitignore）/ 末尾孤立点都返回 ""。
 * 与后端 extOf 同口径：dot<=0（隐藏文件）不算扩展名。
 */
export function extOfName(name: string): string {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 扩展名是否落在白名单内。 */
export function isAllowedAttachmentName(name: string): boolean {
  const ext = extOfName(name);
  return ext !== "" && ATTACHMENT_ALLOWED_EXTENSIONS.includes(ext);
}

/** 体积展示：1024 进制，保留一位小数并去掉尾随 .0（1.0MB → 1MB）。 */
export function formatBytes(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const text = i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${text}${units[i]}`;
}

/** 上限的展示串（20MB），用于「文件 xxx 超过 20MB 上限」这类提示。 */
export function attachmentMaxBytesLabel(): string {
  return formatBytes(ATTACHMENT_MAX_FILE_BYTES).replace(/\.\d+/, "");
}

/** 待上传文件的判定输入（File 的结构子集，便于 node 环境单测直接传字面量）。 */
export interface AttachmentCandidate {
  name: string;
  size: number;
}

export interface AttachmentValidationResult<T extends AttachmentCandidate> {
  /** 通过校验、可以真的发出去的文件（已按剩余名额截断）。 */
  accepted: T[];
  /** 逐条中文原因（服务端还会再校验一次，这里只是提前给出可读提示）。 */
  errors: string[];
}

/**
 * 客户端预校验。**不替代**服务端校验，只为在发请求前给出具体原因，
 * 而不是让用户等一轮往返才看到笼统的「上传失败」。
 *
 * 规则顺序：先格式再体积再数量 —— 与后端 routes/attachments.ts 的校验顺序一致，
 * 保证同一批文件前后端报的是同一个原因。
 */
export function validateAttachmentFiles<T extends AttachmentCandidate>(
  files: readonly T[],
  existingCount = 0,
  maxFiles: number = ATTACHMENT_MAX_FILES,
  maxBytes: number = ATTACHMENT_MAX_FILE_BYTES,
): AttachmentValidationResult<T> {
  const errors: string[] = [];
  const passing: T[] = [];
  for (const f of files) {
    const name = String(f?.name ?? "");
    if (!isAllowedAttachmentName(name)) {
      errors.push(`不支持的文件格式：${name || "未命名文件"}`);
      continue;
    }
    if (Number(f?.size ?? 0) > maxBytes) {
      errors.push(`文件 ${name} 超过 ${formatBytes(maxBytes)} 上限`);
      continue;
    }
    passing.push(f);
  }
  const room = Math.max(0, maxFiles - Math.max(0, existingCount));
  const accepted = passing.slice(0, room);
  if (passing.length > room) {
    errors.push(`单个字段最多 ${maxFiles} 个附件，多余的已跳过`);
  }
  return { accepted, errors };
}

// ============ 预览分派 ============

/**
 * 预览通道。none = 不提供在线预览（走「文件信息 + 下载」降级面板）。
 * spreadsheet 含 xls/xlsx（SheetJS 两个都能读）。
 */
export type PreviewKind =
  | "image"
  | "pdf"
  | "docx"
  | "spreadsheet"
  | "csv"
  | "text"
  | "pptx"
  | "video"
  | "audio"
  | "none";

const EXT_PREVIEW: Record<string, PreviewKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  pdf: "pdf",
  docx: "docx",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  csv: "csv",
  txt: "text",
  pptx: "pptx",
  mp4: "video",
  mp3: "audio",
  // doc / ppt（二进制老格式）/ zip / rar：无零依赖或已装库可解，一律降级。
  doc: "none",
  ppt: "none",
  zip: "none",
  rar: "none",
};

const MIME_PREVIEW: Record<string, PreviewKind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/bmp": "image",
  "image/svg+xml": "image",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/plain": "text",
  "video/mp4": "video",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
};

/**
 * 由文件名（优先）与 MIME（兜底）判定预览通道。
 *
 * 扩展名优先：存量 base64 附件的 mime 常是 application/octet-stream，
 * 只看 mime 会把所有老附件判成 none；反过来文件名是唯一稳定可信的来源。
 */
export function resolvePreviewKind(name: string, mime?: string): PreviewKind {
  const byExt = EXT_PREVIEW[extOfName(name)];
  const ext = extOfName(name);
  // 白名单外的扩展名不看 mime：扩展名不可信时按不可预览处理更安全。
  if (ext !== "" && !ATTACHMENT_ALLOWED_EXTENSIONS.includes(ext)) return "none";
  if (byExt) return byExt;
  const m = String(mime ?? "").split(";")[0].trim().toLowerCase();
  return MIME_PREVIEW[m] ?? "none";
}

/** 该通道是否走「在线预览」（false = 降级面板）。 */
export function canPreviewInline(kind: PreviewKind): boolean {
  return kind !== "none";
}

/** 该通道是否需要把文件字节读进内存再解析（图片/PDF/音视频用 blob URL 直出即可）。 */
export function needsParsing(kind: PreviewKind): boolean {
  return kind === "docx" || kind === "spreadsheet" || kind === "csv" || kind === "text";
}

/**
 * 预览前置守卫（纯函数）：返回 null 表示可以预览，否则返回**给用户看的**中文原因。
 * 体积未知（存量 dataURL 的 size 常为 0）时不拦 —— 有超时兜底，不因缺元数据而拒绝服务。
 */
export function previewRejection(
  file: { name?: string; size?: number; mime?: string },
  maxBytes: number = PREVIEW_MAX_BYTES,
): string | null {
  const name = String(file?.name ?? "");
  const size = Number(file?.size ?? 0);
  if (!isAllowedAttachmentName(name)) return `不支持的文件格式：${name || "未命名文件"}`;
  if (Number.isFinite(size) && size > maxBytes) {
    return `文件 ${name} 超过 ${formatBytes(maxBytes)}，在线预览可能失败，请下载后打开`;
  }
  if (!canPreviewInline(resolvePreviewKind(name, file?.mime))) {
    return `${name} 暂不支持在线预览，可下载后打开`;
  }
  return null;
}

/**
 * blob 用的 MIME。存量附件的 mime 常是 application/octet-stream（或干脆缺失），
 * 按扩展名补回正确类型 —— 否则 <img>/<iframe> 拿不到类型就会直接不渲染。
 */
export function previewMime(name: string, mime?: string): string {
  const declared = String(mime ?? "").split(";")[0].trim().toLowerCase();
  if (declared !== "" && declared !== "application/octet-stream") return declared;
  return EXT_MIME_FALLBACK[extOfName(name)] ?? "application/octet-stream";
}

const EXT_MIME_FALLBACK: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  zip: "application/zip",
  rar: "application/x-rar-compressed",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

/** 图标映射（只用 components/icons.tsx 的既有图标，不引第三方图标库、不用 emoji）。 */
const KIND_ICON: Record<PreviewKind, IconName> = {
  image: "image",
  pdf: "file",
  docx: "doc",
  spreadsheet: "table",
  csv: "table",
  text: "text",
  pptx: "doc",
  video: "video",
  audio: "audio",
  none: "paperclip",
};

export function attachmentIcon(name: string, mime?: string): IconName {
  return KIND_ICON[resolvePreviewKind(name, mime)];
}

/** 各通道的中文名（预览面板副标题 / 降级提示用）。 */
export function previewKindLabel(kind: PreviewKind): string {
  switch (kind) {
    case "image":
      return "图片";
    case "pdf":
      return "PDF 文档";
    case "docx":
      return "Word 文档";
    case "spreadsheet":
      return "表格";
    case "csv":
      return "CSV 表格";
    case "text":
      return "文本文件";
    case "pptx":
      return "演示文稿";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    default:
      return "文件";
  }
}

/**
 * AttachmentLinks 的展示项 → 预览弹窗所需的 AttachmentDTO。
 * 只读渲染只保留 {url,name}（既有断言锁死了这个形状），预览要的类型在这里补齐：
 * size/mime 缺失不影响分派（按扩展名判通道），只是预览面板少一行体积信息。
 */
export function attachmentFromLink(item: { url: string; name: string }): AttachmentDTO {
  return { id: item.url, name: item.name, size: 0, mime: "", url: item.url };
}

// ============ URL 形态判定 ============

/** data: URL（存量 base64 附件）。 */
export function isDataUrl(url: string): boolean {
  return /^data:/i.test(String(url ?? ""));
}

/** blob: URL（本地临时对象，withBase 会原样返回）。 */
export function isBlobUrl(url: string): boolean {
  return /^blob:/i.test(String(url ?? ""));
}

/** 绝对 URL（http/https/协议相对）。 */
export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(url ?? "")) || String(url ?? "").startsWith("//");
}

/**
 * 是否服务端附件 id（可否调 DELETE /api/attachments/:id）。
 * 存量 dataURL 附件没有服务端记录，调删除必然 404，故必须在前端就跳过。
 */
export function isServerAttachmentId(id: string): boolean {
  const s = String(id ?? "").trim();
  return s !== "" && !s.startsWith("data:");
}

// ============ 值归一 ============

/**
 * 单元格值 → AttachmentDTO[]（容错：非数组 / 元素非对象 / 字段缺失都不抛错）。
 * 存量 dataURL 附件的 id 可能带 "data:" 前缀或缺失，缺失时用 url+下标兜底出稳定 key。
 */
export function toAttachmentDtos(value: unknown): AttachmentDTO[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((v, i) => {
    const o = (v !== null && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : "";
    const name = typeof o.name === "string" && o.name.trim() !== "" ? o.name : "附件";
    const rawId = typeof o.id === "string" && o.id.trim() !== "" ? o.id : "";
    return {
      id: rawId || `${url.slice(0, 24)}-${i}`,
      name,
      size: Number.isFinite(Number(o.size)) ? Number(o.size) : 0,
      mime: typeof o.mime === "string" ? o.mime : "",
      url,
    };
  });
}
