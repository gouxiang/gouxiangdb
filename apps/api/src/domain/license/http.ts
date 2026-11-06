/**
 * 授权中心 HTTP 传输（全局 fetch；Node22 内置，零依赖）。
 *  - post：JSON；postForm：multipart（反馈/追问）；getRaw：附件下载。
 *  - 统一超时（AbortController）；不抛 4xx/5xx（交调用方按状态分流），仅网络错误才 reject。
 *  - 429 解析 Retry-After（秒）供退避；5xx 标记可回退下一地址。
 */

export interface HttpResponse {
  status: number;
  json: unknown;
  retryAfterSec: number | null;
  rawText?: string;
}

export interface RawResponse {
  status: number;
  contentType: string;
  size: number;
  buffer: Buffer;
}

export interface HttpTransport {
  post(baseUrl: string, path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
  postForm(baseUrl: string, path: string, form: FormData, headers?: Record<string, string>): Promise<HttpResponse>;
  getRaw(baseUrl: string, path: string, headers?: Record<string, string>): Promise<RawResponse>;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec);
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly timeoutMs: number = 10_000) {}

  private async send(url: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
    const res = await this.send(joinUrl(baseUrl, path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: await readJsonSafe(res),
      retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
    };
  }

  async postForm(baseUrl: string, path: string, form: FormData, headers: Record<string, string> = {}): Promise<HttpResponse> {
    const res = await this.send(joinUrl(baseUrl, path), { method: "POST", headers, body: form });
    return {
      status: res.status,
      json: await readJsonSafe(res),
      retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
    };
  }

  async getRaw(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
    const res = await this.send(joinUrl(baseUrl, path), { method: "GET", headers });
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      size: buffer.length,
      buffer,
    };
  }
}

/** scheme 校验：仅 https；http 限内网白名单（09）。公网明文 http 即使在签名信封里也拒。 */
export function isAllowedLicenseUrl(url: string, whitelist: readonly RegExp[]): boolean {
  const u = url.trim();
  if (u.startsWith("https://")) return true;
  return whitelist.some((re) => re.test(u));
}
