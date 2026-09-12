// apps/web/src/features/kb/upload-limits.ts
// 文档/画布编辑器的上传限制配置：五类资源（图片/视频/音频/PDF/附件）各自的
//   ① 单文件大小上限（MB）  ② 允许的扩展名列表（系统预填默认，用户可补充修改）
// 上传为浏览器本地 dataURL（无服务端文件接口），限制本质是前端校验，
// 因此配置持久化在 localStorage（跨知识库全局生效），在知识库「设置」页编辑。

export type UploadKind = "image" | "video" | "audio" | "pdf" | "file";

export interface UploadLimit {
  /** 单文件大小上限（MB） */
  maxMb: number;
  /** 允许的扩展名（不含点，小写）；用户可在此基础上补充 */
  extensions: string[];
}

export type UploadLimits = Record<UploadKind, UploadLimit>;

export const UPLOAD_KIND_LABEL: Record<UploadKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF 文档",
  file: "附件",
};

/** 系统预填默认值（用户补充修改时以此为基底） */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  image: { maxMb: 10, extensions: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"] },
  video: { maxMb: 25, extensions: ["mp4", "webm", "mov", "m4v"] },
  audio: { maxMb: 25, extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"] },
  pdf: { maxMb: 25, extensions: ["pdf"] },
  file: {
    maxMb: 10,
    extensions: ["zip", "rar", "7z", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv"],
  },
};

const STORAGE_KEY = "gx-upload-limits-v1";

/** 读取上传限制；localStorage 缺失或损坏时回退默认值 */
export function loadUploadLimits(): UploadLimits {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_UPLOAD_LIMITS);
    const parsed = JSON.parse(raw) as Partial<Record<UploadKind, Partial<UploadLimit>>>;
    const out = structuredClone(DEFAULT_UPLOAD_LIMITS);
    (Object.keys(out) as UploadKind[]).forEach((k) => {
      const p = parsed[k];
      if (!p) return;
      if (typeof p.maxMb === "number" && p.maxMb > 0 && p.maxMb <= 200) out[k]!.maxMb = p.maxMb;
      if (Array.isArray(p.extensions)) {
        const exts = p.extensions
          .map((e) => String(e).trim().toLowerCase().replace(/^\./, ""))
          .filter(Boolean);
        // 用户补充：与默认值取并集，保证系统默认格式始终被允许
        out[k]!.extensions = Array.from(new Set([...out[k]!.extensions, ...exts]));
      }
    });
    return out;
  } catch {
    return structuredClone(DEFAULT_UPLOAD_LIMITS);
  }
}

export function saveUploadLimits(limits: UploadLimits): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(limits));
  } catch {
    // localStorage 不可用时静默（隐私模式等）；校验仍按内存值进行
  }
}

export function resetUploadLimits(): UploadLimits {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return structuredClone(DEFAULT_UPLOAD_LIMITS);
}

/** 取文件扩展名（小写，不含点） */
export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * 校验文件是否满足上传限制。
 * 返回 null 表示通过；否则返回用户可读的错误信息。
 */
export function validateUpload(
  kind: UploadKind,
  file: File,
  limits: UploadLimits,
): string | null {
  const cfg = limits[kind];
  const maxBytes = cfg.maxMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return `${UPLOAD_KIND_LABEL[kind]}超过 ${cfg.maxMb}MB 限制，请压缩或选择更小的文件`;
  }
  const ext = fileExt(file.name);
  if (ext && !cfg.extensions.includes(ext)) {
    return `不支持的 .${ext} 格式；${UPLOAD_KIND_LABEL[kind]}支持：${cfg.extensions.map((e) => "." + e).join("、")}`;
  }
  return null;
}
