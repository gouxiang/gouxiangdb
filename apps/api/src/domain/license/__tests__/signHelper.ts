/**
 * 测试专用：临时 Ed25519 keypair + 自签信封。
 * 仅在测试内生成一次性密钥，避免把授权中心开发私钥拷进开源客户端仓。
 * 密码学行为（raw Ed25519 over 解码字节）与生产 verifyAndParse 完全一致。
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { ParsedEnvelope, WireEnvelope } from "../verify.js";

export interface TestKey {
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicPem: string;
  kid: string;
}

export function genEd25519(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = publicKey.export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(der).digest("hex").slice(0, 8);
  return { publicKey, privateKey, publicPem, kid };
}

/** 用私钥对「信封 JSON 的 UTF-8 字节」做 raw Ed25519，再整体 base64（与授权中心同口径）。 */
export function signWire(envelope: ParsedEnvelope, key: TestKey): WireEnvelope {
  const payload = Buffer.from(JSON.stringify(envelope), "utf-8");
  const signature = sign(null, payload, key.privateKey);
  return {
    envelopeB64: payload.toString("base64"),
    signature: signature.toString("base64"),
    kid: key.kid,
  };
}

/** 破坏信封字节但保留旧签名（模拟篡改）。 */
export function tamperPayload(wire: WireEnvelope, mutate: (parsed: any) => void): WireEnvelope {
  const parsed = JSON.parse(Buffer.from(wire.envelopeB64, "base64").toString("utf-8"));
  mutate(parsed);
  return {
    envelopeB64: Buffer.from(JSON.stringify(parsed), "utf-8").toString("base64"),
    signature: wire.signature,
    kid: wire.kid,
  };
}
