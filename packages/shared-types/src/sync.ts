// packages/shared-types/src/sync.ts
// 离线同步协议握手契约（前后端共用唯一真源，beta.2 S0）。
//
// 服务端实现：
//   - 协议常量/裁决纯函数：apps/api/src/domain/sync/protocol.ts
//   - 探针与写端点门：apps/api/src/routes/v1/sync/index.ts
//
// 立场：协议门只作用于写端点（/push、/push/tree），读端点（探针/snapshot/pull…）不做版本门；
// 不带 protocolVersion 的旧客户端按 v1 受理（additive，默认零行为变化）。

/** 同步协议版本协商宣告（GET /api/v1/sync 探针）。旧键全部保留，新增四键 additive。 */
export interface SyncProtocolProbe {
  apiVersion: "v1";
  sync: true;
  /** 服务端当前同步阶段标识（随 YN 推进刷新）。 */
  phase: string;
  /** 服务端应用版本（语义化版本字符串）。 */
  serverVersion: string;
  /** 本节点当前协议版本（破坏性语义变更才 +1）。 */
  protocolVersion: number;
  /** 仍可受理的最低客户端协议版本。 */
  minProtocolVersion: number;
  /** 已知的最高协议版本（超过即说明服务端落后）。 */
  maxProtocolVersion: number;
  /** 当前协议版本下具备的同步能力标识。 */
  capabilities: readonly string[];
  auth: {
    userId: string;
    workspaceId: string | null;
  };
}

/** 写端点协议门拒绝时的机器码（HTTP 400 信封 code）。 */
export type SyncProtocolErrorCode =
  | "SYNC_PROTOCOL_TOO_OLD"
  | "SYNC_PROTOCOL_TOO_NEW"
  | "SYNC_PROTOCOL_BAD_REQUEST";
