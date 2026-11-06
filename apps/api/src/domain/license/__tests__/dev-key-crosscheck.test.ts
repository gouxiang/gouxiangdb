/**
 * 可选跨端核对（CI/无授权中心私钥时自动 skip）：
 * 用授权中心开发私钥（env LICENSE_DEV_PRIVATE_KEY_PEM 指向的 PEM 文件）真签一个信封，
 * 验证客户端内置开发公钥（kid da469cd3）能真验通过——证明内置 PEM 与授权中心私钥真实配对，
 * 而非仅仅是一把合法但不配套的 Ed25519 公钥。
 *
 * 私钥绝不拷进本仓；本用例只在开发者本机显式提供路径时运行。
 */
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyAndParseWithRing } from "../verify.js";
import type { ParsedEnvelope } from "../verify.js";

const keyPath = process.env.LICENSE_DEV_PRIVATE_KEY_PEM;

describe.skipIf(!keyPath || !existsSync(keyPath))("内置开发公钥 × 授权中心开发私钥 跨端核对", () => {
  it("开发私钥真签信封，内置公钥环真验通过且 kid=da469cd3", () => {
    const pem = readFileSync(keyPath as string, "utf-8");
    const priv = createPrivateKey(pem);
    const env: ParsedEnvelope = {
      v: 1,
      serverTime: 1800000000,
      intervalSec: 21600,
      entitlement: {
        product: "gouxiangdb",
        edition: "business",
        licenseId: "xcheck",
        licensedTo: "跨端核对",
        seats: 10,
        issuedAt: 1799999000,
        expiresAt: 1900000000,
        fingerprint: "c".repeat(64),
        nonce: "n",
        features: {},
        version: 1,
        kid: "da469cd3",
        offline: false,
      },
    };
    const payload = Buffer.from(JSON.stringify(env), "utf-8");
    const wire = {
      envelopeB64: payload.toString("base64"),
      signature: sign(null, payload, priv).toString("base64"),
      kid: "da469cd3",
    };
    const parsed = verifyAndParseWithRing(wire);
    expect(parsed.entitlement?.licenseId).toBe("xcheck");
  });
});
