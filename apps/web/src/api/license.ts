// 官方商业授权前端数据层（beta.2 授权接入）。
//
// 端点真源：apps/api/src/routes/license.ts（全部挂 /api/license/*，恒挂载 + 请求期闸门）：
//   GET    /status            任何登录成员可读；off/未 boot 返回 available:false 兜底
//   POST   /sync              仅管理员（免输入立即同步；HTTP 200 但 body.ok=false 表示接收链拒绝）
//   POST   /import-offline    仅管理员
//   POST   /contact           仅管理员
//   POST   /feedback          任何登录成员（multipart）
//   POST   /feedback/poll     任何登录成员
//   POST   /feedback/:id/reply 任何登录成员（multipart）
//   GET    /feedback/attachment?path= 同源代理
//
// 纪律：
//   - 只渲染后端给的 verdict/seats/verdictLabel，前端不验签、不映射状态词；
//   - multipart 不能走 apiFetch（它强制 Content-Type: application/json），手写 fetch 到
//     dataSourceResolver.baseFor(path)、headers 用 dataSourceResolver.headers()、不设
//     Content-Type（仿 client.ts Branding.uploadHero）；401 走 handleUnauthorized；
//   - sync/import-offline 的「接收链拒绝」是 HTTP 200 + ok:false + rejected 码，
//     调用方必须按 outcome.rejected 分支提示，不能只看 HTTP 状态。
import type {
  LicenseContactInput,
  LicenseImportInput,
  LicenseOfflineRequestPayload,
  LicenseOutcomeDTO,
  LicenseStatusDTO,
  LicenseSyncResultDTO,
} from "@gx/shared-types";
import {
  ApiError,
  WRITE_TIMEOUT_MS,
  apiFetch,
  handleUnauthorized,
  withBase,
} from "./client";
import { dataSourceResolver } from "../node/datasource";
import {
  asRecord,
  normalizePollResponse,
  str,
  type FeedbackPollView,
  type FeedbackSubmitResult,
} from "./license-feedback-wire";

// 反馈透传类型与归一化器集中在 license-feedback-wire.ts（私有后台契约未冻结的宽容投影）。
export {
  normalizePollResponse,
  type FeedbackAttachmentView,
  type FeedbackMessageView,
  type FeedbackPollView,
  type FeedbackSubmitResult,
  type FeedbackTicketView,
} from "./license-feedback-wire";

const BASE = "/api/license";

