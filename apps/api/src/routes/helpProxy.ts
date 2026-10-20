// 公开只读的帮助百科代理（挂载：api.route("/help", helpProxy) -> GET /api/help/wiki|asset）。
//
// 背景：桌面壳/浏览器是 127.0.0.1 同源页面，无法跨域直连内网 Gitea；Gitea wiki 渲染页还带
// x-frame-options: SAMEORIGIN，不能 iframe。故由后端服务端拉取 wiki 的 markdown 原文与图片，
// 再经同源 /api 出口给前端，前端复用自有 markdown 渲染。
//
// 铁律：
//   - 两个端点都公开匿名可读（挂在无全局鉴权的 api 实例上，绝不加 requireActiveUser）；
//   - 只发 GET、只透传必要响应头；Gitea token（若配置）只出现在服务端出站请求头里；
//   - 上游短超时（8s），失败一律 502 结构化信封，绝不把内网错误/堆栈透给浏览器；
//   - /asset 严格白名单（images/ 前缀 + 图片扩展名），防路径穿越，SVG 固定 image/svg+xml。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Hono, type Context } from "hono";

import { config } from "../config.js";

const HELP_HOME = "Home";
/** 前端拼图片 URL 的前缀（响应契约字段 imageBase 原样给出）。 */
const ASSET_ROUTE = "/api/help/asset?path=";
const UPSTREAM_TIMEOUT_MS = 8000;
const PAGES_TTL_MS = 60_000;

const FALLBACK_PAGES: WikiPageEntry[] = [{ title: HELP_HOME, href: HELP_HOME }];

export interface WikiPageEntry {
  title: string;
  href: string;
}

export interface WikiSettings {
  /** 不含尾斜杠的 wiki 仓库基址，如 https://host/owner/repo */
  wikiBase: string;
  /** Gitea API 基址，如 https://host/api/v1 */
  apiBase: string;
  /** 可选只读 PAT；为空走匿名 HTML 侧边栏解析 */
  token: string;
  owner: string;
  repo: string;
}

const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};
const ASSET_EXTENSIONS = new Set(Object.keys(ASSET_MIME));

// ---------------------------------------------------------------- 纯函数（可单测）

/**
 * 把 markdown 正文里的相对图片引用改写成同源代理地址：
 *   ![alt](images/foo.png) -> ![alt](/api/help/asset?path=images%2Ffoo.png)
 *   <img src="images/foo.png"> / src='images/foo.png' 同样覆盖（表格内 ![]() 不依赖行结构）。
 * 只改写以 images/ 开头的相对路径；http(s)://、data:、//、/ 开头的一律不动。
 */
export function rewriteWikiImageLinks(markdown: string): string {
  // markdown 图片：pre=!( 部分，rel=images/..（遇空白或 ) 结束，兼容 "title" 后缀），post=余下到 )。
  let out = markdown.replace(
    /(!\[[^\]]*\]\()(images\/[^)\s]+)([^)]*\))/g,
    (_m, pre: string, rel: string, post: string) =>
      `${pre}${ASSET_ROUTE}${encodeURIComponent(rel)}${post}`,
  );
  // HTML 属性形式：src="images/..." 或 src='images/...'（反向引用保证引号成对）。
  out = out.replace(
    /(\bsrc=)(["'])images\/([^"']+)\2/gi,
    (_m, pre: string, quote: string, rel: string) =>
      `${pre}${quote}${ASSET_ROUTE}${encodeURIComponent(`images/${rel}`)}${quote}`,
  );
  return out;
}

/**
 * 校验 /asset 的 path 参数。合法则返回归一后的相对路径，否则返回 null（调用方回 400）。
 * 拒绝：空、NUL、反斜杠、前导 /、非 images/ 前缀、任何 . / .. / 空段、非白名单扩展名。
 */
export function validateAssetPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/")) return null;
  if (!raw.startsWith("images/")) return null;
  const segments = raw.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  const ext = path.extname(raw).toLowerCase();
  if (!ASSET_EXTENSIONS.has(ext)) return null;
  return raw;
}

