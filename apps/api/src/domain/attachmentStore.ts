// apps/api/src/domain/attachmentStore.ts
// 附件的落盘/路径/白名单原语（R2 附件外置）。纯领域层：不 import Hono、不碰 req/res，
// 业务编排与 HTTP 语义在 routes/attachments.ts。
//
// 三条硬约束：
//   1. 落盘路径只由本文件按 sha256 推导，绝不接受调用方传入的相对/绝对路径；
//   2. 读取时同样只信库里的 storagePath，并经 resolveStoredFile 做穿越校验；
//   3. 单文件上限与配置 bodyLimitAttachmentBytes 同源（中间件档与业务校验不分叉）。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";

/** 单次请求最多文件数（与前端单格 20 个上限对齐）。 */
export const ATTACHMENT_MAX_FILES = 20;

/**
 * 扩展名 → 允许的 MIME 列表（首项为缺省 mime：浏览器未给 type 或给
 * application/octet-stream 时用）。未列出的扩展名一律拒绝。
 */
const EXT_MIME: Record<string, string[]> = {
  // 图片
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  bmp: ["image/bmp", "image/x-ms-bmp"],
  svg: ["image/svg+xml"],
  // 文档
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  // 文本
  txt: ["text/plain"],
  csv: ["text/csv", "application/csv", "text/plain"],
  // 压缩包
  zip: ["application/zip", "application/x-zip-compressed"],
  rar: ["application/x-rar-compressed", "application/vnd.rar"],
  // 音视频
  mp4: ["video/mp4"],
  mp3: ["audio/mpeg", "audio/mp3"],
};

/** 白名单扩展名（错误提示用，顺序 = EXT_MIME 声明顺序）。 */
export const ALLOWED_EXTENSIONS: readonly string[] = Object.keys(EXT_MIME);

/** 人类可读的白名单串，用于「不支持的文件格式」错误提示。 */
export const ALLOWED_EXTENSION_LABEL = ALLOWED_EXTENSIONS.join("、");

/**
 * 内联预览会执行脚本的 MIME（SVG 可内嵌 <script>），必须降级为附件下载 + 沙箱 CSP。
 * 其余类型按 Content-Disposition: inline 正常预览。
 */
export const FORCE_DOWNLOAD_MIMES: readonly string[] = ["image/svg+xml"];

/** 单文件上限字节数（与中间件 /api/attachments 档同源）。 */
export function attachmentMaxBytes(): number {
  return config.bodyLimitAttachmentBytes;
}

/** 20MB → "20MB" 之类的展示串（用于「文件 xxx 超过 20MB 上限」）。 */
export function attachmentMaxBytesLabel(): string {
  const mb = attachmentMaxBytes() / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

export interface ResolvedFileType {
  ext: string;
  mime: string;
}

/**
 * 由文件名与浏览器给的 MIME 推导落盘的 {ext, mime}。
 * 浏览器未给 type / 给 application/octet-stream 时取该扩展名的缺省 mime；
 * 给了但与扩展名不匹配（如 .png 报 text/html）一律拒绝，避免存错 Content-Type。
 */
export function resolveFileType(name: string, givenMime: string): ResolvedFileType | null {
  const ext = extOf(name);
  if (!ext) return null;
  const allowed = EXT_MIME[ext];
  if (!allowed) return null;
  const mime = givenMime.trim().toLowerCase();
  if (mime === "" || mime === "application/octet-stream") return { ext, mime: allowed[0] };
  if (!allowed.includes(mime)) return null;
  return { ext, mime };
}

function extOf(name: string): string | null {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** 内容 sha256（hex）。用于落盘路径与同 base 内去重。 */
export function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 落盘相对路径：attachments/<yyyy>/<mm>/<sha256>.<ext>（相对 uploadRoot）。 */
export function buildStoragePath(sha256: string, ext: string, now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return path.posix.join("attachments", yyyy, mm, `${sha256}.${ext}`);
}

/** storagePath 的合法形状（防库里被写入异常值后拼出越界路径）。 */
const STORAGE_PATH_RE = /^attachments\/\d{4}\/\d{2}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

function uploadRootAbs(): string {
  return path.resolve(config.uploadRoot);
}

/**
 * storagePath → 绝对路径。非法形状或越出 uploadRoot 一律返回 null（防路径穿越）。
 * 这是文件系统侧唯一的入口：调用方绝不能自己 join。
 */
export function resolveStoredFile(storagePath: string): string | null {
  if (!STORAGE_PATH_RE.test(storagePath)) return null;
  const root = uploadRootAbs();
  const abs = path.resolve(root, storagePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** 写盘：目录递归创建，同内容已存在则跳过（幂等，返回是否新写）。 */
export function writeStoredFile(storagePath: string, buf: Buffer): boolean {
  const abs = resolveStoredFile(storagePath);
  if (!abs) throw new Error("非法的附件存储路径");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) return false;
  fs.writeFileSync(abs, buf);
  return true;
}

/** 物理删除（尽力而为）：文件不存在不报错。返回是否真的删掉了。 */
export function removeStoredFile(storagePath: string): boolean {
  const abs = resolveStoredFile(storagePath);
  if (!abs) return false;
  if (!fs.existsSync(abs)) return false;
  fs.rmSync(abs, { force: true });
  return true;
}

export function storedFileExists(storagePath: string): boolean {
  const abs = resolveStoredFile(storagePath);
  return !!abs && fs.existsSync(abs);
}

/**
 * Content-Disposition 的 RFC 5987 形式：filename*=UTF-8''<pct-encoded>。
 * 同时给一个 ASCII 兜底 filename="..."，兼容不认 RFC 5987 的旧客户端。
 */
export function contentDisposition(disposition: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
