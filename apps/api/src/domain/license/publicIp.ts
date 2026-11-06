/**
 * 公网出口 IPv4 探测：GET 授权中心 {baseUrl}/v1/my-ip，服务端回显出口 IP。
 *
 * 设计铁律（P0 客户端上报，绝不拖累主链路）：
 *  - 短超时 3000ms（AbortSignal.timeout，Node22 内置 fetch，零新增依赖）；
 *  - 仅接受 HTTP 200 且 body 为 {"ip":"1.2.3.4"}（容忍额外字段，只读 ip）；
 *  - 网络错 / 超时 / 非 200 / 形状错 / 非法 IPv4 —— 一律返回 null，绝不抛错、不重试、不刷屏。
 *
 * 不复用 http.ts 的 HttpTransport：该抽象只暴露 post/postForm/getRaw，且超时在构造期固定
 * （默认 10s），无法满足本探测单次 3000ms 的硬约束，故直接用内置 fetch。fetchImpl 可注入便于纯单测。
 */
import { isValidIpv4 } from "./deviceIdentity.js";

export const PUBLIC_IP_TIMEOUT_MS = 3000;

export interface ResolvePublicIpOptions {
  timeoutMs?: number;
  /** 测试注入 fetch；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * 向单个授权地址探测公网出口 IP。任何失败均安全回落 null，永不 reject。
 */
export async function resolvePublicIp(
  baseUrl: string,
  opts: ResolvePublicIpOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? PUBLIC_IP_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(joinUrl(baseUrl, "/v1/my-ip"), {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const data = (await res.json()) as unknown;
    const ip = (data as { ip?: unknown } | null)?.ip;
    if (typeof ip !== "string") return null;
    const trimmed = ip.trim();
    return isValidIpv4(trimmed) ? trimmed : null;
  } catch {
    // 网络错/超时/JSON 解析错：静默降级为未知，不影响心跳/激活。
    return null;
  }
}