/**
 * 从 wiki 首页 HTML 的侧边栏链接解析页面目录。链接形如：
 *   /<owner>/<repo>/wiki                       -> Home
 *   /<owner>/<repo>/wiki/<encodeURIComponent标题>
 * 排除 ?action=、/wiki/raw/、带 # 的链接；按出现顺序去重，Home 永远排第一。
 * 另须排除 wiki 附件（images/ 前缀或图片/二进制扩展名）——Gitea 侧边栏 HTML 会把
 * 正文中的图片也渲染成 /wiki/images/...png 链接，它们不是可阅读的页面（点开会取到二进制乱码）。
 */
const ATTACHMENT_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif",
  ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".pdf", ".mp4", ".mov", ".webm", ".mp3", ".wav",
]);

/** 判断一个已解码的 wiki 条目是否为附件（而非可读页面）。 */
export function isWikiAttachment(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t.startsWith("images/") || t.startsWith("attachments/")) return true;
  const dot = t.lastIndexOf(".");
  if (dot === -1) return false;
  return ATTACHMENT_EXT.has(t.slice(dot).toLowerCase());
}

export function parseWikiSidebar(html: string, owner: string, repo: string): WikiPageEntry[] {
  const collected: WikiPageEntry[] = [];
  const seen = new Set<string>();
  const push = (title: string) => {
    const t = title.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      collected.push({ title: t, href: t });
    }
  };

  const wikiPrefix = `/${owner}/${repo}/wiki`;
  const hrefRe = /href=(["'])([^"']+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    let href = m[2] as string;
    // 兼容写成完整 URL 的侧边栏链接（只取路径段）。
    try {
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
    } catch {
      continue;
    }
    if (href.includes("#") || href.includes("?action=") || href.includes("/wiki/raw/")) continue;
    if (href === wikiPrefix || href === `${wikiPrefix}/`) {
      push(HELP_HOME);
      continue;
    }
    if (!href.startsWith(`${wikiPrefix}/`)) continue;
    const rest = href.slice(wikiPrefix.length + 1).split("?")[0];
    if (!rest) continue;
    try {
      const title = decodeURIComponent(rest);
      // 跳过图片/二进制附件（images/tour/02-grid.png 等），它们不是页面。
      if (isWikiAttachment(title)) continue;
      push(title);
    } catch {
      // 非法百分号编码直接忽略。
    }
  }

  // Home 固定排第一：原本已收录则挪到首位，否则补一个（目录降级时也至少有 Home）。
  const homeIdx = collected.findIndex((p) => p.title === HELP_HOME);
  if (homeIdx > 0) {
    const [home] = collected.splice(homeIdx, 1);
    if (home) collected.unshift(home);
  } else if (homeIdx === -1) {
    collected.unshift({ title: HELP_HOME, href: HELP_HOME });
  }
  return collected;
}

/** 从 config 快照解析 wiki 设置（owner/repo 取基址路径前两段；apiBase 默认同源推导）。 */
export function resolveWikiSettings(): WikiSettings {
  const wikiBase = config.helpWikiBase;
  let owner = "";
  let repo = "";
  try {
    const segments = new URL(wikiBase).pathname.split("/").filter(Boolean);
    owner = segments[0] ?? "";
    repo = segments[1] ?? "";
  } catch {
    // 默认配置合法；自定义非法基址时 owner/repo 为空，目录 API 路径会 401/404 后走降级，正文仍可直取。
  }
  return {
    wikiBase,
    apiBase: config.giteaApiBase,
    token: config.giteaToken,
    owner,
    repo,
  };
}

// ---------------------------------------------------------------- 出站拉取

type FetchImpl = typeof fetch;

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  return fetchImpl(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * 取 wiki 全站页面目录。两级策略：
 *   a) 配了 token：GET <apiBase>/repos/<owner>/<repo>/wiki/pages（JSON，Authorization 头）；
 *   b) 匿名：拉 <wikiBase>/wiki 首页 HTML 解析侧边栏。
 * 任何非 200/解析失败都抛错，由调用方决定降级；本函数不吞错。
 */
