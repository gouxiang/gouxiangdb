// apps/api/src/domain/sync/protocol.ts
// S0 同步协议握手 / 脑裂防护 —— 协议版本协商的【唯一真源】（纯常量 + 纯函数）。
//
// 设计立场（beta.2 S0，默认关闭 + additive）：
//   - 本模块零副作用、不碰 DB、不 import Hono，可被路由层与未来的侧车/客户端类型共用。
//   - 协议门【只作用于写端点】（POST /push、POST /push/tree）：在解析出 body 之后、
//     遍历 ops 与【任何 DB 访问之前】fail-closed 裁决；被拒时绝不写 incoming/oplog。
//   - 读端点（GET / 探针、snapshot、pull、pull/tree、incoming、visibility 等）【不做此门】：
//     老客户端必须永远能读取数据（哪怕其版本过旧无法写入），否则升级期会把用户锁死在
//     "既不能读、也无从得知服务端版本"的脑裂状态。协议协商信息由 GET / 探针只读暴露。
//   - additive 铁律：不带 protocolVersion（undefined/null/空串）的旧客户端一律按 v1 放行，
//     缺省行为逐字节不变；只有显式声明且越界/非法时才拒。
//
// 与总门 GX_SYNC_SERVER 的顺序：总门中间件（off→404）→ 鉴权 → 端点内本协议门。
// 协议门【不】进组首中间件，避免污染读端点与 off→404 的短路顺序。

/** 本节点当前对外提供的同步协议版本（破坏性语义变更才 +1）。 */
export const SYNC_PROTOCOL_VERSION = 1;

/** 本节点仍可受理的最低客户端协议版本（低于此值 → TOO_OLD，要求客户端升级）。 */
export const SYNC_PROTOCOL_MIN_VERSION = 1;

/** 本节点已知的最高协议版本（高于此值 → TOO_NEW，说明服务端落后、需升级服务端）。 */
export const SYNC_PROTOCOL_MAX_VERSION = 1;

/**
 * 本节点在当前协议版本下具备的同步能力标识（探针只读宣告，供客户端做能力协商）。
 * 字符串数组即可：新增能力往尾部追加，不靠顺序表达兼容性。
 */
export const SYNC_CAPABILITIES = [
  "record-sync",
  "structure-sync",
  "tree-sync",
  "conflict-resolve",
  "base-schema-version-gate",
] as const;

/** 写端点协议门裁决结果。ok:false 时 code 即 HTTP 错误信封里应回的机器码。 */
export type SyncProtocolGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "SYNC_PROTOCOL_TOO_OLD"
        | "SYNC_PROTOCOL_TOO_NEW"
        | "SYNC_PROTOCOL_BAD_REQUEST";
      message: string;
    };

/**
 * 裁决写请求携带的 protocolVersion。
 *
 * 入参形状：
 *   - undefined / null / ""（含纯空白串）→ 视为旧客户端的缺省版本 1，放行（additive）。
 *   - number（安全非负整数）或纯数字字符串（/^\d+$/）→ parseInt 后按区间裁决。
 *   - 布尔、对象、数组、浮点、负号、非数字串等非法形状 → SYNC_PROTOCOL_BAD_REQUEST。
 *
 * 区间：
 *   - v < MIN → SYNC_PROTOCOL_TOO_OLD（客户端升级）。
 *   - v > MAX → SYNC_PROTOCOL_TOO_NEW（服务端升级）。
 *   - MIN <= v <= MAX → ok。
 */
export function gateClientProtocol(raw: unknown): SyncProtocolGateResult {
  // 旧客户端不带字段：按 v1 受理，零行为变化（additive）。
  if (raw === undefined || raw === null) return { ok: true };

  let v: number;
  if (typeof raw === "number") {
    // 拒绝 NaN/Infinity/负数/浮点/非安全整数；布尔值 typeof 也是 "number"? 否——boolean 单独一类，
    // 但仍显式用 Number.isInteger + isSafeInteger 把形状钉死，避免 1.5 / 1e3 之类混入。
    if (!Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
      return {
        ok: false,
        code: "SYNC_PROTOCOL_BAD_REQUEST",
        message: "protocolVersion 必须是非负整数或纯数字字符串",
      };
    }
    v = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true }; // 空串等同缺省（旧客户端）。
    if (!/^\d+$/.test(trimmed)) {
      return {
        ok: false,
        code: "SYNC_PROTOCOL_BAD_REQUEST",
        message: "protocolVersion 必须是非负整数或纯数字字符串",
      };
    }
    v = Number.parseInt(trimmed, 10);
  } else {
    // 布尔 / 对象 / 数组 / symbol / bigint 等一律非法形状。
    return {
      ok: false,
      code: "SYNC_PROTOCOL_BAD_REQUEST",
      message: "protocolVersion 必须是非负整数或纯数字字符串",
    };
  }

  if (v < SYNC_PROTOCOL_MIN_VERSION) {
    return {
      ok: false,
      code: "SYNC_PROTOCOL_TOO_OLD",
      message: "客户端版本过旧，请升级后再同步",
    };
  }
  if (v > SYNC_PROTOCOL_MAX_VERSION) {
    return {
      ok: false,
      code: "SYNC_PROTOCOL_TOO_NEW",
      message: "服务端版本过旧，请联系管理员升级服务端",
    };
  }
  return { ok: true };
}
