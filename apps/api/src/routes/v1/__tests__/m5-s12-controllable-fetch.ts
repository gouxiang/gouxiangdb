// M5/S12 测试专用可控全局 fetch（非 .test.ts，不被收集）：模拟 embedding 契约端点故障，
// 零真外网。两种姿态：
//   egress="stub"（cloud 世界默认）：受控向量响应 / 401 / 网络错 / 永不完成（超时）/ 999 维；
//   egress="failClosed"（off 零外网断言）：任何调用都记录后立即抛错（有调用即测试失败）。
// 所有调用记录 url/host/时间，供零外网与「只朝 baseURL host 出网」断言。

import { deterministicVec4 } from "./m5-ac-m5-3-harness.js";

export type CloudRule = "controlled" | "http401" | "network" | "timeout" | "dim999";

export interface EmbeddingCall { url: string; host: string; at: number }

export interface ControlledFetch {
  fetchImpl: typeof fetch;
  calls: EmbeddingCall[];
  setRule: (r: CloudRule) => void;
}

/** 构造可控 fetch。rule 可热切换（不重启 app）；非契约端点在 stub 姿态也直接抛错。 */
export function createControlledFetch(initialRule: CloudRule = "controlled"): ControlledFetch {
  const calls: EmbeddingCall[] = [];
  let rule: CloudRule = initialRule;

  const record = (u: string): void => {
    let host = u;
    try { host = new URL(u).host; } catch { /* 保留原串 */ }
    calls.push({ url: u, host, at: Date.now() });
  };

  const fetchImpl = (async (url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const u = String(url);
    record(u);
    if (rule === "http401") {
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
    }
    if (rule === "dim999") {
      let inputs = ["x"];
      try {
        const parsed = JSON.parse(init?.body ?? "{}") as { input?: unknown };
        if (typeof parsed.input === "string") inputs = [parsed.input];
        else if (Array.isArray(parsed.input)) inputs = parsed.input.map(String);
      } catch { /* 默认 */ }
      return new Response(
        JSON.stringify({ data: inputs.map((q, i) => ({ index: i, embedding: new Array(999).fill(0.01) })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (rule === "network") throw new TypeError("fetch failed: simulated network down");
    if (rule === "timeout") {
      // 永不自行完成：由调用方 AbortController（GX_EMBEDDING_TIMEOUT_MS）abort 触发 AbortError。
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted"); e.name = "AbortError"; reject(e);
        }, { once: true });
      });
    }
    // 只接受 embedding 契约端点（不放任何第三方/遥测/CDN 请求）。
    if (!u.endsWith("/v1/embeddings")) throw new Error(`S12 stub 未预期的出网请求: ${u}`);
    let inputs = ["s12"];
    try {
      const parsed = JSON.parse(init?.body ?? "{}") as { input?: unknown };
      if (typeof parsed.input === "string") inputs = [parsed.input];
      else if (Array.isArray(parsed.input)) inputs = parsed.input.map(String);
    } catch { /* 兜底向量 */ }
    const data = inputs.map((q, i) => ({ index: i, embedding: deterministicVec4(q) }));
    return new Response(JSON.stringify({ data }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchImpl, calls, setRule: (r) => { rule = r; } };
}

/**
 * fail-closed fetch：任何方向调用都记录后抛错。off 零外网测试用——业务链一旦触网即失败，
 * 同时 calls 数组提供「零调用」的客观证据。
 */
export function createFailClosedFetch(): { fetchImpl: typeof fetch; calls: EmbeddingCall[] } {
  const calls: EmbeddingCall[] = [];
  const fetchImpl = (async (url: unknown) => {
    const u = String(url);
    let host = u;
    try { host = new URL(u).host; } catch { /* 保留 */ }
    calls.push({ url: u, host, at: Date.now() });
    throw new Error(`S12 fail-closed 拦截：off 态不允许任何出网请求 -> ${u}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
