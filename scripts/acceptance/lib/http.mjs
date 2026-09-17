// scripts/acceptance/lib/http.mjs
// 极简 JSON HTTP 客户端（全局 fetch，Node >=18，受管 node22 原生可用）。
// 单一职责：发请求、带 Bearer token、回传 {status, json, text}，不做业务断言。
// 失败（网络层/非预期状态）抛 HttpError，由调用方决定门是否失败。

export class HttpError extends Error {
  /**
   * @param {string} method
   * @param {string} url
   * @param {number} status
   * @param {string} bodyText
   */
  constructor(method, url, status, bodyText) {
    super(`${method} ${url} -> ${status}: ${bodyText.slice(0, 300)}`);
    this.name = "HttpError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.bodyText = bodyText;
  }
}

/**
 * @typedef {Object} ApiClient
 * @property {(path: string, init?: RequestInit) => Promise<{status:number, json:any, text:string}>} request
 * @property {(path: string, body?: unknown) => Promise<any>} get
 * @property {(path: string, body?: unknown) => Promise<any>} post
 * @property {(path: string, body?: unknown) => Promise<any>} put
 * @property {(path: string, body?: unknown) => Promise<any>} patch
 * @property {(path: string) => Promise<any>} del
 * @property {(token: string) => void} setToken
 */

/**
 * 创建一个绑定 baseUrl 的客户端。
 * @param {string} baseUrl 形如 http://127.0.0.1:33901
 * @param {{token?: string, prefix?: string}} [opts]
 * @returns {ApiClient}
 */
export function createClient(baseUrl, opts = {}) {
  const root = baseUrl.replace(/\/+$/, "");
  const prefix = opts.prefix ?? "/api";
  let token = opts.token ?? null;

  /**
   * URL 拼装：http(s) 绝对地址原样；相对路径若已带前缀（如 /api/v1/...）则不重复加，
   * 否则补 prefix（旧版与 v1 业务面都在 /api 下）。根级路由（/mcp、/healthz）请用裸 fetch
   * 或显式 {prefix:""} 的客户端访问。
   */
  function buildUrl(p) {
    if (p.startsWith("http")) return p;
    const rel = p.startsWith("/") ? p : `/${p}`;
    if (prefix && rel.startsWith(prefix)) return `${root}${rel}`;
    return `${root}${prefix}${rel}`;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function raw(method, p, body) {
    const url = buildUrl(p);
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HttpError(method, url, 0, `network: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /**
   * 发请求并返回完整响应（不校验状态码），供需要断言具体状态的对抗用例使用。
   * @param {string} path
   * @param {RequestInit & {json?: unknown}} [init]
   */
  async function request(p, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const url = buildUrl(p);
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.json !== undefined) headers.set("Content-Type", "application/json");
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(url, {
      method,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: res.status, json, text, headers: res.headers };
  }

  /**
   * 期望 2xx，否则抛错。返回 json 体。
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {number[]} [ok]
   */
  async function expect(method, path, body, ok = [200, 201, 204]) {
    const r = await raw(method, path, body);
    if (!ok.includes(r.status)) throw new HttpError(method, path, r.status, r.text);
    return r.json;
  }

  return {
    request,
    setToken(t) { token = t; },
    get: (p) => expect("GET", p),
    post: (p, b) => expect("POST", p, b),
    put: (p, b) => expect("PUT", p, b),
    patch: (p, b) => expect("PATCH", p, b),
    del: (p) => expect("DELETE", p, undefined),
    /** 非预期状态直接暴露，便于断言 403/404/413/400。 */
    raw,
  };
}

/**
 * 轮询直到 check 返回真值或超时。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {(v: T) => boolean} check
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [opts]
 */
export async function pollUntil(fn, check, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const intervalMs = opts.intervalMs ?? 300;
  const start = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (check(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`轮询超时（${opts.label ?? "condition"}），末次=${safeStringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function safeStringify(v) {
  try { return JSON.stringify(v)?.slice(0, 500); } catch { return String(v); }
}

/**
 * 等待 HTTP 健康端点就绪。
 * @param {string} baseUrl
 * @param {{timeoutMs?: number}} [opts]
 */
export async function waitForHealth(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/healthz`);
      if (res.ok) return;
    } catch { /* 未起，继续 */ }
    if (Date.now() - start > timeoutMs) throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${baseUrl}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
