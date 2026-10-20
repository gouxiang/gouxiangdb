// beta.2 S3b-3b：下行同步泵的【传输窄接口 + Node 全局 fetch 实现】（副作用边界）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §6（subscribe/bootstrap/pull）、
// §8.3（seq keyset，不信客户端时钟）、§13（统一 result 信封）。
//
// 与 replicaPushTransport 同一条分层纪律：
//   - 本文件唯一副作用是发 HTTP；不读 env、不拼 URL/token（baseUrl/token 由调用方/未来壳注入），
//     故编排器在单测里可传一个只记录请求、回 canned 页的假 transport，无需起第二个进程/HTTP server。
//   - 不在此文件做任何 DB 访问、游标推进或 op 回放。
//   - 复用（再导出，绝不重定义）出站侧的 ReplicaTransportError：网络/非 2xx/坏 JSON/缺信封统一具名错误，
//     编排器据此「停后续、不回滚已提交游标」，与 push 泵同一 catch 口径。
//
// 权威端契约（routes/v1/sync/index.ts，均为读通道；读端点【不挂】S0 协议门）：
//   POST /subscribe  body {clientId, scopeType:"base"|"workspace_tree", scopeId} → {result:SubscribeResult}
//   GET  /bootstrap?baseId=&clientId=&limit=                                     → {result:ReplicaBootstrapPage}
//   GET  /pull?baseId=&after=<seq>&clientId=&limit=                              → {result:PullPage}
//   GET  /pull/tree?after=<seq>&clientId=&limit=                                 → {result:TreePullPage}
// 令牌头一律 X-GX-Token；seq/bigint 一律 toString 后走 query（路由只认 /^\d+$/）。

import { ReplicaTransportError } from "./replicaPushTransport.js";
import type { SubscribeResult, TreeSubscribeResult } from "./snapshot.js";
import type { ReplicaBootstrapPage } from "./bootstrap.js";
import type { PullPage, TreePullPage } from "./pull.js";

export { ReplicaTransportError };

/**
 * 下行传输窄接口：编排器只认这五个方法。clientId 作为入参传入（与 push 同口径——它是「本轮拉取」
 * 的身份而非传输实例配置；服务端用它推进 sync_subscription 记账游标）。
 * 返回值均为已剥掉 result 信封的领域对象（信封剥离与错误归一在 fetch 实现内完成）。
 */
export interface ReplicaPullTransport {
  subscribeBase(baseId: string, clientId: string): Promise<SubscribeResult>;
  subscribeTree(clientId: string): Promise<TreeSubscribeResult>;
  fetchBootstrap(baseId: string, clientId: string, limit?: number): Promise<ReplicaBootstrapPage>;
  pullBase(baseId: string, after: bigint, clientId: string, limit: number): Promise<PullPage>;
  pullTree(after: bigint, clientId: string, limit: number): Promise<TreePullPage>;
}

export interface FetchPullTransportOptions {
  /** 形如 http://127.0.0.1:<port>（调用方拼，尾斜杠会被归一）。 */
  baseUrl: string;
  /** X-GX-Token 令牌（由调用方/未来壳注入，本文件不读 env）。 */
  token: string;
}

/** 用 Node 全局 fetch 打到权威端；无新增 npm 依赖。HTTP 非 2xx 或网络故障 → ReplicaTransportError。 */
export function createFetchPullTransport(opts: FetchPullTransportOptions): ReplicaPullTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");

  // 四段 catch（与 replicaPushTransport.post 逐字同构）：网络错 / 非 2xx / 坏 JSON / 缺 result 信封。
  async function get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: "GET",
        headers: { "X-GX-Token": opts.token, "content-type": "application/json" },
      });
    } catch (e) {
      throw new ReplicaTransportError(`拉取网络错误: ${(e as Error)?.message ?? String(e)}`);
    }
    if (!res.ok) {
      throw new ReplicaTransportError(`拉取被拒绝: HTTP ${res.status}`, res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ReplicaTransportError(`拉取回执不是合法 JSON: ${(e as Error)?.message ?? String(e)}`, res.status);
    }
    const result = (json as { result?: T } | null)?.result;
    if (!result || typeof result !== "object") {
      throw new ReplicaTransportError("拉取回执缺少 result 信封", res.status);
    }
    return result as T;
  }

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "X-GX-Token": opts.token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ReplicaTransportError(`订阅网络错误: ${(e as Error)?.message ?? String(e)}`);
    }
    if (!res.ok) {
      throw new ReplicaTransportError(`订阅被拒绝: HTTP ${res.status}`, res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ReplicaTransportError(`订阅回执不是合法 JSON: ${(e as Error)?.message ?? String(e)}`, res.status);
    }
    const result = (json as { result?: T } | null)?.result;
    if (!result || typeof result !== "object") {
      throw new ReplicaTransportError("订阅回执缺少 result 信封", res.status);
    }
    return result as T;
  }

  const qs = (params: Record<string, string | number>): string => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
    return `?${usp.toString()}`;
  };

  return {
    async subscribeBase(baseId, clientId) {
      return post<SubscribeResult>("/api/v1/sync/subscribe", {
        clientId, scopeType: "base", scopeId: baseId,
      });
    },
    async subscribeTree(clientId) {
      return post<TreeSubscribeResult>("/api/v1/sync/subscribe", {
        clientId, scopeType: "workspace_tree", scopeId: "ws_default",
      });
    },
    async fetchBootstrap(baseId, clientId, limit) {
      const params: Record<string, string | number> = { baseId, clientId };
      if (limit !== undefined) params.limit = limit;
      return get<ReplicaBootstrapPage>(`/api/v1/sync/bootstrap${qs(params)}`);
    },
    async pullBase(baseId, after, clientId, limit) {
      return get<PullPage>(`/api/v1/sync/pull${qs({ baseId, after: after.toString(), clientId, limit })}`);
    },
    async pullTree(after, clientId, limit) {
      return get<TreePullPage>(`/api/v1/sync/pull/tree${qs({ after: after.toString(), clientId, limit })}`);
    },
  };
}
