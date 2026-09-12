// apps/api/src/utils/client-ip.ts
// 来源 IP 解析（限流与审计共用，保证口径一致）。
// 仅当 TCP 对端为回环（Caddy/vite 同机反代）时才采纳 X-Forwarded-For 首段；
// 非回环直连时忽略伪造 XFF，回落 socket 对端地址。无外部依赖、无副作用。

import type { Context } from "hono";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// @hono/node-server 把 Node 请求对象放在 c.env.incoming。
export function remoteAddress(c: Context): string | undefined {
  const bindings = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  return bindings?.incoming?.socket?.remoteAddress;
}

export function sourceIp(c: Context): string {
  const remote = remoteAddress(c);
  if (remote && LOOPBACK.has(remote)) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first && /^[0-9a-fA-F:.]{3,45}$/.test(first)) return first;
    }
  }
  return remote || "unknown";
}
