/**
 * 反馈中心用户端通道（01 §4）。免费/商业均可用；失败只本地提示，绝不影响授权主链。
 * 指纹由调用方（client/路由）注入，本模块不持有状态。
 */
import type { HttpTransport, RawResponse } from "./http.js";

export interface FeedbackAttachmentInput {
  name: string;
  type: string;
  bytes: Buffer;
}

export interface FeedbackChannelDeps {
  transport: HttpTransport;
  baseUrl: () => string;
  fingerprint: () => string;
  appVersion: () => string;
}

/** Buffer -> 独立 ArrayBuffer（精确长度拷贝；规避 Node Buffer 的 ArrayBufferLike 与 BlobPart 不兼容）。 */
function toBlobPart(bytes: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export class FeedbackChannel {
  constructor(private deps: FeedbackChannelDeps) {}

  private get url(): string {
    return this.deps.baseUrl();
  }

  async submit(input: {
    content: string;
    category?: string;
    contactEmail?: string;
    contactPhone?: string;
    files?: FeedbackAttachmentInput[];
  }): Promise<{ status: number; json: unknown }> {
    const form = new FormData();
    form.set("fingerprint", this.deps.fingerprint());
    form.set("content", input.content);
    if (input.category) form.set("category", input.category);
    if (input.contactEmail) form.set("contactEmail", input.contactEmail);
    if (input.contactPhone) form.set("contactPhone", input.contactPhone);
    form.set("appVersion", this.deps.appVersion());
    for (const f of input.files ?? []) {
      form.append("attachments", new Blob([toBlobPart(f.bytes)], { type: f.type }), f.name);
    }
    const res = await this.deps.transport.postForm(this.url, "/v1/feedback", form);
    return { status: res.status, json: res.json };
  }

  async poll(sinceMs?: number): Promise<{ status: number; json: unknown }> {
    const body: Record<string, unknown> = { fingerprint: this.deps.fingerprint() };
    if (sinceMs) body.sinceMs = sinceMs;
    const res = await this.deps.transport.post(this.url, "/v1/feedback/poll", body);
    return { status: res.status, json: res.json };
  }

  async reply(ticketId: string, content: string, files: FeedbackAttachmentInput[] = []): Promise<{ status: number; json: unknown }> {
    const form = new FormData();
    form.set("fingerprint", this.deps.fingerprint());
    form.set("content", content);
    for (const f of files) form.append("attachments", new Blob([toBlobPart(f.bytes)], { type: f.type }), f.name);
    const res = await this.deps.transport.postForm(this.url, `/v1/feedback/${encodeURIComponent(ticketId)}/reply`, form);
    return { status: res.status, json: res.json };
  }

  async fetchAttachment(urlPath: string): Promise<RawResponse> {
    return this.deps.transport.getRaw(this.url, urlPath);
  }
}
