// 官方反馈通道透传类型与响应归一化（从 src/api/license.ts 拆出，守单文件 ≤300 行）。
//
// 契约缺口（如实登记）：/feedback* 的业务 JSON 由【私有授权后台】定义，本仓 BFF 原样透传
// （apps/api/src/routes/license.ts feedbackStatus 只改 HTTP 状态码），packages/shared-types
// 无对应 DTO。下列类型是对后台形状的最小宽容投影，normalize* 对缺字段/异类名做兜底；
// 后台字段不符时列表降级为空态而不是崩溃。待后台冻结契约后应上移 shared-types。

/** 工单附件（后台返回；path 交给 GET /feedback/attachment?path= 同源代理）。 */
export interface FeedbackAttachmentView {
  name: string;
  /** 授权中心能力相对路径，形如 /v1/feedback/attachment/xxx；直接拼本仓代理即可。 */
  path: string | null;
  url: string | null;
  size: number | null;
  contentType: string | null;
}

/** 工单内一条消息（用户提交 / 官方回复）。 */
export interface FeedbackMessageView {
  id: string;
  /** staff=true 表示官方回复；默认 false（用户自己的内容）。 */
  staff: boolean;
  content: string;
  createdAtMs: number | null;
  attachments: FeedbackAttachmentView[];
}

/** 一张工单。 */
export interface FeedbackTicketView {
  id: string;
  subject: string;
  content: string;
  category: string | null;
  /** open/pending/resolved/closed；未知值原样保留。 */
  status: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  unread: boolean;
  messages: FeedbackMessageView[];
}

/** POST /feedback/poll 归一结果。 */
export interface FeedbackPollView {
  tickets: FeedbackTicketView[];
  /** 后台游标（毫秒）；缺省用客户端当前时间。 */
  serverTimeMs: number | null;
}

/** POST /feedback 提交结果。 */
export interface FeedbackSubmitResult {
  ok: boolean;
  ticketId: string | null;
  error: string | null;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 后台时间字段可能是 epoch 秒/毫秒或 ISO 字符串；统一归一成 epoch 毫秒。 */
export function toTimeMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && /^\d+$/.test(v.trim())) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function normalizeAttachment(v: unknown): FeedbackAttachmentView | null {
  const o = asRecord(v);
  // id/filename 等异类名在 path/url 缺失时兜底拼路径（后台约定 /v1/feedback/attachment/:id）。
  const id = str(o.id) ?? str(o.attachmentId) ?? str(o.key);
  const path = str(o.path) ?? str(o.pathName) ?? (id ? `/v1/feedback/attachment/${id}` : null);
  const name = str(o.name) ?? str(o.fileName) ?? str(o.filename) ?? (id ?? "附件");
  return {
    name,
    path,
    url: str(o.url) ?? str(o.downloadUrl) ?? null,
    size: num(o.size) ?? num(o.sizeBytes) ?? num(o.bytes),
    contentType: str(o.contentType) ?? str(o.type) ?? str(o.mime),
  };
}

function normalizeMessage(v: unknown, fallbackContent = "", fallbackId = ""): FeedbackMessageView {
  const o = asRecord(v);
  const fromStaff =
    bool(o.staff) || bool(o.fromStaff) || bool(o.isReply) || str(o.direction) === "staff" || str(o.sender) === "staff";
  return {
    id: str(o.id) ?? str(o.messageId) ?? fallbackId,
    staff: fromStaff,
    content: str(o.content) ?? str(o.body) ?? str(o.text) ?? fallbackContent,
    createdAtMs: toTimeMs(o.createdAt ?? o.createdAtMs ?? o.time ?? o.at),
    attachments: asArray(o.attachments ?? o.files)
      .map(normalizeAttachment)
      .filter((a): a is FeedbackAttachmentView => a !== null),
  };
}

function ticketUnread(o: Record<string, unknown>): boolean {
  const count = num(o.unreadCount);
  if (count !== null) return count > 0;
  return bool(o.unread) || bool(o.hasUnread);
}

function normalizeTicket(v: unknown, index: number): FeedbackTicketView {
  const o = asRecord(v);
  const id = str(o.id) ?? str(o.ticketId) ?? `ticket-${index + 1}`;
  const content = str(o.content) ?? str(o.body) ?? str(o.description) ?? "";
  const subject = str(o.subject) ?? str(o.title) ?? (content ? content.slice(0, 40) : `工单 ${id}`);
  const rawReplies = asArray(o.replies ?? o.messages ?? o.threads);
  // 没有消息数组时，用工单自身内容合成一条用户消息，保证用户能看到自己提过什么。
  const messages: FeedbackMessageView[] = rawReplies.length
    ? rawReplies.map((m, i) => normalizeMessage(m, "", `${id}-m-${i + 1}`))
    : content
      ? [{ id: `${id}-seed`, staff: false, content, createdAtMs: toTimeMs(o.createdAt ?? o.createdAtMs), attachments: [] }]
      : [];
  return {
    id,
    subject,
    content,
    category: str(o.category),
    status: str(o.status) ?? "open",
    createdAtMs: toTimeMs(o.createdAt ?? o.createdAtMs),
    updatedAtMs: toTimeMs(o.updatedAt ?? o.updatedAtMs ?? o.lastReplyAt),
    unread: ticketUnread(o),
    messages,
  };
}

/** 归一 poll 响应。容忍 {tickets} / {items} / {data:{tickets}} / {data:[...]} / 裸数组等形状。 */
export function normalizePollResponse(json: unknown): FeedbackPollView {
  const root = asRecord(json);
  let listRaw: unknown = root.tickets ?? root.items;
  if (listRaw === undefined) {
    listRaw = root.data !== undefined ? (asRecord(root.data).tickets ?? root.data) : json;
  }
  const tickets = asArray(listRaw).map(normalizeTicket);
  return {
    tickets,
    serverTimeMs: toTimeMs(root.serverTime ?? root.serverTimeMs ?? root.now),
  };
}
