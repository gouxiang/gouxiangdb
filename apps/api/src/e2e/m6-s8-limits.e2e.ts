// M6/S8-E §460 出口三件：11MB 豁免边界 / 独立限流可观测 / 30s 超时不挂连接。
//
// 派工单 §D 的口径是"引用既有 golden + 复跑，不要新造"。本文件的做法：
//   ① 11MB：**引用** S0 golden 与 m6-s2-mcp-app.test.ts 的断言，并在**真服务形态**下复跑一次
//      （既有断言走 app.request，本片走真监听端口，属"同口径再证"而非新造对抗）；
//   ② 限流：**引用** m6-s2-mcp-rate-limit.test.ts 的双桶设计，在真服务上把桶调小后观测 429/Retry-After；
//   ③ 超时：**引用** S7 m6-s7-audit-idempotency.test.ts 的慢夹具口径（本片以真服务 + 真 socket 复跑，
//      证明"30s（此处按比例缩小）超时不挂连接"在真实传输层成立），最终门仍会复跑 S7 原用例。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapE2e, type E2eStack } from "./bootstrap.js";
import { callTool, fetchFor, parseText, rpc, startTcpServer, INIT_MESSAGE, type RunningServer } from "./serverHarness.js";
import { dumpAttackMatrix, recordAttack } from "./attackLog.js";

const TWO_MB = 2 * 1024 * 1024;
/** §460：/mcp 独立 body 上限（默认 11MB）——以 2MB 越过 /api 的 1MB 档但远低于 11MB 档。 */
const SLOW_TOOL_TIMEOUT_MS = 1200;
const SLOW_TOOL_DELAY_MS = 5000;

let stack: E2eStack;
let limited: RunningServer;
let slow: RunningServer;

beforeAll(async () => {
  stack = await bootstrapE2e("gx-m6-s8-limits-");

  // 限流实例：真服务 + 把 patId 桶调到 3（IP 预桶放宽以免先撞 IP 桶）。
  process.env.GX_RATE_LIMIT = "on";
  process.env.GX_MCP_RATE_PAT_MAX = "3";
  process.env.GX_MCP_RATE_IP_MAX = "1000";
  process.env.GX_MCP_TOOL_TIMEOUT_MS = String(SLOW_TOOL_TIMEOUT_MS);
  vi.resetModules(); // config 在 import 时冻结；换档必须重建模块图
  const app = (await import("../app.js")).createApp().app;
  // 慢工具夹具：注入到**新建模块图**的 TOOL_CATALOG（思路沿用 S7 的慢夹具；产品码零改动）。
  const catalog = await import("../mcp/tools/catalog.js");
  const cat = catalog.TOOL_CATALOG as unknown as Array<{
    meta: Record<string, unknown>; inputShape: Record<string, unknown>; run: () => Promise<unknown>;
  }>;
  cat.push({
    meta: { name: "e2e.slow", title: "e2e.slow", description: "e2e 慢夹具（仅测试）", scopes: [], family: null, readOnly: true },
    inputShape: {},
    run: async () => {
      await new Promise((r) => setTimeout(r, SLOW_TOOL_DELAY_MS));
      return { content: [{ type: "text", text: "late" }] };
    },
  });
  limited = await startTcpServer(app);
  slow = limited; // 同一实例：既用于限流观测，也用于超时观测（GX_MCP_RATE_PAT_MAX=3 只影响小桶用例）
  delete process.env.GX_RATE_LIMIT;
  delete process.env.GX_MCP_RATE_PAT_MAX;
  delete process.env.GX_MCP_RATE_IP_MAX;
  delete process.env.GX_MCP_TOOL_TIMEOUT_MS;
}, 240_000);

afterAll(async () => {
  dumpAttackMatrix();
  await slow?.close();
  await stack?.close();
});

