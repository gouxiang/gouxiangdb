// M6/S1 PAT 纯函数单测（tokens.ts，零 IO）：生成/hash/前缀不泄漏随机段/常量时间比较/
// scope 六位校验/名称校验/过期计算（假时钟）/认证状态判定。

import { describe, expect, it } from "vitest";
import {
  DUMMY_TOKEN_HASH, PAT_DEFAULT_EXPIRY_DAYS, PAT_PREFIX, PAT_RANDOM_BYTES, PAT_SCOPES,
  PatValidationError, dummyHashCompare, evaluateTokenState, expiresAtFromDays, generateToken,
  hasPatPrefix, hashToken, isPatScope, parseScopes, serializeScopes, timingSafeEqualHex,
  validateName, validateScopes,
} from "../tokens.js";

describe("generateToken / hashToken", () => {
  it("明文 = gxpat_ + 24 字节 base64url（32 字符）；hash = sha256 hex；同明文同 hash", () => {
    const g = generateToken();
    expect(g.token.startsWith(PAT_PREFIX)).toBe(true);
    // 24 字节 base64url（无 padding）= 32 字符
    expect(g.token.length).toBe(PAT_PREFIX.length + (PAT_RANDOM_BYTES * 4) / 3);
    expect(g.token.length).toBe(PAT_PREFIX.length + 32);
    expect(g.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(g.tokenHash).toBe(hashToken(g.token));
    expect(g.tokenHash).toBe(hashToken(g.token)); // 确定性
  });

  it("tokenPrefix 恰为明文前 14 字符（gxpat_ + 8 随机），且【不泄漏剩余随机段】", () => {
    const g = generateToken();
    expect(g.tokenPrefix).toBe(g.token.slice(0, 14));
    expect(g.tokenPrefix.startsWith(PAT_PREFIX)).toBe(true);
    const secretPart = g.token.slice(PAT_PREFIX.length); // 32 随机字符
    expect(secretPart.length - 8).toBe(24); // 只暴露前 8
    // 泄漏检查：随机段的后 24 字符不出现在 tokenPrefix 的任何位置
    expect(g.tokenPrefix.includes(secretPart.slice(8))).toBe(false);
    expect(g.tokenPrefix.length).toBeLessThan(g.token.length);
  });

  it("两次生成不同（随机段 192bit）", () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });

  it("hasPatPrefix 精确判定前缀", () => {
    expect(hasPatPrefix(`${PAT_PREFIX}abc`)).toBe(true);
    expect(hasPatPrefix("Bearer gxpat_x")).toBe(false);
    expect(hasPatPrefix("eyJhbGciOi")).toBe(false);
    expect(hasPatPrefix("")).toBe(false);
  });
});

describe("常量时间比较（防时序侧信道）", () => {
  it("等长同值 true；不同值 false；长度不等 false", () => {
    const a = hashToken("t1");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, hashToken("t2"))).toBe(false);
    expect(timingSafeEqualHex(a, "deadbeef")).toBe(false); // 长度不等
  });

  it("dummyHashCompare 恒 false，且 dummy 摘要为非空 64 hex（供等长比较）", () => {
    expect(DUMMY_TOKEN_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(dummyHashCompare(hashToken("whatever"))).toBe(false);
    expect(dummyHashCompare(DUMMY_TOKEN_HASH)).toBe(false); // 即便传入 dummy 也返回 false（不冒充命中）
  });
});

describe("scope 六位（C-2）校验", () => {
  it("六位常量恰为 record/doc/canvas × read/write", () => {
    expect([...PAT_SCOPES]).toEqual([
      "record:read", "record:write", "doc:read", "doc:write", "canvas:read", "canvas:write",
    ]);
  });

  it("合法子集去重保序；空/非数组/未知位 -> PAT_SCOPE_INVALID", () => {
    expect(validateScopes(["doc:read", "record:read", "doc:read"])).toEqual(["doc:read", "record:read"]);
    for (const bad of [[], "doc:read", ["doc:admin"], [1], null]) {
      expect(() => validateScopes(bad)).toThrow(PatValidationError);
      try { validateScopes(bad); } catch (e) { expect((e as PatValidationError).code).toBe("PAT_SCOPE_INVALID"); }
    }
  });

  it("isPatScope", () => {
    expect(isPatScope("canvas:write")).toBe(true);
    expect(isPatScope("record:delete")).toBe(false);
    expect(isPatScope(1)).toBe(false);
  });

  it("serialize/parse 回环；坏 JSON 回空数组", () => {
    expect(parseScopes(serializeScopes(["doc:read"]))).toEqual(["doc:read"]);
    expect(parseScopes("not-json")).toEqual([]);
    expect(parseScopes('["doc:read","bogus"]')).toEqual(["doc:read"]);
  });
});

describe("名称校验", () => {
  it("trim 后非空且 ≤60；空/超长/非串 -> PAT_NAME_INVALID", () => {
    expect(validateName("  cursor-工作机  ")).toBe("cursor-工作机");
    expect(validateName("x".repeat(60))).toHaveLength(60);
    for (const bad of ["", "   ", "x".repeat(61), 42, null]) {
      expect(() => validateName(bad)).toThrow(PatValidationError);
      try { validateName(bad); } catch (e) { expect((e as PatValidationError).code).toBe("PAT_NAME_INVALID"); }
    }
  });
});

describe("过期计算（假时钟，C-3）", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  it("30/90/365 天精确偏移；null=永不过期；默认 90", () => {
    expect(expiresAtFromDays(30, now)?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(expiresAtFromDays(90, now)?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(expiresAtFromDays(365, now)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(expiresAtFromDays(null, now)).toBeNull();
    expect(PAT_DEFAULT_EXPIRY_DAYS).toBe(90);
  });

  it("非法天数 -> PAT_EXPIRY_INVALID", () => {
    for (const bad of [0, 7, 400, "90"] as unknown[]) {
      expect(() => expiresAtFromDays(bad as 30, now)).toThrow(PatValidationError);
    }
  });
});

describe("认证状态判定（顺序：revoked 先于 expired）", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  it("未吊销未过期 -> ok；过期 -> expired；吊销 -> revoked（且压倒过期）", () => {
    expect(evaluateTokenState({ revokedAt: null, expiresAt: null }, now)).toBe("ok");
    expect(evaluateTokenState({ revokedAt: null, expiresAt: new Date("2026-07-01T00:00:00Z") }, now)).toBe("ok");
    expect(evaluateTokenState({ revokedAt: null, expiresAt: new Date("2026-05-01T00:00:00Z") }, now)).toBe("expired");
    // 恰在到期时刻（<= now）视为过期
    expect(evaluateTokenState({ revokedAt: null, expiresAt: new Date(now) }, now)).toBe("expired");
    expect(evaluateTokenState({ revokedAt: new Date("2026-05-01T00:00:00Z"), expiresAt: null }, now)).toBe("revoked");
    expect(evaluateTokenState({ revokedAt: new Date("2026-05-01T00:00:00Z"), expiresAt: new Date("2026-05-01T00:00:00Z") }, now)).toBe("revoked");
  });
});
