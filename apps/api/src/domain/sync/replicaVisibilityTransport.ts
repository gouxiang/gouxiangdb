// beta.2 S3-runtime：失权可见集（visibility）下行的【传输窄接口 fetch 实现】（副作用边界）。
// 与 replicaPullTransport / replicaPushTransport 同一条分层纪律：
//   - 本文件唯一副作用是发 HTTP；不读 env、不拼 token（baseUrl/token 由 runtime/壳注入），
//     故单测可传假 transport，无需起第二个进程/HTTP server；不做任何 DB 访问。
//   - 复用（绝不重定义）出站侧 ReplicaTransportError：网络/非 2xx/坏 JSON/缺信封统一具名错误。
//
// 权威端契约（routes/v1/sync/index.ts，读通道、不挂 S0 协议门）：
//   GET /api/v1/sync/visibility?baseId=<id>  → { result: VisibilityReport }
//   令牌头 X-GX-Token。
//
// 关于「错误返回 null 不炸」的实现裁决：
//   reconcileVisibilityOnce 的窄接口契约（replicaReconcile.ts:45）要求 fetchVisibility 在非 2xx
//   （含 403）/网络故障时【抛 ReplicaTransportError】——编排器靠 e.status===403 收 deniedBaseIds、
//   靠其他状态置 transportError 提前收口。若工厂在错误时返回 null，会绕过这套分流（403 无法被
//   识别为失权、null 还会流入事务体解引用）。故本工厂严格遵循既有窄接口：抛错而非返回 null。
//   「不炸进程」的语义由更上层 replicaSyncRuntime 的 runOnce 外层 try/catch 保证：传输错被记为
//   lastError、下轮重试，绝不冒泡使进程退出。

import { ReplicaTransportError } from "./replicaPushTransport.js";
import type { VisibilityReport } from "./visibility.js";

/** 再导出，便于 runtime/测试从单一传输模块取错误类。 */
export { ReplicaTransportError };
export type { ReplicaVisibilityTransport } from "./replicaReconcile.js";

export interface FetchVisibilityTransportOptions {
  /** 形如 http://127.0.0.1:<port>（尾斜杠会被归一）。 */
  baseUrl: string;
  /** X-GX-Token 令牌（由调用方/壳注入，本文件不读 env）。 */
  token: string;
}

/** 用 Node 全局 fetch 打权威端 visibility；无新增 npm 依赖。 */
export function createFetchVisibilityTransport(
  opts: FetchVisibilityTransportOptions,
): import("./replicaReconcile.js").ReplicaVisibilityTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");

  return {
    async fetchVisibility(baseId: string): Promise<VisibilityReport> {
      const qs = new URLSearchParams({ baseId });
      let res: Response;
      try {
        res = await fetch(`${base}/api/v1/sync/visibility?${qs.toString()}`, {
          method: "GET",
          headers: { "X-GX-Token": opts.token, "content-type": "application/json" },
        });
      } catch (e) {
        // 网络层故障（DNS 拒绝、连接重置、超时等）：不带 status，编排器按普通传输错收口。
        throw new ReplicaTransportError(`visibility 网络错误: ${(e as Error)?.message ?? String(e)}`);
      }
      if (!res.ok) {
        // 保留 status：编排器据 403 收 deniedBaseIds（整节点失权嫌疑，不擦不抛）。
        throw new ReplicaTransportError(`visibility 被拒绝: HTTP ${res.status}`, res.status);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw new ReplicaTransportError(
          `visibility 回执不是合法 JSON: ${(e as Error)?.message ?? String(e)}`,
          res.status,
        );
      }
      const result = (json as { result?: VisibilityReport } | null)?.result;
      if (!result || typeof result !== "object") {
        throw new ReplicaTransportError("visibility 回执缺少 result 信封", res.status);
      }
      return result;
    },
  };
}
