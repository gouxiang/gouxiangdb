// /api/license/*：授权 BFF。浏览器（JWT/X-GX-Token）只打本地内核，由内核持设备身份与
// 授权中心通信；前端永远不直接接触授权中心地址外的签名细节。
//
// 挂载纪律（恒挂载 + 请求期闸门，仿 localSyncProxy）：
//   - mode=off（默认）：getLicenseHandles() 为 null，GET /status 返回 available:false/bypassed，
//     其余写端点 404 LICENSE_DISABLED——默认逐字节同今天，前端门控也不显示入口；
//   - verify/enforce：requireActiveUser；授权管理动作（activate/refresh/import/contact）仅 owner/admin，
//     反馈通道任何登录成员可用（07：免费/商业均可反馈）。
//
// 可注入性：createLicenseRoutes({handles?}) 供 headless 单测传假句柄；生产默认零参数。
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "../httpError.js";
import { requireActiveUser } from "../middleware/authActive.js";
import {
  getLicenseHandles,
  triggerLicenseHeartbeat,
  isHeartbeatFresh,
  type RuntimeHandles,
} from "../domain/license/runtime.js";
import { listSeatUsers, getUserOrgRole, isOrgAdminRole, invalidateSeatCache } from "../domain/license/seats.js";
import { invalidateLicenseGateCache } from "../middleware/licenseSeatGate.js";
import { VERDICT_LABEL } from "../domain/license/copy.js";
import type { FeedbackAttachmentInput } from "../domain/license/feedback.js";

export interface LicenseRoutesDeps {
  /** 运行时句柄（生产默认 getLicenseHandles；headless 测试注入假句柄）。 */
  handles?: () => RuntimeHandles | null;
  /** 鉴权中间件（生产默认 requireActiveUser；headless 测试可注入直通桩）。 */
  authMiddleware?: MiddlewareHandler;
  /** 管理员判定（生产默认查 role_assignments；headless 测试可注入）。 */
  userRole?: (userId: string) => Promise<"owner" | "admin" | "member">;
}

const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ATTACH_PATH_RE = /^\/?v1\/feedback\/attachment\/[A-Za-z0-9._-]+$/;