export async function fetchWikiPages(
  settings: WikiSettings,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<WikiPageEntry[]> {
  if (settings.token) {
    const url = `${settings.apiBase}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/wiki/pages`;
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: "application/json", Authorization: `token ${settings.token}` } },
      fetchImpl,
    );
    if (!res.ok) throw new Error(`wiki pages api status ${res.status}`);
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error("wiki pages api payload is not an array");
    const pages: WikiPageEntry[] = [];
    for (const item of data) {
      const title =
        item && typeof item === "object" && "title" in item
          ? (item as { title?: unknown }).title
          : undefined;
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("wiki pages api entry missing title");
      }
      const t = title.trim();
      // 防御性过滤附件（与匿名解析路径保持一致）。
      if (isWikiAttachment(t)) continue;
      pages.push({ title: t, href: t });
    }
    return pages;
  }

  const res = await fetchWithTimeout(
    `${settings.wikiBase}/wiki`,
    { headers: { Accept: "text/html" } },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`wiki home html status ${res.status}`);
  const html = await res.text();
  return parseWikiSidebar(html, settings.owner, settings.repo);
}

// 目录短 TTL 内存缓存（单进程；超时或失败后退回旧缓存/兜底，均不拖垮正文）。
let pagesCache: { at: number; pages: WikiPageEntry[] } | null = null;

async function getPages(settings: WikiSettings): Promise<WikiPageEntry[]> {
  const now = Date.now();
  if (pagesCache && now - pagesCache.at < PAGES_TTL_MS) return pagesCache.pages;
  try {
    const pages = await fetchWikiPages(settings);
    pagesCache = { at: now, pages };
    return pages;
  } catch {
    // 上游目录挂了：优先沿用旧缓存，再不行兜底单个 Home；正文绝不受影响。
    return pagesCache?.pages ?? FALLBACK_PAGES;
  }
}

/** 测试辅助：清空目录缓存（路由模块级单例）。 */
export function __resetHelpProxyCacheForTest(): void {
  pagesCache = null;
}

// ---------------------------------------------------------------- 持久离线缓存
//
// S7a：断网/Gitea 挂了时帮助中心仍可读「上次成功打开过」的页面与图片。在线成功时把正文
// JSON 与图片字节 best-effort 落到 <dataDir>/help-cache，不设 TTL/不淘汰（本版离线安全网，
// 戴总已拍板不做配额）。任何写/读盘错误都不得拖垮在线 200；仅在上游失败时才回读缓存。

interface CachedWikiPayload {
  ok: true;
  page: string;
  home: string;
  markdown: string;
  imageBase: string;
  pages: WikiPageEntry[];
  updatedAt?: string;
}

interface CachedWikiEnvelope {
  fetchedAt: string;
  payload: CachedWikiPayload;
}

interface CachedAssetMeta {
  contentType: string;
  fetchedAt: string;
}

let cacheRootOverride: string | null = null;

/** 测试注入：把持久缓存根指到临时目录；传 null 恢复默认 <dataDir>/help-cache。 */
export function __setHelpCacheRootForTest(root: string | null): void {
  cacheRootOverride = root;
}

function helpCacheRoot(): string {
  return cacheRootOverride ?? path.join(config.dataDir, "help-cache");
}

