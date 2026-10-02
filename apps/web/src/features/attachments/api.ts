// apps/web/src/features/attachments/api.ts
// 附件服务端通道：上传（XHR 带进度）/ 取字节 / 删除。
//
// 端点契约（apps/api/src/routes/attachments.ts）：
//   POST   /api/attachments          multipart，字段名 file（可重复）+ baseId/tableId/fieldId/recordId
//   GET    /api/attachments/:id/content  鉴权后回字节
//   DELETE /api/attachments/:id      软删；仍被记录引用时 409
//
// 两条纪律：
//   ① 一律 X-GX-Token（不用 Authorization）——飞牛 CGI 网关会把 Authorization 当自家
//      令牌校验并吞掉请求，见 api/authHeader.ts 顶部实测记录；
//   ② 上传走 XHR 而不是 fetch：fetch 至今拿不到上传进度，大附件会「点了没反应」。

import { useAuthStore } from "../../store/auth";
import { authHeaders } from "../../api/authHeader";
import { withBase } from "../../api/client";
import type { AttachmentDTO } from "@gx/shared-types";

/** 上传上下文：baseId 必填（后端鉴权就靠它），其余用于溯源。 */
export interface AttachmentUploadContext {
  baseId: string;
  tableId?: string;
  fieldId?: string;
  recordId?: string;
}

/** 上传响应里服务端给出的错误体。 */
interface UploadErrorBody {
  error?: string;
  message?: string;
  code?: string;
}

/** 从响应体里挑出**给用户看**的中文原因；服务端没给就用兜底文案。 */
export function pickUploadError(body: unknown, fallback: string): string {
  const o = (body !== null && typeof body === "object" ? body : {}) as UploadErrorBody;
  const text = typeof o.error === "string" && o.error.trim() !== "" ? o.error.trim() : "";
  if (text) return text;
  const msg = typeof o.message === "string" && o.message.trim() !== "" ? o.message.trim() : "";
  return msg || fallback;
}

/**
 * 单文件上传（XHR，带 0-100 进度回调）。
 * 失败时 Error.message 是**服务端原样给出的中文错误**（服务端会给出比前端更精确的原因）。
 */
export function uploadAttachmentFile(
  file: File,
  ctx: AttachmentUploadContext,
  onProgress?: (percent: number) => void,
): Promise<AttachmentDTO> {
  const token = useAuthStore.getState().token;
  return new Promise<AttachmentDTO>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", withBase("/api/attachments"));
    for (const [k, v] of Object.entries(authHeaders(token))) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const files = (json as { files?: AttachmentDTO[] } | null)?.files;
        const first = Array.isArray(files) ? files[0] : undefined;
        if (first) {
          onProgress?.(100);
          resolve(first);
          return;
        }
        reject(new Error(pickUploadError(json, "上传成功但未返回附件信息，请重试")));
        return;
      }
      // 401 交给全局登出前先不做特殊处理：附件上传的 401 就是登录态失效。
      reject(new Error(pickUploadError(json, `上传失败（HTTP ${xhr.status}）`)));
    };
    xhr.onerror = () => reject(new Error("网络错误，上传失败，请重试"));
    xhr.onabort = () => reject(new Error("上传已取消"));
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("baseId", ctx.baseId);
    if (ctx.tableId) fd.append("tableId", ctx.tableId);
    if (ctx.fieldId) fd.append("fieldId", ctx.fieldId);
    if (ctx.recordId) fd.append("recordId", ctx.recordId);
    xhr.send(fd);
  });
}

export interface UploadBatchResult {
  /** 成功落地的文件（顺序 = 传入顺序）。 */
  added: AttachmentDTO[];
  /** 逐条失败原因（含文件名），供调用方一次性 toast。 */
  errors: string[];
}

/**
 * 逐个上传（不是一次性塞进一个 multipart）：
 * 逐文件才能给每个条目独立进度；后端原本就支持同内容去重（同 base 同 sha256 复用同一行），
 * 所以拆开请求不会多占存储。任一文件失败不中断其余文件。
 */
export async function uploadAttachmentFiles(
  files: readonly File[],
  ctx: AttachmentUploadContext,
  onFileProgress?: (index: number, percent: number) => void,
): Promise<UploadBatchResult> {
  const added: AttachmentDTO[] = [];
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    try {
      const dto = await uploadAttachmentFile(f, ctx, (p) => onFileProgress?.(i, p));
      added.push(dto);
    } catch (e) {
      errors.push(`${f.name}：${e instanceof Error ? e.message : "上传失败"}`);
    }
  }
  return { added, errors };
}

/** 取回附件字节（远端走鉴权；存量 data: URL 直接本地解码，不发请求）。 */
export async function fetchAttachmentBytes(
  url: string,
  timeoutMs = 20_000,
): Promise<Uint8Array> {
  const raw = String(url ?? "");
  if (raw === "") throw new Error("附件地址为空");
  if (/^data:/i.test(raw)) return decodeDataUrl(raw);

  const token = useAuthStore.getState().token;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && typeof setTimeout === "function" ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(withBase(raw), { headers: { ...authHeaders(token) }, signal: controller?.signal });
  } catch (e) {
    if (controller?.signal.aborted) throw new Error("下载超时，请重试");
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`附件读取失败（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** data URL → 字节（不依赖 DOM API，node 环境也能跑）。 */
export function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("data URL 格式非法");
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    // atob 在浏览器与 node18+ 都存在；缺席时退回 Buffer（构建机老 node 兜底）。
    const bin = typeof atob === "function" ? atob(payload) : Buffer.from(payload, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }
  const text = decodeURIComponent(payload);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** 把字节转成带正确 MIME 的 blob URL（调用方负责 revoke）。 */
export function toBlobUrl(bytes: Uint8Array, mime: string): string {
  // 复制一份再交给 Blob：Uint8Array 可能是 ArrayBuffer 的视图，直接给会让 Blob 持有整块缓冲。
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mime || "application/octet-stream" }));
}

/**
 * 删除服务端附件记录。**失败不抛**：移除只是从字段值里摘掉引用，
 * 记录行留着最多是垃圾数据，绝不能因为删不掉就阻止用户移除附件。
 */
export async function deleteAttachment(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const token = useAuthStore.getState().token;
    const res = await fetch(withBase(`/api/attachments/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: { ...authHeaders(token) },
    });
    return res.ok;
  } catch {
    return false;
  }
}
