// M5/S4 cloud provider 单测：本地 node:http mock，不打真外网。
// 覆盖乱序 index 对齐、dim 探测、5xx 重试 3 次、401/403/4xx 不重试、超时 Abort、
// 空 input 零请求、超长截断、/v1 端点、缺 model 回 off、信号量并发上限。

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { createCloudProvider, createEmbeddingProvider, alignResponse } from "../cloud.js";
import { EmbeddingError } from "../types.js";

interface MockServer { url: string; close: () => void; calls: number; bodies: any[]; paths: string[]; }

function startServer(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void | Promise<void>,
  opts: { delayMs?: number } = {}): Promise<MockServer> {
  return new Promise((resolve) => {
    const calls = { n: 0 };
    const bodies: any[] = [];
    const paths: string[] = [];
    const srv = http.createServer((req, res) => {
      calls.n += 1;
      paths.push(req.url ?? "");
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        const body = raw ? JSON.parse(raw) : {};
        bodies.push(body);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        await handler(req, body, res);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => srv.close(),
        get calls() { return calls.n; },
        bodies, paths,
      });
    });
  });
}

const okVec = (index: number, v: number[]) => ({ index, embedding: v });
const baseCfg = (url: string, over: Record<string, unknown> = {}) => ({
  baseURL: url, apiKey: "secret", model: "m", batchSize: 64, timeoutMs: 5000, ...over,
});
const fastDeps = { retryBaseMs: 5 };

afterEach(() => { /* servers closed inside each test */ });

describe("cloud 正常路径", () => {
  it("按 data[].index 对齐乱序响应、等长同序、首响应探测 dim", async () => {
    const srv = await startServer((_req, _b, res) => {
      // 故意乱序回 2,0,1
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [okVec(2, [0, 0, 2]), okVec(0, [1, 0, 0]), okVec(1, [0, 1, 0])] }));
    });
    const p = createCloudProvider(baseCfg(srv.url), fastDeps);
    const out = await p.embed(["a", "b", "c"]);
    expect(out.map((v) => Array.from(v))).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 2]]);
    expect(out).toHaveLength(3);
    expect(p.dim).toBe(3);
    expect(srv.calls).toBe(1);
    expect(srv.bodies[0]).toMatchObject({ model: "m", encoding_format: "float" });
    expect(srv.paths[0]).toBe("/v1/embeddings");
    srv.close();
  });

  it("空 input / 全空白不发任何请求，按位返回空向量", async () => {
    const srv = await startServer(() => { throw new Error("should not be called"); });
    const p = createCloudProvider(baseCfg(srv.url), fastDeps);
    const out = await p.embed([]);
    expect(out).toEqual([]);
    const out2 = await p.embed(["", "   "]);
    expect(out2.map((v) => v.length)).toEqual([0, 0]);
    expect(srv.calls).toBe(0);
    srv.close();
  });

  it("超长单条在边界截断到 8000 码点", async () => {
    const srv = await startServer((_req, body, res) => {
      const lens = body.input.map((s: string) => Array.from(s).length);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: body.input.map((_: unknown, i: number) => okVec(i, lens[i] === 8000 ? [1] : [0])) }));
    });
    const p = createCloudProvider(baseCfg(srv.url), fastDeps);
    const [v] = await p.embed(["字".repeat(8100)]);
    expect(Array.from(v)).toEqual([1]);
    expect(Array.from(srv.bodies[0].input[0]).length).toBe(8000);
    srv.close();
  });

  it("Bearer 头与编码字段正确", async () => {
    const seen: { auth?: string } = {};
    const srv = await startServer((req, _b, res) => {
      seen.auth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [okVec(0, [1, 2])] }));
    });
    await createCloudProvider(baseCfg(srv.url), fastDeps).embed(["x"]);
    expect(seen.auth).toBe("Bearer secret");
    srv.close();
  });
});

