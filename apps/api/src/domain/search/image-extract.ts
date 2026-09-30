// 图片提取纯函数（#563）：从附件字段值 / doc markdown 提取可送多模态向量化的图片字符串。
// 附件字段值是 AttachmentDTO[]，其中 url 为 dataURL（FileReader.readAsDataURL）或可访问链接；
// doc 图片是 markdown 里的 ![](url)。只挑 data:image / http(s) 的可用图片（无依赖复用判定）。

import { isUsableImageUrl } from "@gx/shared-types";

interface AttachmentLike {
  url?: unknown;
}

/** 从一个附件字段值（AttachmentDTO[]）提取图片 url，跳过不可用项并去重。 */
export function extractAttachmentImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const a = item as AttachmentLike | null;
    const url = a?.url;
    if (isUsableImageUrl(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * 从 markdown 提取所有图片 URL：匹配 ![alt](url)。
 * 支持 data:image 与 http(s)；去重，保首次出现顺序。
 */
export function extractMarkdownImages(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const url = m[1];
    if (isUsableImageUrl(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
