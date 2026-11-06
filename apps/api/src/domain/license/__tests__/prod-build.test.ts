/**
 * 生产授权构建隔离测试（0.3.0 商业发版安全核心）：
 *  - 信任根双源：keyring.dev 只含 da469cd3，keyring.prod 只含 ff02db72（物理不含开发钥）；
 *  - vitest（无 esbuild 换源）下 keys.ts 经 keyring.dev 解析 → 默认环＝开发环；
 *  - 生产换源后的正确行为由构建期 esbuild onResolve 保证（apps/api/scripts/build.mjs），
 *    并由发版流水线对产物 grep 取证（dev PEM 必须物理缺失）；这里直接对 keyring.prod 源做
 *    kid 自检，保证生产源本身正确。
 *  - 模式下限：生产构建最终 mode 永不为 off（抬到 verify）；
 *  - 热切通道：license.mode 只接受 verify/enforce，off/非法值不被采信，无法用来关授权。
 */
import { describe, it, expect } from "vitest";
import { buildKeyRing, deriveKid, builtinKids } from "../keys.js";
import { RING_DECLARED as DEV_RING } from "../keyring.dev.js";
import { RING_DECLARED as PROD_RING } from "../keyring.prod.js";
import {
  parseModeFile,
  resolveLicenseMode,
  PROD_LICENSE_URL,
} from "../configLicense.js";

describe("信任根双源", () => {
  it("keyring.dev 只含开发公钥 da469cd3", () => {
    expect(DEV_RING.map((k) => k.kid)).toEqual(["da469cd3"]);
    for (const k of DEV_RING) expect(deriveKid(k.pem)).toBe(k.kid);
  });

  it("keyring.prod 只含生产公钥 ff02db72，且不含开发钥", () => {
    expect(PROD_RING.map((k) => k.kid)).toEqual(["ff02db72"]);
    expect(PROD_RING.some((k) => k.kid === "da469cd3")).toBe(false);
    for (const k of PROD_RING) expect(deriveKid(k.pem)).toBe(k.kid);
    expect(deriveKid(PROD_RING[0].pem)).toBe("ff02db72");
  });

  it("两源 kid 互不相同（确为隔离密钥，非抄写重复）", () => {
    expect(DEV_RING[0].kid).not.toBe(PROD_RING[0].kid);
  });

  it("vitest 默认环＝开发环（keys.ts 未经生产换源）", () => {
    expect(buildKeyRing().map((k) => k.kid)).toEqual(["da469cd3"]);
    expect(builtinKids()).toEqual(["da469cd3"]);
  });
});

describe("license.mode 热切文件解析", () => {
  it("仅接受精确小写 verify/enforce", () => {
    expect(parseModeFile("verify")).toBe("verify");
    expect(parseModeFile("  enforce\n")).toBe("enforce");
  });
  it("off/空白/大写/未知/空一律不采信（null）", () => {
    expect(parseModeFile("off")).toBeNull();
    expect(parseModeFile("")).toBeNull();
    expect(parseModeFile("   ")).toBeNull();
    expect(parseModeFile("ENFORCE")).toBeNull();
    expect(parseModeFile("on")).toBeNull();
    expect(parseModeFile(null)).toBeNull();
    expect(parseModeFile(undefined)).toBeNull();
  });
});

describe("生产构建模式下限 resolveLicenseMode", () => {
  it("文件优先于 env（删文件即回 env 默认）", () => {
    expect(resolveLicenseMode("enforce", "verify", false)).toBe("verify");
    expect(resolveLicenseMode("enforce", null, false)).toBe("enforce");
  });
  it("生产：env off 且无文件 -> 抬到 verify，永不 off", () => {
    expect(resolveLicenseMode("off", null, true)).toBe("verify");
  });
  it("生产：文件写 off 不被采信，env 也 off -> 仍 verify（无法用文件关授权）", () => {
    expect(resolveLicenseMode("off", parseModeFile("off"), true)).toBe("verify");
  });
  it("生产：文件大写 ENFORCE 不采信，env off -> verify", () => {
    expect(resolveLicenseMode("off", parseModeFile("  ENFORCE "), true)).toBe("verify");
  });
  it("生产：合法文件/enforce 与 verify 正常放行", () => {
    expect(resolveLicenseMode("verify", "enforce", true)).toBe("enforce");
    expect(resolveLicenseMode("verify", null, true)).toBe("verify");
    expect(resolveLicenseMode("enforce", null, true)).toBe("enforce");
  });
  it("开发：env off 且无文件 -> 保持 off（非授权渠道逐字节不变）", () => {
    expect(resolveLicenseMode("off", null, false)).toBe("off");
  });
});

describe("生产默认地址", () => {
  it("指向正式授权中心域名（https）", () => {
    expect(PROD_LICENSE_URL).toBe("https://gouxiang.hn.takin.cc");
  });
});
