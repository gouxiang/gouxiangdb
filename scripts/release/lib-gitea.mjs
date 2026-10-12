// scripts/release/lib-gitea.mjs
// Gitea API 薄封装（DESIGN §8.2）：仅发布脚本使用，Node 22 全局 fetch，零第三方依赖。
//
// 安全纪律（2026-10-11 真实 PAT 实测封板，DESIGN §8.1）：
//   - 令牌只从发布机 env GX_GITEA_TOKEN（发布人【写】令牌）读取，绝不落命令行参数（ps 可见）；
//   - 严禁使用 API 返回的 browser_download_url / url 字段（实测其值是内网地址 192.168.31.88:21350）；
//   - 所有错误经 sanitizeGiteaError 净化后再抛出：只保留 status 与 Gitea 的 message 字段，
//     绝不回显响应体/响应头中可能出现的内网 URL；
//   - 资产下载固定路径由配置 base 自行拼：<base>/<owner>/<repo>/releases/download/<tag>/<name>。

/**
 * 净化 Gitea 错误：不回显原始响应体（含内网 swagger URL）。
 * @param {number} status HTTP 状态码
 * @param {string} method HTTP 方法（仅用于定位）
 * @param {string} what 操作对象（不含 query）
 * @param {unknown} body 已解析的响应体（尝试取 Gitea 标准 message，其余丢弃）
 */
export class GiteaApiError extends Error {
  constructor(status, method, what, detail) {
    super(`Gitea API ${method} ${what} 失败：HTTP ${status}${detail ? `（${detail}）` : ""}`);
    this.name = "GiteaApiError";
    this.status = status;
  }
}

function pickGiteaMessage(body) {
  if (body && typeof body === "object") {
    if (typeof body.message === "string" && body.message.trim() !== "") return body.message.slice(0, 200);
    // 校验错误时 Gitea 返回 { errors: [...], message }；不递归 dump，只报条数。
    if (Array.isArray(body.errors)) return `${body.errors.length} 条字段校验错误`;
  }
  return null;
}

export function createGiteaClient({ baseUrl, token, owner, repo, fetchImpl }) {
  if (!baseUrl || typeof baseUrl !== "string") throw new Error("createGiteaClient: baseUrl 必填");
  if (!token || typeof token !== "string") throw new Error("createGiteaClient: token 必填（GX_GITEA_TOKEN）");
  if (!owner || !repo) throw new Error("createGiteaClient: owner/repo 必填");
  const base = baseUrl.replace(/\/+$/, "");
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("createGiteaClient: 环境无全局 fetch");

  const apiBase = `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function call(method, urlPath, { body, raw, accept } = {}) {
    // JSON body（body 选项）默认带 application/json——Gitea 对 POST/PATCH 缺该头直接 422
    // "Unsupported Content-Type"。raw（FormData 上传）必须不设 Content-Type，边界由 fetch 生成。
    const isRaw = raw !== undefined;
    let res;
    try {
      res = await fetchFn(`${apiBase}${urlPath}`, {
        method,
        headers: {
          Authorization: `token ${token}`,
          ...(isRaw ? {} : { "Content-Type": "application/json" }),
          ...(accept ? { Accept: accept } : {}),
        },
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        redirect: "follow",
      });
    } catch (e) {
      // 网络层错误本身不含内网 URL（只含 host），但仍收口成统一错误，避免堆栈带完整 URL 被打印。
      throw new GiteaApiError(0, method, urlPath.split("?")[0], "网络不可达");
    }
    if (res.status === 204) return null;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      throw new GiteaApiError(res.status, method, urlPath.split("?")[0], pickGiteaMessage(parsed));
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GiteaApiError(res.status, method, urlPath.split("?")[0], "响应不是合法 JSON");
    }
  }

  return {
    base,
    /** 按 tag 取 release；不存在返回 null（不抛 404，便于幂等判断）。 */
    async getReleaseByTag(tag) {
      try {
        return await call("GET", `/releases/tags/${encodeURIComponent(tag)}`);
      } catch (e) {
        if (e instanceof GiteaApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** 创建 release（body 见 Gitea CreateReleaseOption）。 */
    async createRelease(payload) {
      return call("POST", "/releases", { body: payload });
    },

    /** 取最新【稳定】release（Gitea /releases/latest 不含 prerelease/draft）；无则 null。 */
    async getLatestStableRelease() {
      try {
        return await call("GET", "/releases/latest");
      } catch (e) {
        if (e instanceof GiteaApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** 列某 release 的资产。 */
    async listAssets(releaseId) {
      const list = await call("GET", `/releases/${encodeURIComponent(String(releaseId))}/assets?limit=100`);
      return Array.isArray(list) ? list : [];
    },

    /** 删除资产（同名资产先删后传，保证幂等）。 */
    async deleteAsset(assetId) {
      return call("DELETE", `/releases/assets/${encodeURIComponent(String(assetId))}`);
    },

    /**
     * 上传资产（multipart/form-data；Gitea 1.27 单文件字段名 attachment）。
     * @param {number|string} releaseId
     * @param {string} name 保存到 release 上的文件名
     * @param {Buffer|Uint8Array} content
     */
    async uploadAsset(releaseId, name, content) {
      const form = new FormData();
      form.append("attachment", new Blob([content], { type: "application/octet-stream" }), name);
      // FormData 时不要手设 Content-Type（边界由 fetch 生成）。
      return call(
        "POST",
        `/releases/${encodeURIComponent(String(releaseId))}/assets?name=${encodeURIComponent(name)}`,
        { raw: form },
      );
    },

    /**
     * 资产直链（固定路径自拼，禁用 API 返回的 browser_download_url）。
     * 供回读校验的 HEAD/GET 用；调用方需自行带 token 头。
     */
    assetDownloadUrl(tag, name) {
      return `${base}/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    },

    /** 带令牌的 HEAD（回读校验：资产真的可被只读令牌形态下载）。 */
    async headReleaseAsset(tag, name) {
      const url = this.assetDownloadUrl(tag, name);
      let res;
      try {
        res = await fetchFn(url, { method: "HEAD", headers: { Authorization: `token ${token}` } });
      } catch {
        throw new GiteaApiError(0, "HEAD", "/releases/download/:asset", "网络不可达");
      }
      if (!res.ok) throw new GiteaApiError(res.status, "HEAD", "/releases/download/:asset", null);
      return { size: Number(res.headers.get("content-length") || 0) };
    },
  };
}