export const LicenseApi = {
  /** GET /status。off/未 boot 时后端 200 返回 available:false 兜底（不是 404）。 */
  status: (): Promise<LicenseStatusDTO> => apiFetch<LicenseStatusDTO>(`${BASE}/status`),

  /**
   * POST /sync。免输入「立即同步」：触发一次可等待心跳，续费/扩容/后台直绑随心跳下发。
   * 接收链拒绝时 HTTP 仍 200、ok=false、rejected 带机器码；网络/网关错走 reject。
   */
  sync: (): Promise<LicenseSyncResultDTO> =>
    apiFetch<LicenseSyncResultDTO>(`${BASE}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),

  /** POST /import-offline。 */
  importOffline: (input: LicenseImportInput): Promise<LicenseOutcomeDTO> =>
    apiFetch<LicenseOutcomeDTO>(`${BASE}/import-offline`, {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: WRITE_TIMEOUT_MS,
    }),

  /** POST /contact（管理员自报邮箱/团队名）。 */
  updateContact: (input: LicenseContactInput): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`${BASE}/contact`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * POST /feedback（multipart）。任何登录成员可用。
   * 手写 fetch：浏览器自行带 multipart boundary；401 与 apiFetch 同口径收口。
   */
  submitFeedback: async (input: {
    content: string;
    category?: string;
    contactEmail?: string;
    contactPhone?: string;
    files?: File[];
  }): Promise<FeedbackSubmitResult> => {
    const fd = new FormData();
    fd.append("content", input.content);
    if (input.category) fd.append("category", input.category);
    if (input.contactEmail) fd.append("contactEmail", input.contactEmail);
    if (input.contactPhone) fd.append("contactPhone", input.contactPhone);
    for (const f of input.files ?? []) fd.append("attachments", f, f.name);

    const res = await fetch(dataSourceResolver.baseFor(`${BASE}/feedback`), {
      method: "POST",
      headers: dataSourceResolver.headers(),
      body: fd,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw new ApiError(res.status, json as Record<string, never>);
    const o = asRecord(json);
    const ok = o.ok === undefined ? true : o.ok === true || o.ok === "true" || o.ok === 1;
    return {
      ok,
      ticketId: str(o.ticketId) ?? str(o.id),
      error: str(o.error) ?? str(o.message),
    };
  },

  /** POST /feedback/poll（sinceMs 增量；不带 = 全量）。 */
  pollFeedback: (sinceMs?: number): Promise<FeedbackPollView> =>
    apiFetch<unknown>(`${BASE}/feedback/poll`, {
      method: "POST",
      body: JSON.stringify(sinceMs != null ? { sinceMs } : {}),
    }).then(normalizePollResponse),

  /** POST /feedback/:id/reply（multipart，content + 可选附件）。 */
  replyFeedback: async (ticketId: string, content: string, files: File[] = []): Promise<void> => {
    const fd = new FormData();
    fd.append("content", content);
    for (const f of files) fd.append("attachments", f, f.name);
    const res = await fetch(
      dataSourceResolver.baseFor(`${BASE}/feedback/${encodeURIComponent(ticketId)}/reply`),
      { method: "POST", headers: dataSourceResolver.headers(), body: fd },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body as Record<string, never>);
    }
  },

  /**
   * 附件同源代理地址（GET /api/license/feedback/attachment?path=）。
   * 该口走 X-GX-Token 鉴权，浏览器顶层导航/img 无法带自定义头，故图片/下载统一用
   * fetchLicenseAttachment 取字节转 blob URL，本方法仅供需要原始地址的场景。
   */
  attachmentUrl: (path: string): string =>
    withBase(`${BASE}/feedback/attachment?path=${encodeURIComponent(path)}`),
};

/**
 * 取授权反馈附件字节（带 X-GX-Token 头，仿 features/attachments/api.fetchAttachmentBytes）。
 * 调用方负责用 toBlobUrl 生成预览地址并在用完后 URL.revokeObjectURL。
 */
export async function fetchLicenseAttachment(
  path: string,
  timeoutMs = 20_000,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer =
    controller && typeof setTimeout === "function"
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  let res: Response;
  try {
    res = await fetch(
      dataSourceResolver.baseFor(`${BASE}/feedback/attachment?path=${encodeURIComponent(path)}`),
      { headers: { ...dataSourceResolver.headers() }, signal: controller?.signal },
    );
  } catch (e) {
    if (controller?.signal.aborted) throw new Error("附件读取超时，请重试");
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`附件读取失败（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

// ============ 错误判定纯函数 ============

/** 从任意异常里取后端错误码（ApiError.body.code）；非 ApiError / 无 code 返回 null。 */
export function licenseErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const code = e.body?.code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** 404 = 授权写端点未启用（mode=off/未 boot，后端 LICENSE_DISABLED）。 */
export function isLicenseDisabled(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

/** 403 LICENSE_ADMIN_ONLY：当前成员非管理员（UI 竞态兜底，正常管理区已按 isAdmin 隐藏）。 */
export function isLicenseAdminOnly(e: unknown): boolean {
  return licenseErrorCode(e) === "LICENSE_ADMIN_ONLY";
}

// ============ 离线申请码（纯前端生成，零网络请求） ============

/** URL 安全的 base64url（去填充），与授权中心 offline-service 解码口径一致。 */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomNonce(bytes = 12): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 组装离线「申请码」：纯前端生成、不产生任何网络请求。
 * 管理员在内网设备上出示/复制该码交官方，官方据指纹签出离线应答码，再走 /import-offline 导回。
 * 字段对齐授权中心 offline-service 与客户端 PLAN：
 *   {v:1, fingerprint, deploymentId?, platform?, nonce, requestedAt(epoch 秒), clientVersion?}
 */
export function buildOfflineRequestCode(input: {
  fingerprint: string;
  deploymentId?: string | null;
  platform?: string | null;
  clientVersion?: string | null;
  now?: number;
}): string {
  const payload: LicenseOfflineRequestPayload = {
    v: 1,
    fingerprint: input.fingerprint,
    nonce: randomNonce(),
    requestedAt: Math.floor((input.now ?? Date.now()) / 1000),
  };
  if (input.deploymentId) payload.deploymentId = input.deploymentId;
  if (input.platform) payload.platform = input.platform;
  if (input.clientVersion) payload.clientVersion = input.clientVersion;
  return toBase64Url(JSON.stringify(payload));
}
