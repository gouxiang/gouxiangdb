/**
 * 信封验签 + 接收规则（移植自授权中心 simulator/verify.ts，行为逐字节对齐）。
 * 只依赖 node:crypto 与内置公钥环（keys.ts）。
 *
 * 关键：验签对象是 envelopeB64 解码后的原始字节，不是重新序列化的 JSON，
 * 因此跨语言/跨实现不存在 JSON 规范化分歧。
 *
 * 信任边界铁律：只信「内置公钥验签通过的信封字节」；信封外一切明文不可信；
 * 任何失败都由调用方 fail-safe 回落免费 5 人档，绝不出现无限版。
 */
import { verify, type KeyObject } from "node:crypto";
import { findKeyByKid, type LicensedKey } from "./keys.js";

export interface WireEnvelope {
  envelopeB64: string;
  signature: string;
  kid: string;
}

export interface Entitlement {
  product: string;
  edition: string;
  licenseId: string;
  licensedTo: string;
  seats: number;
  issuedAt: number;
  expiresAt: number;
  fingerprint: string;
  nonce: string;
  features: Record<string, unknown>;
  version: number;
  kid: string;
  offline: boolean;
  revoked?: boolean;
}

export interface ParsedEnvelope {
  v: number;
  serverTime: number;
  intervalSec: number;
  nextBaseUrl?: string | null;
  entitlement: Entitlement | null;
  feedback?: { unread: number; open: number } | null;
}

export type RejectCode =
  | "BAD_SIGNATURE"
  | "KID_MISMATCH"
  | "BAD_PAYLOAD"
  | "FINGERPRINT_MISMATCH"
  | "VERSION_ROLLBACK";

export class RejectError extends Error {
  constructor(
    public code: RejectCode,
  ) {
    super(code);
    this.name = "LicenseRejectError";
  }
}

/**
 * 验签并解析（与 simulator 完全一致）：
 * 1) expectedKid 给定时先比 kid；
 * 2) 对 base64 解码后的原始字节做 raw Ed25519（algorithm 必须为 null）；
 * 3) 验签通过才 JSON.parse。
 */
export function verifyAndParse(
  wire: WireEnvelope,
  key: KeyObject,
  expectedKid?: string,
): ParsedEnvelope {
  if (expectedKid && wire.kid !== expectedKid) throw new RejectError("KID_MISMATCH");
  const payload = Buffer.from(wire.envelopeB64, "base64");
  const ok = verify(null, payload, key, Buffer.from(wire.signature, "base64"));
  if (!ok) throw new RejectError("BAD_SIGNATURE");
  try {
    return JSON.parse(payload.toString("utf-8")) as ParsedEnvelope;
  } catch {
    throw new RejectError("BAD_PAYLOAD");
  }
}

/**
 * 用内置公钥环验签：按响应里的 kid 选钥（kid 仅作索引）；无此公钥 → KID_MISMATCH。
 * 信封里的 kid 与所选公钥 kid 天然一致（findKeyByKid 按 wire.kid 取）。
 */
export function verifyAndParseWithRing(wire: WireEnvelope): ParsedEnvelope {
  const licensed: LicensedKey | null = findKeyByKid(wire.kid);
  if (!licensed) throw new RejectError("KID_MISMATCH");
  return verifyAndParse(wire, licensed.keyObject, licensed.kid);
}

/** 单据结构/产品校验（接收链第 3 步）：null 合法（免费实例）；非 null 必须形状完整且 product 正确。 */
export function validateEntitlementShape(e: Entitlement | null | undefined): void {
  if (e === null || e === undefined) return;
  const isObj = typeof e === "object" && e !== null;
  const str = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const ok =
    isObj &&
    e.product === "gouxiangdb" &&
    str(e.edition) &&
    str(e.licenseId) &&
    str(e.licensedTo) &&
    num(e.seats) &&
    (e.seats as number) > 0 &&
    Number.isInteger(e.seats) &&
    num(e.issuedAt) &&
    num(e.expiresAt) &&
    str(e.fingerprint) &&
    str(e.nonce) &&
    typeof e.features === "object" &&
    e.features !== null &&
    num(e.version) &&
    Number.isInteger(e.version) &&
    (e.version as number) >= 0 &&
    str(e.kid) &&
    typeof e.offline === "boolean";
  if (!ok) throw new RejectError("BAD_PAYLOAD");
  // revoked 若出现必须是布尔（缺省 false）。
  if (e.revoked !== undefined && typeof e.revoked !== "boolean") {
    throw new RejectError("BAD_PAYLOAD");
  }
}

/**
 * 客户端接收链（fail-safe：任何拒绝都回落免费 5 人档，绝不无限版）。
 * 返回拒绝原因或 null（接受）。接受时由调用方落缓存。
 *  - entitlement 为 null：免费实例无单据，正常通过；
 *  - 指纹不符：FINGERPRINT_MISMATCH；
 *  - 版本回滚：VERSION_ROLLBACK。
 */
export function acceptEntitlement(
  envelope: ParsedEnvelope,
  localFingerprint: string,
  cachedVersion: number | null,
): RejectError | null {
  const e = envelope.entitlement;
  if (!e) return null;
  if (e.fingerprint !== localFingerprint) return new RejectError("FINGERPRINT_MISMATCH");
  if (cachedVersion !== null && e.version < cachedVersion) return new RejectError("VERSION_ROLLBACK");
  return null;
}