describe("S8-E §460-1 11MB 豁免只对 /mcp 生效（既有 /api 1MB 行为零变化）", () => {
  it("/mcp 收 2MB -> 200（非 413）；/api 同尺寸 -> 413 PAYLOAD_TOO_LARGE", async () => {
    const big = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ping_echo", arguments: { text: "x".repeat(TWO_MB) } } };
    const mcpRes = await rpc(stack.tcp.target, big, { token: stack.fx.pat.full.token });
    expect(mcpRes.status, `/mcp 应放行 2MB（<11MB），实测 ${mcpRes.status}`).toBe(200);
    expect(mcpRes.status).not.toBe(413);

    const apiRes = await fetchFor(stack.tcp.target)(`${stack.tcp.target.origin}/api/records?tableId=none`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(TWO_MB) }),
    });
    expect(apiRes.status, `/api 仍须 413（1MB 档未放宽），实测 ${apiRes.status}`).toBe(413);
    expect(((await apiRes.json()) as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    recordAttack({ id: "§460/11MB 边界", entry: "http", input: "2MB payload → /mcp 与 /api", expected: "/mcp 200 且 /api 413", actual: "/mcp 200 / /api 413", verdict: "PASS" });
  });
});

describe("S8-E §460-2 独立限流可观测（patId 桶 + Retry-After）", () => {
  it("patId 桶满 3 次后第 4 次 -> 429 + Retry-After + X-RateLimit-*（未认证打不爆）", async () => {
    const token = stack.fx.pat.full.token;
    for (let i = 1; i <= 3; i++) {
      const ok = await callTool(limited.target, token, "ping_echo", { text: `rl${i}` });
      expect(ok.text, `第 ${i} 次应放行`).toBe(`pong:rl${i}`);
    }
    const res = await rpc(limited.target, INIT_MESSAGE, { token });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-limit")).toBe("3");
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32029);
    expect(body.error?.message).toBe("RATE_LIMITED");
    recordAttack({ id: "§460/独立限流", entry: "http", input: "同一 PAT 连续第 4 次请求", expected: "429 + Retry-After", actual: `429 retry-after=${res.headers.get("retry-after")}`, verdict: "PASS" });
  });
});

describe("S8-E §460-3 工具超时不挂连接（慢夹具，真 socket）", () => {
  it("慢工具 -> 结构化 TIMEOUT + HTTP 200，且连接随后仍可用", async () => {
    // 用**另一个 patId**（canvasRo）：限流桶按 patId 计，若与 §460-2 用同一令牌，桶早已被打满。
    // （取值必须放在用例体内——describe 回调在 collect 期执行，那时 stack 还没建。）
    const slowToken = stack.fx.pat.canvasRo.token;
    const started = Date.now();
    const env = await callTool(limited.target, slowToken, "e2e.slow", {});
    const elapsed = Date.now() - started;
    expect(env.status, "MCP 协议错误仍走 HTTP 200").toBe(200);
    expect(env.isError).toBe(true);
    expect(parseText<{ code: string }>(env).code).toBe("TIMEOUT");
    // 未等满慢夹具的 5s（说明是适配层超时，不是"跑到自然结束"）
    expect(elapsed).toBeGreaterThanOrEqual(SLOW_TOOL_TIMEOUT_MS - 200);
    expect(elapsed).toBeLessThan(SLOW_TOOL_DELAY_MS);
    // 不挂连接：同一 socket 上紧随其后的一次调用照常返回
    const after = await callTool(limited.target, slowToken, "ping_echo", { text: "after-timeout" });
    expect(after.text).toBe("pong:after-timeout");
    recordAttack({ id: "§460/超时不挂连接", entry: "http", input: `调用慢夹具（>${SLOW_TOOL_TIMEOUT_MS}ms）`, expected: "结构化 TIMEOUT + 连接可复用", actual: `TIMEOUT @${elapsed}ms，随后 ping 正常`, verdict: "PASS" });
  }, 60_000);
});