function cacheHash(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function wikiCachePath(page: string): { dir: string; file: string } {
  const dir = path.join(helpCacheRoot(), "pages");
  return { dir, file: path.join(dir, `${cacheHash(`wiki:${page}`)}.json`) };
}

function assetCachePaths(safePath: string): { dir: string; bin: string; meta: string } {
  const dir = path.join(helpCacheRoot(), "assets");
  const hash = cacheHash(`asset:${safePath}`);
  return { dir, bin: path.join(dir, `${hash}.bin`), meta: path.join(dir, `${hash}.meta.json`) };
}

/**
 * 原子写：临时文件与目标【同目录】（同设备，rename 原子），再 fs.rename 落位。
 * 刻意不用 os.tmpdir()：Docker/飞牛上 dataDir 常是独立 volume（/data），与容器层 /tmp
 * 跨挂载点，rename 会 EXDEV 导致离线缓存永远写不进去；同目录 rename 无此问题。
 * 任何失败都吞掉（best-effort）。
 */
async function atomicWrite(targetDir: string, targetFile: string, data: string | Uint8Array): Promise<void> {
  let tmp: string | null = null;
  try {
    await fs.mkdir(targetDir, { recursive: true });
    tmp = path.join(
      targetDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, targetFile);
    tmp = null;
  } catch {
    // 离线缓存是纯增益：写盘失败静默，绝不影响在线响应。
  } finally {
    if (tmp) fs.unlink(tmp).catch(() => {});
  }
}

async function writeWikiCache(page: string, payload: CachedWikiPayload): Promise<void> {
  const { dir, file } = wikiCachePath(page);
  const envelope: CachedWikiEnvelope = { fetchedAt: new Date().toISOString(), payload };
  await atomicWrite(dir, file, JSON.stringify(envelope));
}

/** 读持久正文缓存；不存在/损坏一律返回 null（调用方维持 502）。 */
async function readWikiCache(page: string): Promise<CachedWikiEnvelope | null> {
  try {
    const { file } = wikiCachePath(page);
    const raw = await fs.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "payload" in parsed) {
      return parsed as CachedWikiEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeAssetCache(safePath: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { dir, bin, meta } = assetCachePaths(safePath);
  const metaBody: CachedAssetMeta = { contentType, fetchedAt: new Date().toISOString() };
  await atomicWrite(dir, bin, bytes);
  await atomicWrite(dir, meta, JSON.stringify(metaBody));
}

/** 读持久图片缓存（bin + meta）；任一缺失/损坏返回 null。 */
async function readAssetCache(
  safePath: string,
): Promise<{ bytes: ArrayBuffer; meta: CachedAssetMeta } | null> {
  try {
    const { bin, meta: metaPath } = assetCachePaths(safePath);
    const [binBuf, metaRaw] = await Promise.all([
      fs.readFile(bin),
      fs.readFile(metaPath, "utf8"),
    ]);
    const meta: unknown = JSON.parse(metaRaw);
    if (!meta || typeof meta !== "object" || typeof (meta as CachedAssetMeta).contentType !== "string") {
      return null;
    }
    // 拷进独立 ArrayBuffer：fs 读出的 Buffer 类型是 Uint8Array<ArrayBufferLike>，不能直接
    // 作为 fetch Response 的 BodyInit（lib.dom 要 ArrayBuffer 支撑视图），故显式建 ArrayBuffer。
    const bytes = new ArrayBuffer(binBuf.byteLength);
    new Uint8Array(bytes).set(binBuf);
    return { bytes, meta: meta as CachedAssetMeta };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 路由

export const helpProxy = new Hono();

// GET /api/help/wiki?page=<标题>（缺省 Home）
helpProxy.get("/wiki", async (c) => {
  const rawPage = c.req.query("page");
  const page = rawPage && rawPage.trim() ? rawPage.trim() : HELP_HOME;
  // 纵深防御：附件不是页面，绝不把二进制当 markdown 拉回（否则前端把几十万字符乱码
  // 塞进 markdown 解析会卡顿）。正常页面列表已不含附件，这里再拦手工构造的 URL。
  if (page !== HELP_HOME && isWikiAttachment(page)) {
    return c.json({ ok: false, code: "NOT_A_WIKI_PAGE" }, 404);
  }
  const settings = resolveWikiSettings();

  const url = `${settings.wikiBase}/wiki/raw/${encodeURIComponent(page)}`;
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(url, { headers: { Accept: "text/plain" } });
  } catch {
    return respondWikiOffline(c, page);
  }
  if (!upstream.ok) {
    upstream.body?.cancel().catch(() => {});
    return respondWikiOffline(c, page);
  }

  const markdownRaw = await upstream.text();
  const markdown = rewriteWikiImageLinks(markdownRaw);
  const pages = await getPages(settings);
  const lastModified = upstream.headers.get("last-modified");

  const payload: CachedWikiPayload = {
    ok: true,
    page,
    home: HELP_HOME,
    markdown,
    imageBase: ASSET_ROUTE,
    pages,
    ...(lastModified ? { updatedAt: lastModified } : {}),
  };

  // 在线成功：best-effort 持久化（内部吞错，绝不拖垮/拖慢成用户可感错误）。
  await writeWikiCache(page, payload);

  c.header("Cache-Control", "public, max-age=60");
  // 鲜活响应刻意不带 cached/cachedAt（保持现契约逐字段断言）。
  return c.json(payload);
});

/**
 * 上游不可达时的离线出口：命中 dataDir 持久缓存则 200 返回陈旧正文并标 cached:true
 *（不进浏览器 60s 缓存，避免恢复联网后仍被旧内容挡住）；读不到才维持 502。
 */
async function respondWikiOffline(c: Context, page: string) {
  const cached = await readWikiCache(page);
  if (cached) {
    c.header("Cache-Control", "no-cache");
    return c.json({ ...cached.payload, cached: true, cachedAt: cached.fetchedAt });
  }
  return c.json({ ok: false, code: "WIKI_UNREACHABLE" }, 502);
}

// GET /api/help/asset?path=images/tour/02-grid.png
helpProxy.get("/asset", async (c) => {
  const safePath = validateAssetPath(c.req.query("path"));
  if (!safePath) {
    return c.json({ ok: false, code: "BAD_ASSET_PATH" }, 400);
  }

  const settings = resolveWikiSettings();
  const upstreamPath = safePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${settings.wikiBase}/wiki/raw/${upstreamPath}`;

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(url, { headers: { Accept: "image/*" } });
  } catch {
    return respondAssetOffline(c, safePath);
  }
  if (!upstream.ok || !upstream.body) {
    upstream.body?.cancel().catch(() => {});
    return respondAssetOffline(c, safePath);
  }

  // SVG 强制 image/svg+xml（上游偶尔给 text/html 或 text/xml，绝不能当 HTML 透）；
  // 其余类型优先信任上游 image/* content-type，缺失/异常时按扩展名兜底（白名单内必有映射）。
  const ext = path.extname(safePath).toLowerCase();
  let contentType: string;
  if (ext === ".svg") {
    contentType = ASSET_MIME[".svg"] as string;
  } else {
    const upstreamType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    contentType = upstreamType && upstreamType.startsWith("image/")
      ? upstreamType
      : (ASSET_MIME[ext] ?? "application/octet-stream");
  }

  // wiki 图片体积小：整包缓冲（同时用于持久缓存），Content-Length 与实际字节保持一致。
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  await writeAssetCache(safePath, bytes, contentType);

  return new Response(bytes, {
    status: upstream.status,
    headers: buildAssetHeaders(contentType, bytes.byteLength, false),
  });
});

/** 组装图片响应头：在线 miss 不带标记；离线命中带 X-GX-Help-Cache: hit。 */
function buildAssetHeaders(contentType: string, contentLength: number, fromCache: boolean): Headers {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  // 离线命中不给长缓存（避免恢复联网后浏览器仍卡旧图）；在线图维持 1h 不变。
  headers.set("Cache-Control", fromCache ? "no-cache" : "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(contentLength));
  if (fromCache) headers.set("X-GX-Help-Cache", "hit");
  return headers;
}

/** 上游不可达时读持久图片缓存：命中则 200 回相同字节/meta.contentType，否则维持 502。 */
async function respondAssetOffline(c: Context, safePath: string) {
  const cached = await readAssetCache(safePath);
  if (cached) {
    return new Response(cached.bytes, {
      status: 200,
      headers: buildAssetHeaders(cached.meta.contentType, cached.bytes.byteLength, true),
    });
  }
  return c.json({ ok: false, code: "WIKI_UNREACHABLE" }, 502);
}
