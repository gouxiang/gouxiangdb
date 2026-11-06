// 官方反馈通道前端策略（与后端 readAttachments 限制对齐，apps/api/src/routes/license.ts）：
//   最多 5 个附件、单个 ≤ 8MB、合计 ≤ 20MB、扩展名白名单。
// 前端先拦：超限直接 toast，不发请求（后端会再拦一遍，双保险）。

export const FEEDBACK_MAX_FILES = 5;
export const FEEDBACK_MAX_SINGLE_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** 与后端 ALLOWED_ATTACH_EXT 完全一致（png/jpg/jpeg/gif/webp/zip/log/txt/pdf/mp4/mov）。 */
export const FEEDBACK_ALLOWED_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "zip",
  "log",
  "txt",
  "pdf",
  "mp4",
  "mov",
]);

/** 反馈分类（稳定英文码发后端，中文只做展示；后台契约冻结前的宽容选择）。 */
export const FEEDBACK_CATEGORIES: { value: string; label: string }[] = [
  { value: "billing", label: "账单问题" },
  { value: "license", label: "授权与席位" },
  { value: "tech", label: "技术问题" },
  { value: "other", label: "其他" },
];

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : "";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FeedbackFileError {
  kind: "count" | "type" | "size" | "total";
  message: string;
}

/**
 * 校验「已有文件 + 待加入文件」合并后的集合是否合法。
 * 返回错误（第一条即拦截，不加入任何文件）；null 表示可以全部加入。
 */
export function validateFeedbackFiles(existing: File[], incoming: File[]): FeedbackFileError | null {
  if (incoming.length === 0) return null;
  if (existing.length + incoming.length > FEEDBACK_MAX_FILES) {
    return { kind: "count", message: `最多上传 ${FEEDBACK_MAX_FILES} 个附件` };
  }
  for (const f of incoming) {
    if (!FEEDBACK_ALLOWED_EXT.has(extOf(f.name))) {
      return { kind: "type", message: `不支持的附件类型：${f.name}` };
    }
    if (f.size > FEEDBACK_MAX_SINGLE_BYTES) {
      return { kind: "size", message: `单个附件不能超过 8MB：${f.name}` };
    }
  }
  const total =
    existing.reduce((s, f) => s + f.size, 0) + incoming.reduce((s, f) => s + f.size, 0);
  if (total > FEEDBACK_MAX_TOTAL_BYTES) {
    return { kind: "total", message: "附件合计不能超过 20MB" };
  }
  return null;
}

/** 分类码 → 中文标签（未知码原样显示）。 */
export function categoryLabel(code: string | null): string {
  if (!code) return "其他";
  return FEEDBACK_CATEGORIES.find((c) => c.value === code)?.label ?? code;
}

/** 工单状态码 → 中文标签。 */
export function ticketStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "处理中";
    case "pending":
      return "待补充";
    case "resolved":
      return "已解决";
    case "closed":
      return "已关闭";
    default:
      return status;
  }
}