export function createLicenseRoutes(deps: LicenseRoutesDeps = {}): Hono {
  const handles = deps.handles ?? getLicenseHandles;
  const userRole = deps.userRole ?? getUserOrgRole;
  const routes = new Hono();

  routes.use("*", deps.authMiddleware ?? requireActiveUser);

  // 续费/激活/导入成功：单据已变，立即让席位与闸门②重算（不必等 10s/30s TTL），
  // 并非阻塞补一次心跳与授权中心对齐。
  function bumpAfterEntitlementChange(): void {
    invalidateSeatCache();
    invalidateLicenseGateCache();
    triggerLicenseHeartbeat();
  }

  function requireHandles(): RuntimeHandles {
    const h = handles();
    if (!h) throw new HttpError(404, "授权服务未启用", "LICENSE_DISABLED");
    return h;
  }

  async function requireAdmin(c: Context): Promise<RuntimeHandles> {
    const h = handles();
    if (!h) throw new HttpError(404, "授权服务未启用", "LICENSE_DISABLED");
    const userId = c.get("auth")?.userId;
    if (!userId) throw new HttpError(401, "未登录或登录态已失效");
    const role = await userRole(userId);
    if (!isOrgAdminRole(role)) throw new HttpError(403, "仅管理员可管理授权", "LICENSE_ADMIN_ONLY");
    return h;
  }

  // 1) GET /status —— 任何登录成员可读（grace 横幅/挂起页依赖）。
  routes.get("/status", async (c) => {
    const h = handles();
    if (!h) {
      return c.json({
        available: false,
        mode: "off",
        verdict: "bypassed",
        verdictLabel: VERDICT_LABEL.bypassed,
        seats: null,
        usedSeats: null,
      });
    }
    const view = await h.client.getView();
    const snapshot = await listSeatUsers();
    const badge = h.client.getFeedbackBadge();
    // 当前成员是否管理员（owner/admin）：前端据此显隐激活/续费/导入/联系信息管理区；
    // 后端每个写端点仍独立鉴权（403 LICENSE_ADMIN_ONLY），此处仅用于 UI 显隐，不作安全边界。
    const userId = c.get("auth")?.userId ?? "";
    const isAdmin = userId ? isOrgAdminRole(await userRole(userId)) : false;
    const contact = await h.store.getContact().catch(() => ({ adminEmail: "", orgName: "" }));
    const health = h.health();
    const online = isHeartbeatFresh(health.lastOkAt, h.cfg);
    return c.json({
      available: true,
      mode: view.mode,
      verdict: view.verdict,
      verdictLabel: VERDICT_LABEL[view.verdict] ?? view.verdict,
      seats: view.seats === Infinity ? null : view.seats,
      usedSeats: snapshot.occupied,
      isAdmin,
      adminEmail: contact.adminEmail || null,
      orgName: contact.orgName || null,
      licensedTo: view.licensedTo ?? null,
      expiresAt: view.expiresAt ?? null,
      version: view.version ?? null,
      everCommercial: view.everCommercial,
      fingerprintShort: h.client.fingerprint.slice(0, 12),
      // baseUrl 仍回给机器字段，但前端一律不渲染（避免让用户感觉被监控）。
      baseUrl: h.client.currentBaseUrl,
      online,
      lastHeartbeatAt: health.lastOkAt,
      lastAttemptAt: health.lastRunAt,
      syncing: health.inFlight,
      deploymentId: h.client.deploymentId || null,
      platform: h.client.platform || null,
      // 完整指纹仅给管理员：用于报给官方后台「凭指纹直绑」（零输入首激活主路径）。
      ...(isAdmin ? { fingerprint: h.client.fingerprint } : {}),
      feedback: badge ?? { unread: 0, open: 0 },
    });
  });

  // 2) POST /sync —— 免输入「立即同步」，仅管理员。
  //    触发一次可等待心跳（续费/扩容/吊销/后台直绑由授权中心经心跳下发），直接回成败，
  //    不要求用户提供任何密钥；后台直绑前提是本机已先心跳报到（否则提示先等设备上线）。
  routes.post("/sync", async (c) => {
    const h = await requireAdmin(c);
    const out = (await h.pulse()) ?? null;
    if (out?.ok) {
      // runHeartbeat 已 invalidateSeatCache + emitLicenseChanged；这里只补闸门②缓存，
      // 不调 triggerLicenseHeartbeat（避免与本次心跳重复打一跳）。
      invalidateLicenseGateCache();
    }
    const view = await h.client.getView();
    const health = h.health();
    const body: Record<string, unknown> = {
      ok: !!out?.ok,
      status: out?.status ?? 0,
      error: out?.ok ? null : (out?.error ?? out?.rejected ?? "同步失败，请稍后重试"),
      rejected: out?.rejected ?? null,
      verdict: view.verdict,
      verdictLabel: VERDICT_LABEL[view.verdict] ?? view.verdict,
      seats: view.seats === Infinity ? null : view.seats,
      online: isHeartbeatFresh(health.lastOkAt, h.cfg),
      lastHeartbeatAt: health.lastOkAt,
    };
    // 接收链拒绝（验签/指纹/回滚）与 activate/refresh 同口径：HTTP 200 + ok:false + rejected；
    // 网络/网关错（status=0 或 5xx）回 502，429 透传。
    const httpStatus = !out
      ? 502
      : out.ok
        ? 200
        : out.status === 429
          ? 429
          : out.rejected
            ? 200
            : out.status >= 400 && out.status < 500
              ? (out.status as ContentfulStatusCode)
              : 502;
    return c.json(body, httpStatus as ContentfulStatusCode);
  });

  // 3) POST /activate —— 仅管理员（旧密钥通道：前端 UI 已移除入口，端点保留兼容旧包）。
  routes.post("/activate", async (c) => {
    const h = await requireAdmin(c);
    const body = (await c.req.json().catch(() => ({}))) as { licenseKey?: string; pairCode?: string };
    const out = await h.client.activate({
      licenseKey: typeof body.licenseKey === "string" ? body.licenseKey.trim() : undefined,
      pairCode: typeof body.pairCode === "string" ? body.pairCode.trim() : undefined,
    });
    if (out.ok) bumpAfterEntitlementChange();
    return c.json(outcomeToJson(out), out.ok ? 200 : outcomeStatus(out));
  });

  // 3) POST /refresh —— 仅管理员。
  routes.post("/refresh", async (c) => {
    const h = await requireAdmin(c);
    const body = (await c.req.json().catch(() => ({}))) as { licenseKey?: string };
    const key = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
    if (!key) throw new HttpError(400, "缺少 licenseKey", "BAD_REQUEST");
    const out = await h.client.refresh(key);
    if (out.ok) bumpAfterEntitlementChange();
    return c.json(outcomeToJson(out), out.ok ? 200 : outcomeStatus(out));
  });

  // 4) POST /import-offline —— 仅管理员。
  routes.post("/import-offline", async (c) => {
    const h = await requireAdmin(c);
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const code = typeof body.code === "string" ? body.code : "";
    if (!code.trim()) throw new HttpError(400, "缺少应答码", "BAD_REQUEST");
    const out = await h.client.importOfflineResponse(code);
    if (out.ok) bumpAfterEntitlementChange();
    return c.json(outcomeToJson(out), out.ok ? 200 : outcomeStatus(out));
  });

  // 5) POST /contact —— 自报管理员邮箱/团队名（心跳字段分级用），仅管理员。
  routes.post("/contact", async (c) => {
    const h = await requireAdmin(c);
    const body = (await c.req.json().catch(() => ({}))) as { adminEmail?: string; orgName?: string };
    const adminEmail = typeof body.adminEmail === "string" ? body.adminEmail.trim() : "";
    const orgName = typeof body.orgName === "string" ? body.orgName.trim().slice(0, 120) : "";
    if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      throw new HttpError(400, "邮箱格式不正确", "BAD_REQUEST");
    }
    await h.store.setContact({ adminEmail, orgName });
    return c.json({ ok: true });
  });

  // 6) POST /feedback —— multipart，任何登录成员。
  routes.post("/feedback", async (c) => {
    const h = requireHandles();
    const form = await c.req.formData();
    const files = await readAttachments(form);
    const res = await h.feedback.submit({
      content: String(form.get("content") ?? ""),
      category: optStr(form.get("category")),
      contactEmail: optStr(form.get("contactEmail")),
      contactPhone: optStr(form.get("contactPhone")),
      files,
    });
    return c.json(res.json as Record<string, unknown>, feedbackStatus(res.status));
  });

  // 7) POST /feedback/poll
  routes.post("/feedback/poll", async (c) => {
    const h = requireHandles();
    const body = (await c.req.json().catch(() => ({}))) as { sinceMs?: number };
    const res = await h.feedback.poll(typeof body.sinceMs === "number" ? body.sinceMs : undefined);
    if (res.status === 200) h.client.clearFeedbackBadge();
    return c.json(res.json as Record<string, unknown>, feedbackStatus(res.status));
  });

  // 8) POST /feedback/:id/reply
  routes.post("/feedback/:id/reply", async (c) => {
    const h = requireHandles();
    const ticketId = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ticketId)) throw new HttpError(400, "非法工单 id", "BAD_REQUEST");
    const form = await c.req.formData();
    const files = await readAttachments(form);
    const res = await h.feedback.reply(ticketId, String(form.get("content") ?? ""), files);
    return c.json(res.json as Record<string, unknown>, feedbackStatus(res.status));
  });

  // 9) GET /feedback/attachment?path=<授权中心能力相对路径> —— 代理（指纹由通道自动带）。
  routes.get("/feedback/attachment", async (c) => {
    const h = requireHandles();
    const path = c.req.query("path") ?? "";
    if (!ATTACH_PATH_RE.test(path)) throw new HttpError(400, "非法附件路径", "BAD_REQUEST");
    const raw = await h.feedback.fetchAttachment(path.startsWith("/") ? path : `/${path}`);
    if (raw.status !== 200) throw new HttpError(raw.status, "附件不可用", "FEEDBACK_ATTACHMENT_UNAVAILABLE");
    return new Response(new Uint8Array(raw.buffer), {
      headers: { "content-type": raw.contentType || "application/octet-stream" },
    });
  });

  return routes;
}

