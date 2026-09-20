// apps/api/src/routes/kb/__tests__/share-token.test.ts
// 分享令牌生成器 genShareToken 的规格测试：长度 / 字符集 / 唯一性 / 熵量级。
// 纯函数层，不触碰数据库。
import { describe, it, expect } from "vitest";
import { genShareToken } from "../shared.js";

/** base64url 字母表：A-Za-z0-9 加 - 与 _，不含 + / = */
const BASE64URL_32 = /^[A-Za-z0-9_-]{32}$/;
/** 历史格式（改动前的 hex 编码）形态，仅用于对比断言，不要求新 token 命中 */
const HEX_48 = /^[0-9a-f]{48}$/;

describe("genShareToken 规格", () => {
  it("长度为 32（24 字节熵经 base64url 编码，无 padding）", () => {
    for (let i = 0; i < 50; i++) {
      expect(genShareToken()).toHaveLength(32);
    }
  });

  it("字符集严格是 base64url，不含 + / =", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = genShareToken();
      expect(t).toMatch(BASE64URL_32);
      expect(t).not.toMatch(/[+/=]/);
      for (const ch of t) seen.add(ch);
    }
    // 抽样 500×32=16000 个字符，应覆盖到 base64url 的 64 个符号中的绝大多数
    // （下界取 60 是保守值，避免偶发抖动；真实覆盖率远高于此）
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });

  it("不再是旧的 48 位 hex 形态（确认编码确已切换）", () => {
    expect(genShareToken()).not.toMatch(HEX_48);
  });

  it("1000 次生成无碰撞（192 bit 熵，碰撞概率 ≈ 2^-161）", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(genShareToken());
    expect(set.size).toBe(1000);
  });

  it("两次调用互不相同", () => {
    expect(genShareToken()).not.toBe(genShareToken());
  });
});
