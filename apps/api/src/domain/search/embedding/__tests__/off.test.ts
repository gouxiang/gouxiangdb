// M5/S4 offProvider 单测：零外网（任何 fetch 即失败）、embed 确定性防御、health 恒 ok。

import { describe, expect, it } from "vitest";
import { createOffProvider, OFF_EMBED_UNSUPPORTED } from "../off.js";

// 全局哨兵：off 生命周期内一旦发生 fetch 立即失败，证明零触网。
function installFetchTripwire() {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("off provider must not perform network IO");
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe("offProvider", () => {
  it("不加载资源：mode=off、model 空、dim=0、batchSize=0", () => {
    const restore = installFetchTripwire();
    try {
      const p = createOffProvider();
      expect(p.mode).toBe("off");
      expect(p.model).toBe("");
      expect(p.dim).toBe(0);
      expect(p.batchSize).toBe(0);
    } finally {
      restore();
    }
  });

  it("health 恒 ok 且不触网", async () => {
    const restore = installFetchTripwire();
    try {
      const p = createOffProvider();
      await expect(p.health()).resolves.toMatchObject({ ok: true, detail: "off" });
    } finally {
      restore();
    }
  });

  it("embed 被调用时确定性抛固定错误（而非静默返回空向量）", async () => {
    const restore = installFetchTripwire();
    try {
      const p = createOffProvider();
      await expect(p.embed(["abc"])).rejects.toThrow(OFF_EMBED_UNSUPPORTED);
      await expect(p.embed([])).rejects.toThrow(OFF_EMBED_UNSUPPORTED);
    } finally {
      restore();
    }
  });

  it("dispose 是 no-op 且可 await", async () => {
    const p = createOffProvider();
    await expect(p.dispose?.()).resolves.toBeUndefined();
  });
});
