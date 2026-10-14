// apps/web/src/node/resolve.ts
// 节点模式 S1（DESIGN §7.1）：节点网址规范化纯函数。
//
// 本模块是**纯字符串/URL 运算**：不碰 DOM（除生产哈希用 SubtleCrypto 外）、不引新依赖、
// 不读全局状态，保证可在纯 node 环境直接单测。
//
// 术语（与 DESIGN §6.1 对齐）：
//   origin   = 协议 + host(含端口)，如 "http://192.168.1.5:3001"
//   basePath = 反代/网关子路径前缀，无尾斜杠，根部署为 ""，如 "/app/gouxiangdb"
//   baseURL  = origin + basePath（无尾斜杠），远端节点的绝对 API 根
// 本地同源槽（baseURL 为 "" 或 "/app/gouxiangdb" 这种相对前缀）**不**走本模块的远端规范化，
// 它由 lib/base.ts 的 resolveApiBase 计算；本模块只服务「用户手输的远端节点网址」。

/** 本地数据源的固定 nodeId（DESIGN §6.1：本地模式 nodeId 恒为 "local"）。 */
export const LOCAL_NODE_ID = "local";

/** 规范化结果：origin 与 basePath 拆开存，便于同源判定与 WS 换算。 */
export interface NormalizedNodeUrl {
  /** 协议 + host(含端口)，host 已小写；如 "http://host:3001"。 */
  origin: string;
  /** 子路径前缀，无尾斜杠；根部署为 ""。如 "/app/gouxiangdb"。 */
  basePath: string;
  /** origin + basePath（无尾斜杠），即远端 API 根。 */
  baseURL: string;
}

/** 已带 http(s) 协议前缀。 */
const ABSOLUTE_HTTP = /^https?:\/\//i;

/**
 * 规范化用户输入的远端节点网址。
 *
 * 规则（DESIGN §7.1）：
 *   - trim 两端空白；
 *   - 无协议时默认补 `http://`（允许 "host:3001" 这类裸输入）；
 *   - host 小写（URL 权威部分大小写不敏感）；**子路径保留原大小写**（路径可能大小写敏感）；
 *   - 去掉 basePath 尾斜杠（可多个）；
 *   - 保留端口；
 *   - 拒绝明显非法的 host（空 / 含空格 / 无有效 host）→ 返回 null。
 *
 * @returns 规范化结果；输入非法时返回 null（fail-closed，调用方据此阻止登录）。
 */
export function normalizeNodeUrl(input: string): NormalizedNodeUrl | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // 含空白的 host 一定非法（路径里也不允许裸空格）。
  if (/\s/.test(trimmed)) return null;

  const withScheme = ABSOLUTE_HTTP.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  // 只接受 http/https（补协议后必为其一，但显式守卫，拒绝 file://、javascript: 等）。
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.host; // 含端口；hostname 已由 URL 小写化
  const hostname = url.hostname;
  if (!host || !hostname) return null;
  // host 标签必须含字母或数字（拒绝 "."、"-"、纯标点、IP 之外的怪形态）。
  if (!/[a-z0-9]/i.test(hostname)) return null;

  const scheme = url.protocol === "https:" ? "https" : "http";
  const origin = `${scheme}://${host}`;

  // pathname 保留原大小写；去掉所有尾斜杠。根路径 "/" 归一为 ""。
  const basePath = url.pathname.replace(/\/+$/, "");
  // 防御：规范化后不允许出现 "//"（畸形路径段）。
  if (basePath.includes("//")) return null;

  return {
    origin,
    basePath,
    baseURL: `${origin}${basePath}`,
  };
}

/** 可注入的字符串哈希：输入已规范化的字符串，返回 hex 摘要（生产用 SHA-256，测试用确定性假哈希）。 */
export type StringHasher = (input: string) => Promise<string>;

/**
 * 生产哈希：SubtleCrypto SHA-256（浏览器/Node 22 均内置，无新依赖）。
 * 返回完整 64 位小写 hex；截断到前 12 位由 nodeIdFromBaseURLWith 统一负责。
 */
export const subtleSha256: StringHasher = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * 由规范化 baseURL 派生稳定 nodeId 的**纯版本**（哈希可注入）。
 *
 * 核心「取摘要前 12 位 hex」的逻辑在此，与哈希算法解耦——node 单测可传入确定性假哈希，
 * 不依赖 webcrypto。DESIGN §7.1：nodeId = sha256(origin + basePath) 前 12 位。
 *
 * @param baseURL 已规范化的远端 baseURL（origin+basePath）
 * @param hasher  哈希实现（默认生产 SubtleCrypto；测试注入假哈希）
 */
export async function nodeIdFromBaseURLWith(
  baseURL: string,
  hasher: StringHasher = subtleSha256,
): Promise<string> {
  const hex = await hasher(baseURL);
  return hex.slice(0, 12);
}

/** 生产便捷封装：以 SubtleCrypto SHA-256 取前 12 hex 作为远端节点 id。 */
export function nodeIdFromBaseURL(baseURL: string): Promise<string> {
  return nodeIdFromBaseURLWith(baseURL, subtleSha256);
}

/**
 * 判定两个原始输入是否指向同一节点：各自规范化后比较 origin + basePath。
 * 任一输入非法 → false（fail-closed）。
 */
export function matchSameNode(a: string, b: string): boolean {
  const na = normalizeNodeUrl(a);
  const nb = normalizeNodeUrl(b);
  if (!na || !nb) return false;
  return na.origin === nb.origin && na.basePath === nb.basePath;
}

/**
 * http(s) 绝对 baseURL → ws(s) 协议换算（DESIGN §9.2）。
 * 与 collab 现有 `toWsOrigin`（features/collab/collab-provider.ts:88-93）同一口径：
 *   https:// → wss://，http:// → ws://；host/端口/子路径原样保留。
 * 已是 ws/wss 或非标准形态则原样透传。
 */
export function toWsOrigin(baseURL: string): string {
  if (baseURL.startsWith("https://")) return `wss://${baseURL.slice("https://".length)}`;
  if (baseURL.startsWith("http://")) return `ws://${baseURL.slice("http://".length)}`;
  return baseURL;
}

/**
 * 本地同源槽的 WS origin 计算（纯函数，origin 可注入以便 node 单测）。
 *
 * 本地槽 baseURL 是**相对**部署前缀（"" 或 "/app/gouxiangdb"，无协议可换），
 * 故先把页面同源 origin 做 http→ws 换算，再拼上 basePath —— 与 collab 现网行为一致：
 * collab 用 `toWsOrigin(window.location.origin)` 作为 origin，服务端给的 wsPath 已含网关前缀。
 *
 * @param localBase 本地相对 base（resolveApiBase 的结果，"" 或 "/app/..."）
 * @param origin    页面同源 origin（生产传 window.location.origin；node 测试注入）
 */
export function localWsOrigin(localBase: string, origin: string): string {
  return `${toWsOrigin(origin)}${localBase}`;
}
