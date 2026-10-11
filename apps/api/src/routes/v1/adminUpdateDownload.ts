// GET /api/v1/admin/update/download?ticket=… —— 仅验票的更新包流式代理（DESIGN §6.2 第二段）。
//
// 为什么是独立公开路由：浏览器原生文件下载（<a>/window.location）带不了 Authorization/X-GX-Token，
// 故本端点不能挂在 v1（全局 requireActiveUser）之后，而在 app.ts 于 v1 之前以完整路径挂载，
// 只认无状态 HMAC 票据（与协同票据 query 携带同一思路）。
//
// 铁律：
//   - 只验票（有效签名/未过期/载荷白名单），不接受 Authorization 鉴权；票非法/过期 -> 401；
//   - 凭票现场重算清单（吃 TTL 缓存）定位资产，拿不到 -> 409，杜绝旧票长期取包；
//   - 上游 Authorization(token) 绝不转发浏览器；禁止 browser_download_url（source 层自拼）；
//   - web ReadableStream 直接透传，禁 arrayBuffer() 整包进内存（60MiB×并发会压垮小内存 NAS）；
//   - 透传 Range/206/Content-Length/Content-Range/Accept-Ranges/ETag 支持断点续传；
//   - 连续 downloadIdleTimeoutMs 无字节 -> 中止上游并结束响应；
//   - close/error best-effort 写 update_downloaded：200 完成 / 499 客户端中断 / 502 上游中断；
//   - 审计 detail 白名单 {channel,version,arch,platform,filename,bytes?,errorCode?}，绝不落 url/token。

import { Hono } from "hono";
import { config } from "../../config.js";
import { HttpError } from "../../guards.js";
import { writeAudit, type AuditEventName } from "../../audit/audit.js";
import { sourceIp } from "../../utils/client-ip.js";
import { verifyDownloadTicket } from "../../domain/update/download.js";
import { UpdateSourceError } from "../../domain/update/types.js";
import { mapUpstreamStatus } from "../../domain/update/source.js";
import { updateService } from "./updateRuntime.js";

export const adminUpdateDownloadRoutes = new Hono();

const TICKET_INVALID_MESSAGE = "下载链接已失效，请返回重新点击下载";

function recordDownloaded(
  status: number,
  actorId: string,
  ip: string,
  detail: Record<string, unknown>,
): void {
  writeAudit(config.auditDir, {
    event: "update_downloaded" as AuditEventName,
    actorId,
    ip,
    method: "GET",
    path: "/api/v1/admin/update/download",
    status,
    detail,
  });
}