describe("cloud 重试 / 不重试 / unhealthy", () => {
  it("5xx 指数退避重试 3 次后失败并 unhealthy", async () => {
    const srv = await startServer((_r, _b, res) => { res.statusCode = 503; res.end(); });
    const p = createCloudProvider(baseCfg(srv.url), fastDeps);
    await expect(p.embed(["x"])).rejects.toMatchObject({ kind: "server" });
    expect(srv.calls).toBe(3);
    expect(p.unhealthy).toBe(true);
    expect((await p.health()).ok).toBe(false);
    srv.close();
  });

  it("401 不重试直接 auth 失败并 unhealthy", async () => {
    const srv = await startServer((_r, _b, res) => { res.statusCode = 401; res.end(); });
    const p = createCloudProvider(baseCfg(srv.url), fastDeps);
    // 只调用一次（401 不重试）；对同一错误做 instanceof + kind/status 两个断言。
    const err = await p.embed(["x"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toMatchObject({ kind: "auth", status: 401 });
    expect(srv.calls).toBe(1);
    expect(p.unhealthy).toBe(true);
    expect(p.lastErrorKind).toBe("auth");
    srv.close();
  });

  it("403 同样不重试；400 客户端错误不重试", async () => {
    const srv403 = await startServer((_r, _b, res) => { res.statusCode = 403; res.end(); });
    const p403 = createCloudProvider(baseCfg(srv403.url), fastDeps);
    await expect(p403.embed(["x"])).rejects.toMatchObject({ kind: "auth" });
    expect(srv403.calls).toBe(1);
    srv403.close();

    const srv400 = await startServer((_r, _b, res) => { res.statusCode = 400; res.end(); });
    const p400 = createCloudProvider(baseCfg(srv400.url), fastDeps);
    await expect(p400.embed(["x"])).rejects.toMatchObject({ kind: "client", status: 400 });
    expect(srv400.calls).toBe(1);
    srv400.close();
  });

  it("超时 AbortController：慢响应按 timeoutMs 中断并重试，最终 timeout 失败", async () => {
    const srv = await startServer((_r, _b, res) => { setTimeout(() => res.end(JSON.stringify({ data: [] })), 300); }, { delayMs: 0 });
    const p = createCloudProvider(baseCfg(srv.url, { timeoutMs: 40 }), { retryBaseMs: 2 });
    const t0 = Date.now();
    await expect(p.embed(["x"])).rejects.toMatchObject({ kind: "timeout" });
    expect(srv.calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(900);
    srv.close();
  });

  it("成功后 unhealthy 自动复位", async () => {
    let fail = true;
    const srv = await startServer((_r, _b, res) => {
      if (fail) { res.statusCode = 401; res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [okVec(0, [1])] }));
    });
    const p = createCloudProvider(baseCfg(srv.url), fastDeps);
    await expect(p.embed(["x"])).rejects.toMatchObject({ kind: "auth" });
    expect(p.unhealthy).toBe(true);
    fail = false;
    await p.embed(["x"]);
    expect(p.unhealthy).toBe(false);
    expect(p.dim).toBe(1);
    srv.close();
  });
});

describe("cloud 信号量并发上限", () => {
  it("concurrency=2 时在飞批请求不超过 2（batchSize=2，6 输入=3 批）", async () => {
    let inflight = 0; let maxInflight = 0;
    const srv = await startServer(async (_r, _b, res) => {
      inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight -= 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: _b.input.map((_: unknown, i: number) => okVec(i, [1])) }));
    });
    const p = createCloudProvider(baseCfg(srv.url, { batchSize: 2 }), { concurrency: 2, retryBaseMs: 5 });
    const out = await p.embed(["a", "b", "c", "d", "e", "f"]);
    expect(out).toHaveLength(6);
    expect(maxInflight).toBe(2);
    srv.close();
  });
});

describe("createEmbeddingProvider 配置门", () => {
  it("缺 model/baseURL/apiKey 不启用 cloud，回 off（非降级，零外网）", () => {
    const s = { baseURL: "http://x", apiKey: "k" } as any;
    const p = createEmbeddingProvider("cloud", s);
    expect(p.mode).toBe("off");
    expect(createEmbeddingProvider("off", baseCfg("http://x")).mode).toBe("off");
  });
});

describe("alignResponse 脏响应", () => {
  it("缺 data/越界 index/非向量/缺 index/ragged 均抛 server 错", () => {
    expect(() => alignResponse({}, 1)).toThrow(/missing data/);
    expect(() => alignResponse({ data: [okVec(2, [1])] }, 1)).toThrow(/bad index/);
    expect(() => alignResponse({ data: [{ index: 0, embedding: ["x"] }] }, 1)).toThrow(/number\[\]/);
    expect(() => alignResponse({ data: [okVec(0, [1])] }, 2)).toThrow(/missing index 1/);
    expect(() => alignResponse({ data: [okVec(0, [1, 2]), okVec(1, [3])] }, 2)).toThrow(/ragged/);
  });
});
