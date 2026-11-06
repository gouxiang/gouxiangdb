/**
 * 接收链安全对抗（fail-safe，绝不无限版）：
 *  - 篡改信封字节（保留旧签名）→ BAD_SIGNATURE
 *  - kid 未知 / kid 伪装 → KID_MISMATCH；kid 命中但非对应私钥签 → BAD_SIGNATURE（kid 仅索引）
 *  - 坏 base64/坏 JSON → BAD_PAYLOAD
 *  - 错指纹（真签名签给别人）→ FINGERPRINT_MISMATCH
 *  - 旧高席单回滚 → VERSION_ROLLBACK；同版本/新版本接受
 *  - 免费实例 entitlement=null → 接受
 *  - 单据结构/product 不符 → BAD_PAYLOAD
 */
import { describe, it, expect } from "vitest";
import { sign } from "node:crypto";
import {
  verifyAndParse,
  verifyAndParseWithRing,
  validateEntitlementShape,
  acceptEntitlement,
  RejectError,
  type ParsedEnvelope,
  type Entitlement,
} from "../verify.js";
import { deriveKid, findKeyByKid, builtinKids } from "../keys.js";
import { genEd25519, signWire, tamperPayload } from "./signHelper.js";

function envelope(partial: Partial<Entitlement> = {}): ParsedEnvelope {
  return {
    v: 1,
    serverTime: 1800000000,
    intervalSec: 21600,
    entitlement: {
      product: "gouxiangdb",
      edition: "business",
      licenseId: "lic-1",
      licensedTo: "客户",
      seats: 10,
      issuedAt: 1799999000,
      expiresAt: 1900000000,
      fingerprint: "a".repeat(64),
      nonce: "n-1",
      features: {},
      version: 3,
      kid: "x",
      offline: false,
      ...partial,
    },
  };
}

describe("内置公钥环", () => {
  it("内置开发公钥 kid 自派生为 da469cd3", () => {
    const pem = findKeyByKid("da469cd3")?.pem ?? "";
    expect(pem).toBeTruthy();
    expect(deriveKid(pem)).toBe("da469cd3");
    expect(builtinKids()).toContain("da469cd3");
  });

  it("未知 kid 取不到公钥", () => {
    expect(findKeyByKid("deadbeef")).toBeNull();
    expect(findKeyByKid(undefined)).toBeNull();
  });

  it("kid 命中但用别的私钥签名 → 仍 BAD_SIGNATURE（kid 不作身份依据）", () => {
    const attacker = genEd25519();
    // 攻击者把自己信封的 kid 伪装成内置开发公钥 kid
    const wire = signWire(envelope(), attacker);
    wire.kid = "da469cd3";
    expect(() => verifyAndParseWithRing(wire)).toThrow(RejectError);
    try {
      verifyAndParseWithRing(wire);
    } catch (e) {
      expect((e as RejectError).code).toBe("BAD_SIGNATURE");
    }
  });

  it("未知 kid 信封 → KID_MISMATCH", () => {
    const k = genEd25519();
    const wire = signWire(envelope(), k);
    wire.kid = "00000000";
    try {
      verifyAndParseWithRing(wire);
      throw new Error("应拒绝");
    } catch (e) {
      expect((e as RejectError).code).toBe("KID_MISMATCH");
    }
  });
});

describe("verifyAndParse 字节签名", () => {
  const k = genEd25519();

  it("真签名通过且解析出原对象", () => {
    const env = envelope();
    const parsed = verifyAndParse(signWire(env, k), k.publicKey, k.kid);
    expect(parsed.entitlement?.seats).toBe(10);
    expect(parsed.serverTime).toBe(1800000000);
  });

  it("篡改 seats 保留旧签名 → BAD_SIGNATURE", () => {
    const wire = tamperPayload(signWire(envelope(), k), (p) => {
      p.entitlement.seats = 999;
    });
    try {
      verifyAndParse(wire, k.publicKey, k.kid);
      throw new Error("应拒绝");
    } catch (e) {
      expect((e as RejectError).code).toBe("BAD_SIGNATURE");
    }
  });

  it("kid 与期望不符 → KID_MISMATCH", () => {
    const wire = signWire(envelope(), k);
    expect(() => verifyAndParse(wire, k.publicKey, "otherkid")).toThrow(RejectError);
  });

  it("签名有效但载荷非 JSON → BAD_PAYLOAD", () => {
    // 用私钥对「坏 JSON 字节」真签名：验签通过，但 JSON.parse 失败。
    const badBytes = Buffer.from("not-json{", "utf-8");
    const wire = {
      envelopeB64: badBytes.toString("base64"),
      signature: sign(null, badBytes, k.privateKey).toString("base64"),
      kid: k.kid,
    };
    try {
      verifyAndParse(wire, k.publicKey, k.kid);
      throw new Error("应拒绝");
    } catch (e) {
      expect((e as RejectError).code).toBe("BAD_PAYLOAD");
    }
  });

  it("坏 signature base64/长度不符 → BAD_SIGNATURE", () => {
    const wire = signWire(envelope(), k);
    wire.signature = "////";
    expect(() => verifyAndParse(wire, k.publicKey, k.kid)).toThrow(RejectError);
  });
});

describe("单据结构校验", () => {
  it("null / undefined 合法（免费实例）", () => {
    expect(() => validateEntitlementShape(null)).not.toThrow();
    expect(() => validateEntitlementShape(undefined)).not.toThrow();
  });

  it.each([
    ["product 错", { product: "other" }],
    ["seats=0", { seats: 0 }],
    ["seats 小数", { seats: 2.5 }],
    ["seats 非数", { seats: "10" }],
    ["licensedTo 空", { licensedTo: "" }],
    ["fingerprint 空", { fingerprint: "" }],
    ["version 负", { version: -1 }],
    ["offline 非布尔", { offline: "false" }],
    ["revoked 非布尔", { revoked: "yes" }],
    ["features 非对象", { features: null }],
  ])("%s → BAD_PAYLOAD", (_name, patch) => {
    const e = envelope({ ...(patch as Partial<Entitlement>) }).entitlement as Entitlement;
    expect(() => validateEntitlementShape(e)).toThrow(RejectError);
  });
});

describe("acceptEntitlement 接收规则", () => {
  const fp = "a".repeat(64);

  it("entitlement=null 通过", () => {
    expect(acceptEntitlement({ v: 1, serverTime: 1, intervalSec: 1, entitlement: null }, fp, null)).toBeNull();
  });

  it("指纹不符 → FINGERPRINT_MISMATCH", () => {
    const r = acceptEntitlement(envelope({ fingerprint: "b".repeat(64) }), fp, null);
    expect(r?.code).toBe("FINGERPRINT_MISMATCH");
  });

  it("版本低于缓存 → VERSION_ROLLBACK", () => {
    const r = acceptEntitlement(envelope({ fingerprint: fp, version: 1 }), fp, 4);
    expect(r?.code).toBe("VERSION_ROLLBACK");
  });

  it("同版本/新版本接受", () => {
    expect(acceptEntitlement(envelope({ fingerprint: fp, version: 4 }), fp, 4)).toBeNull();
    expect(acceptEntitlement(envelope({ fingerprint: fp, version: 5 }), fp, 4)).toBeNull();
  });

  it("无缓存时任何版本都接受（首收）", () => {
    expect(acceptEntitlement(envelope({ fingerprint: fp, version: 1 }), fp, null)).toBeNull();
  });
});