function optStr(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
}

const ALLOWED_ATTACH_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "zip", "log", "txt", "pdf", "mp4", "mov",
]);

async function readAttachments(form: FormData): Promise<FeedbackAttachmentInput[]> {
  const files: FeedbackAttachmentInput[] = [];
  let total = 0;
  for (const entry of form.getAll("attachments")) {
    if (typeof entry === "string") continue;
    if (files.length >= 5) throw new HttpError(400, "最多 5 个附件", "FEEDBACK_BAD_REQUEST");
    const ext = (entry.name.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_ATTACH_EXT.has(ext)) {
      throw new HttpError(400, "不支持的附件类型", "FEEDBACK_BAD_FILE_TYPE");
    }
    const bytes = Buffer.from(await entry.arrayBuffer());
    if (bytes.length > MAX_ATTACH_BYTES) {
      throw new HttpError(413, "单个附件超过 8MB", "FEEDBACK_FILE_TOO_LARGE");
    }
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new HttpError(413, "附件合计超过 20MB", "FEEDBACK_FILE_TOO_LARGE");
    }
    files.push({ name: entry.name, type: entry.type || "application/octet-stream", bytes });
  }
  return files;
}

/** 反馈通道状态映射：4xx 原样透传（FEEDBACK_* 错误码），2xx 归 200，5xx/0 归 502。 */
function feedbackStatus(status: number): ContentfulStatusCode {
  if (status >= 400 && status < 500) return status as ContentfulStatusCode;
  if (status >= 200 && status < 300) return 200;
  return 502;
}

interface Outcome {
  ok: boolean;
  status: number;
  error?: string;
  rejected?: string;
}

function outcomeStatus(o: Outcome): ContentfulStatusCode {
  if (o.status === 429) return 429;
  if (o.status >= 400 && o.status < 500) return o.status as ContentfulStatusCode;
  if (o.rejected) return 200; // 接收链拒绝（验签/指纹/回滚）：HTTP 仍 200，前端按 rejected 提示免费档
  return 502;
}

function outcomeToJson(o: Outcome): Record<string, unknown> {
  return { ok: o.ok, status: o.status, error: o.error ?? null, rejected: o.rejected ?? null };
}

export const licenseRoutes = createLicenseRoutes();
