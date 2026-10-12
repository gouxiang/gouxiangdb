// routes/v1/serveLocalArtifact.ts
// 方案 A：下载端点本地命中（prefetcher 已把成品落 NAS 本地磁盘）时的文件流式服务。
//
// 与 adminUpdateDownload.ts 的【上游代理】分支保持完全一致的外部契约：
//   - 固定 Content-Type: application/octet-stream + attachment filename + no-store + nosniff；
//   - 支持单区间 Range/206/Content-Range/Accept-Ranges（浏览器断点续传）；
//   - web ReadableStream 直传，禁 arrayBuffer()（60MiB 不进内存）；
//   - 客户端断开（请求信号 abort / writer 被取消）经 done 归类为 499；
//   - 本地 IO 错误归类 500。不读取/携带任何 token，不暴露绝对路径。
//
// 返回 response + done：调用方 await done 后按 status/bytes 写审计（source=cache）。

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { stat } from "node:fs/promises";

export interface LocalServeResult {
  response: Response;
  /** 流式结束后结算：HTTP 状态（200/206 完成，499 客户端中断，500 本地 IO 错）与已发送字节。 */
  done: Promise<{ status: number; bytes: number }>;
}

/** 解析单区间 bytes=start-end；返回 null 表示无/不支持的 Range（整文件 200）。 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null; // 多区间 / suffix(-N) / 非法：不支持续传，回退整文件。
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start >= size) return { start: -1, end: -1 }; // 越界标记，调用方发 416。
  return { start, end: Math.min(end, size - 1) };
}

function baseHeaders(filename: string): Headers {
  const h = new Headers();
  h.set("Content-Type", "application/octet-stream");
  h.set("Content-Disposition", `attachment; filename="${filename}"`);
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Accept-Ranges", "bytes");
  return h;
}

/**
 * 流式发送本地文件的一个字节区间（无 Range 时 start=0/end=size-1）。
 * 调用方已确认文件存在；本函数只做发送与中断归类。
 */
export async function serveLocalArtifact(
  req: Request,
  filePath: string,
  filename: string,
): Promise<LocalServeResult> {
  const size = (await stat(filePath)).size;
  const range = parseRange(req.headers.get("Range"), size);

  // 越界区间：416（响应体尚未发送，可走正常错误信封由调用方处理；这里直接给 416 空响应）。
  if (range && range.start === -1) {
    const h = baseHeaders(filename);
    h.set("Content-Range", `bytes */${size}`);
    return { response: new Response(null, { status: 416, headers: h }), done: Promise.resolve({ status: 416, bytes: 0 }) };
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;
  const status = range ? 206 : 200;

  const headers = baseHeaders(filename);
  headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const nodeStream = createReadStream(filePath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  // 计数 + 客户端中断归类：Tee 一条计数 TransformStream。
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = webStream.getReader();

  let bytes = 0;
  let clientGone = false;
  req.signal.addEventListener("abort", () => {
    clientGone = true;
    nodeStream.destroy();
  });
  writer.closed.catch(() => {
    clientGone = true;
    nodeStream.destroy();
  });

  const done = (async (): Promise<{ status: number; bytes: number }> => {
    try {
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) {
          await writer.close();
          return { status, bytes };
        }
        bytes += value.byteLength;
        await writer.write(value);
      }
    } catch {
      writer.abort().catch(() => {});
      reader.cancel().catch(() => {});
      // 请求信号 abort / writer 被取消 = 客户端断开（499）；本地流意外错 = 500。
      return { status: clientGone || req.signal.aborted ? 499 : 500, bytes };
    }
  })();

  return { response: new Response(readable, { status, headers }), done };
}
