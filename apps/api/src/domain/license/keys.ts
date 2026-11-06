/**
 * 内置授权公钥环（仅公钥，无私钥）。
 *
 * - kid = 公钥 SPKI DER 的 sha256 前 8 hex；启动时从 PEM 自派生并与声明值比对，
 *   不一致直接抛错（内置表写错＝构建事故，宁可启动失败也不拿错钥匙验签）。
 * - kid 只作公钥「索引」，绝不作为身份依据；身份完全由 Ed25519 字节验签确立。
 * - 以 [{kid,pem}] 数组内置，预留密钥轮换：授权中心换钥后在新信封用新 kid，
 *   环里两把公钥并存即可平滑过渡。
 *
 * 信任根构建期物理换源（不靠运行时分支/DCE）：
 * - 非授权构建（vitest/tsx/0.2.7 等，默认）：本文件 import 的 ./keyring.dev.js 正常解析到
 *   keyring.dev.ts，环＝开发公钥 da469cd3；授权默认 off，行为逐字节不变。
 * - 生产授权构建（GX_LICENSE_PROD=1，apps/api/scripts/build.mjs）：esbuild onResolve 把
 *   ./keyring.dev.js 重定向到 keyring.prod.ts，于是 keyring.dev.ts（含开发 PEM）根本不进入
 *   模块图，生产产物物理不含任何开发钥——开发私钥一旦泄露也无法成为生产旁路。
 */
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { RING_DECLARED, LICENSE_KEYRING_PROD } from "./keyring.dev.js";

/** 是否生产授权构建（与信任根同一换源决定，避免环与下限不一致）。 */
export const IS_LICENSE_PROD_BUILD: boolean = LICENSE_KEYRING_PROD;

export interface LicensedKey {
  kid: string;
  pem: string;
  keyObject: KeyObject;
}

/** 由 PEM 自派生 kid（SPKI DER 的 sha256 前 8 hex）。 */
export function deriveKid(pem: string): string {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 8);
}

/** 构建公钥环并对每条做派生 kid 自检（环来自构建期换源模块）。 */
export function buildKeyRing(): LicensedKey[] {
  return RING_DECLARED.map((entry) => {
    const derived = deriveKid(entry.pem);
    if (derived !== entry.kid) {
      throw new Error(
        `license key ring mismatch: declared kid ${entry.kid} != derived ${derived}`,
      );
    }
    return { kid: entry.kid, pem: entry.pem, keyObject: createPublicKey(entry.pem) };
  });
}

let cachedRing: LicensedKey[] | null = null;

function ring(): LicensedKey[] {
  if (!cachedRing) cachedRing = buildKeyRing();
  return cachedRing;
}

/** 按 kid 取内置公钥；无对应公钥返回 null（调用方按 KID_MISMATCH 拒绝）。 */
export function findKeyByKid(kid: string | undefined | null): LicensedKey | null {
  if (!kid) return null;
  return ring().find((k) => k.kid === kid) ?? null;
}

/** 测试/诊断用：当前内置公钥 kid 列表（顺序即内置顺序）。 */
export function builtinKids(): string[] {
  return ring().map((k) => k.kid);
}