adminUpdateDownloadRoutes.get("/download", async (c) => {
  const svc = updateService();
  const ip = sourceIp(c);

  // 1) 仅验票（票优先；不读取/不承认 Authorization）。
  const rawTicket = c.req.query("ticket");
  const ticket = verifyDownloadTicket(config.jwtSecret, rawTicket ?? "");
  if (!ticket) {
    throw new HttpError(401, TICKET_INVALID_MESSAGE, "UPDATE_TICKET_INVALID");
  }

  // 2) 凭票现场重算定位资产（吃缓存；不 force）。拿不到一律 409，不泄漏具体原因。
  let resolved;
  try {
    resolved = await svc.resolveDownload({
      channel: ticket.channel,
      arch: ticket.arch,
      platform: ticket.platform,
      version: ticket.version,
      filename: ticket.filename,
    });
  } catch (err) {
    if (err instanceof UpdateSourceError) {
      recordDownloaded(502, ticket.uid, ip, {
        channel: ticket.channel, version: ticket.version, arch: ticket.arch,
        platform: ticket.platform, filename: ticket.filename, errorCode: err.code,
      });
      throw new HttpError(502, "暂时无法连接更新服务，您可以稍后重试", err.code);
    }
    throw err;
  }
  if (!resolved) {
    throw new HttpError(409, "当前没有可下载的更新，请返回重新检查更新", "UPDATE_NOT_AVAILABLE");
  }

  const baseDetail = {
    channel: ticket.channel,
    version: resolved.version,
    arch: ticket.arch,
    platform: ticket.platform,
    filename: ticket.filename,
  };

  // 3) 发起上游 GET（token 仅在此头内，绝不转发浏览器）。透传浏览器 Range。
  const rangeHeader = c.req.raw.headers.get("Range");
  const headers = svc.upstreamHeaders(resolved, rangeHeader);
  const controller = new AbortController();

  let upstream: Response;
  try {
    upstream = await svc.fetchImpl(resolved.request.url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    const code =
      err instanceof Error && err.name === "AbortError"
        ? "UPDATE_SOURCE_TIMEOUT"
        : "UPDATE_SOURCE_UNREACHABLE";
    recordDownloaded(502, ticket.uid, ip, { ...baseDetail, errorCode: code });
    throw new HttpError(502, "暂时无法连接更新服务，您可以稍后重试", code);
  }

  // 非成功/非 206：响应体尚未开始发送，可返回统一错误信封（不透传上游错误体）。
  const upstreamErr = mapUpstreamStatus(upstream.status);
  if (upstreamErr) {
    controller.abort();
    upstream.body?.cancel().catch(() => {});
    recordDownloaded(502, ticket.uid, ip, { ...baseDetail, errorCode: upstreamErr });
    throw new HttpError(502, "下载更新包失败，请稍后重试", upstreamErr);
  }
  if (!upstream.body) {
    controller.abort();
    recordDownloaded(502, ticket.uid, ip, { ...baseDetail, errorCode: "UPDATE_SOURCE_UNREACHABLE" });
    throw new HttpError(502, "下载更新包失败，请稍后重试", "UPDATE_SOURCE_UNREACHABLE");
  }

  // 4) 流式透传：Tee 出字节计数 + 空闲超时 + 中断记账。web stream 直传，禁 arrayBuffer。
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();

  let bytes = 0;
  let settled = false;
  let clientGone = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      // 连续无字节超时：中止上游，reader.read 随之 reject，pump 收敛为 502。
      controller.abort();
    }, config.update.downloadIdleTimeoutMs);
  };

  const finish = (status: number, extra?: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    clearIdle();
    recordDownloaded(status, ticket.uid, ip, {
      ...baseDetail,
      ...(bytes > 0 ? { bytes } : {}),
      ...(extra ?? {}),
    });
  };

  // 客户端断开：真实服务器在连接断开时 abort 请求信号；这是 499 归类的同步事实来源。
  c.req.raw.signal.addEventListener("abort", () => {
    clientGone = true;
    controller.abort();
  });
  // 兜底：原生导航经部分宿主在响应流被取消时可能不 abort 请求信号，writer 关闭再保一道。
  writer.closed.catch(() => {
    clientGone = true;
    controller.abort();
  });

  (async () => {
    armIdle();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          await writer.close();
          finish(200);
          return;
        }
        bytes += value.byteLength;
        armIdle();
        await writer.write(value); // 客户端已断开时此处 reject
      }
    } catch {
      writer.abort().catch(() => {});
      reader.cancel().catch(() => {});
      // 客户端主动断开（请求信号已 abort 或 writer 被取消）记 499；
      // 其余（空闲超时中止 / 上游中断，writer 仍可写）记 502。
      if (clientGone || c.req.raw.signal.aborted) finish(499);
      else finish(502, { errorCode: "UPDATE_SOURCE_UNREACHABLE" });
    }
  })();

  // 5) 透传响应头（安全/下载语义优先；不透传上游可能带内网痕迹的任意头）。
  const outHeaders = new Headers();
  outHeaders.set("Content-Type", "application/octet-stream");
  outHeaders.set(
    "Content-Disposition",
    `attachment; filename="${ticket.filename}"`,
  );
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("X-Content-Type-Options", "nosniff");
  const passthrough = ["content-length", "content-range", "accept-ranges", "etag"];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v !== null) outHeaders.set(h, v);
  }

  return new Response(readable, { status: upstream.status, headers: outHeaders });
});
