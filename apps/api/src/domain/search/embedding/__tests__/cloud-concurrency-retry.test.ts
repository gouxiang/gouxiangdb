// cloud provider 真的消费并发与重试配置（不是只存不用的摆设）。
//
// 断言方式：注入 fetch + sleep，数"同时在飞的请求数"与"总尝试次数"，直接证明
// cfg.concurrency 进了信号量、cfg.retryMaxAttempts 进了重试循环、cfg.retryBaseMs 进了退避基数。

import { describe, expect, it } from "vitest";
import { createCloudProvider } from "../cloud.js";
import { retryDelayMs, DEFAULT_RETRY_BASE_MS } from "../types.js";

interface FakeRes {
  ok: boolean;
  status: number;
  json: () => Promise<{ data: Array<{ index: number; embedding: number[] }> }>;
}

const okRes = (n: number): FakeRes => ({
  ok: true,
  status: 200,
  json: async () => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [0.1, 0.2] })) }),
});

const errRes = (status: number): FakeRes => ({
  ok: false,
  status,
  json: async () => ({ data: [] }),
});

function baseCfg(over: Partial<{ concurrency: number; retryMaxAttempts: number; retryBaseMs: number }> = {}) {
  return {
    baseURL: "https://embedding.example.com/v1",
    apiKey: "sk-test",
    model: "m",
    batchSize: 1,
    timeoutMs: 1000,
    ...over,
  };
}

describe("cloud provider 消费并发与重试配置", () => {
  it("concurrency 进信号量：在飞请求数不超过配置值", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okRes(1);
    }) as unknown as typeof fetch;

    // batchSize=1、10 条文本 -> 10 批；concurrency=2 时在飞峰值必须 <= 2。
    const p2 = createCloudProvider({ ...baseCfg({ concurrency: 2 }), batchSize: 1 }, { fetchImpl });
    await p2.embed(Array.from({ length: 10 }, (_, i) => `t${i}`));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2); // 真的并发起来了（不是退化成串行）

    peak = 0;
    const p5 = createCloudProvider({ ...baseCfg({ concurrency: 5 }), batchSize: 1 }, { fetchImpl });
    await p5.embed(Array.from({ length: 10 }, (_, i) => `t${i}`));
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("retryMaxAttempts 进重试循环：5xx 尝试次数等于配置值（默认仍是 3）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return errRes(500);
    }) as unknown as typeof fetch;
    const sleep = async () => undefined;

    const p1 = createCloudProvider(baseCfg({ retryMaxAttempts: 1 }), { fetchImpl, sleep });
    await expect(p1.embed(["x"])).rejects.toThrow();
    expect(calls).toBe(1);

    calls = 0;
    const p5 = createCloudProvider(baseCfg({ retryMaxAttempts: 5 }), { fetchImpl, sleep });
    await expect(p5.embed(["x"])).rejects.toThrow();
    expect(calls).toBe(5);

    calls = 0;
    const pDefault = createCloudProvider(baseCfg(), { fetchImpl, sleep });
    await expect(pDefault.embed(["x"])).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("retryBaseMs 进退避基数：注入的 sleep 按配置基数 * 2^(n-1) 递增", async () => {
    const delays: number[] = [];
    const fetchImpl = (async () => errRes(503)) as unknown as typeof fetch;
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const p = createCloudProvider(baseCfg({ retryMaxAttempts: 4, retryBaseMs: 100 }), { fetchImpl, sleep });
    await expect(p.embed(["x"])).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400]);

    // 纯函数层：退避基数与钳制（上限 8s）不被误改。
    expect(retryDelayMs(1, 100)).toBe(100);
    expect(retryDelayMs(1)).toBe(DEFAULT_RETRY_BASE_MS);
    expect(retryDelayMs(20, 1000)).toBe(8000);
  });

  it("401/403 无论重试配置多大都不重试（不放大无效凭据的打击面）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return errRes(401);
    }) as unknown as typeof fetch;
    const p = createCloudProvider(baseCfg({ retryMaxAttempts: 5 }), { fetchImpl, sleep: async () => undefined });
    await expect(p.embed(["x"])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("非法并发/重试值被钳回安全默认，绝不进无界循环", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return errRes(500);
    }) as unknown as typeof fetch;
    const p = createCloudProvider(
      baseCfg({ concurrency: 0, retryMaxAttempts: 0 }),
      { fetchImpl, sleep: async () => undefined },
    );
    await expect(p.embed(["x"])).rejects.toThrow();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(10);
  });
});
