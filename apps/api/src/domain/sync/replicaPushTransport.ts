// beta.2 S3a：出站推送泵的【传输窄接口 + Node 全局 fetch 实现】（副作用边界）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §13（push 信封/回执）。
//
// 本分片刻意把「网络」与「纯适配 / 编排」分离：
//   - 本文件唯一副作用是发 HTTP；不读 env、不拼 URL/token（baseUrl/token 由调用方/未来壳注入），
//     故编排器在单测里可传一个只记录请求、回 canned 回执的假 transport，无需起第二个进程/HTTP server。
//   - 不在此文件做任何 DB 访问或状态迁移。
//
// 权威端契约（routes/v1/sync/index.ts）：
//   POST /api/v1/sync/push       body {baseId, clientId, protocolVersion, ops:[…]} → {result:{baseId,results}}
//   POST /api/v1/sync/push/tree  body {clientId, protocolVersion, ops:[…]}        → {result:{scope,results}}
//   两写端点都有 S0 协议门：顶层必须带 protocolVersion=SYNC_PROTOCOL_VERSION；令牌头用 X-GX-Token。

import { SYNC_PROTOCOL_VERSION } from "./protocol.js";

/** 出站线上 op（BigInt 版本一律序列化为非负整数串，与路由 /^\d+$/ 校验对齐）。 */
export interface WirePushOp {
  clientOpId: string;
  entityType: string;
  entityId: string;
  op: string;
  baseVersion: string;
  payload: Record<string, unknown>;
}

/** 权威端单条裁决回执（线上形状；seq/newVersion/serverVersion 均为字符串）。 */
export interface WirePushResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "quarantined" | "dropped";
  reasonCode?: string;
  reasonDetail?: string;
  seq?: string;
  newVersion?: string;
  entityId?: string;
  serverVersion?: string;
}

/** POST /push 的 result 信封。 */
export interface BasePushResponse {
  baseId: string;
  results: WirePushResult[];
}

/** POST /push/tree 的 result 信封。 */
export interface TreePushResponse {
  scope: "workspace_tree";
  results: WirePushResult[];
}

/**
 * 传输窄接口：编排器只认这两个方法。clientId 作为入参传入（权威端对 clientId 做非空校验，
 * 必须随每次请求携带；它属于「本轮排空」的身份而非传输实例配置，故不下沉到工厂闭包）。
 */
export interface ReplicaPushTransport {
  pushBase(baseId: string, ops: WirePushOp[], clientId: string): Promise<BasePushResponse>;
  pushTree(ops: WirePushOp[], clientId: string): Promise<TreePushResponse>;
}

/** 网络层 / 非 2xx 统一具名错误：编排器据此把本批行回 pending（可幂等重领），绝不丢行。 */
export class ReplicaTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ReplicaTransportError";
    if (status !== undefined) this.status = status;
  }
}

export interface FetchPushTransportOptions {
  /** 形如 http://127.0.0.1:<port>（调用方拼，尾斜杠会被归一）。 */
  baseUrl: string;
  /** X-GX-Token 令牌（由调用方/未来壳注入，本文件不读 env）。 */
  token: string;
}

/** 用 Node 全局 fetch 打到权威端；无新增 npm 依赖。HTTP 非 2xx 或网络故障 → ReplicaTransportError。 */
export function createFetchPushTransport(opts: FetchPushTransportOptions): ReplicaPushTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "X-GX-Token": opts.token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // DNS/连接拒绝/超时等：归一到具名错误，编排器回 pending，不向上抛裸 TypeError。
      throw new ReplicaTransportError(`推送网络错误: ${(e as Error)?.message ?? String(e)}`);
    }
    if (!res.ok) {
      throw new ReplicaTransportError(`推送被拒绝: HTTP ${res.status}`, res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ReplicaTransportError(`推送回执不是合法 JSON: ${(e as Error)?.message ?? String(e)}`, res.status);
    }
    const result = (json as { result?: T } | null)?.result;
    if (!result || typeof result !== "object") {
      throw new ReplicaTransportError("推送回执缺少 result 信封", res.status);
    }
    return result as T;
  }

  return {
    async pushBase(baseId, ops, clientId) {
      return post<BasePushResponse>("/api/v1/sync/push", {
        baseId, clientId, protocolVersion: SYNC_PROTOCOL_VERSION, ops,
      });
    },
    async pushTree(ops, clientId) {
      return post<TreePushResponse>("/api/v1/sync/push/tree", {
        clientId, protocolVersion: SYNC_PROTOCOL_VERSION, ops,
      });
    },
  };
}
