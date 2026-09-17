// M6/S8-A 三客户端真连通（出口硬门：任一失败阻断 S9）。
//
// 客户端三套 + stdio 一入口，形态三种，逐一套组合都打到**真监听**（禁用 app.request 直调）：
//   ① curl 子进程（独立于 Node 的第二套 HTTP 实现，即"裸 JSON-RPC"）；
//   ② 官方 SDK `StreamableHTTPClientTransport`（"任意第三方 AI host 能接"的核心证据）；
//   ③ MCP Inspector CLI（官方调试器，**固定版本**；受网络限制时降级为基线手测并在报告显著标注）；
//   ④ stdio 第二入口用官方 `StdioClientTransport` 真 spawn（与 HTTP 共用同一 buildServer）。
// 形态：TCP 根路径 / unix socket / 子路径 basePath（`${BASE_PATH}/mcp` 与 `/mcp` 同源可达）。
//
// 每个 HTTP 客户端都覆盖：initialize 握手 + tools/list + 一次成功 tools/call + 一次被拒调用。
// 被拒口径统一用"入参越界"（ping_echo.text > 200）→ 协议层 -32602，与工具层业务拒绝区分清楚。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { bootstrapE2e, type E2eStack } from "./bootstrap.js";
import {
  INIT_MESSAGE, callMessage, callTool, curlAvailable, curlRpc, listMessage, rpc, startTcpServer,
  type E2eTarget, type RunningServer,
} from "./serverHarness.js";
import { openSdkClient, openStdioClient } from "./clientHarness.js";
import { INSPECTOR_VERSION, runInspectorToolsList } from "./inspectorCli.js";

const BASE_PATH = "/app/gouxiangdb";
const FORMS = ["tcp-root", "unix-socket", "basepath"] as const;
type Form = (typeof FORMS)[number];
const REJECTED_TEXT = "x".repeat(300); // ping_echo.text 上限 200 -> 协议层 -32602

let stack: E2eStack;
let bp: RunningServer;

/** 形态解析在运行期（服务在 beforeAll 才起）；用例名保持静态，便于 --reporter 阅读。 */
function formOf(form: Form): { target: E2eTarget; pathname: string; label: string } {
  if (form === "tcp-root") return { target: stack.tcp.target, pathname: "/mcp", label: `TCP ${stack.tcp.target.origin}/mcp` };
  if (form === "unix-socket") return { target: stack.unix.target, pathname: "/mcp", label: `unix ${stack.env.tmpDir}/api.sock -> /mcp` };
  return { target: bp.target, pathname: `${BASE_PATH}/mcp`, label: `TCP ${bp.target.origin}${BASE_PATH}/mcp` };
}

function rpcResult(body: string, label: string): { isError: boolean; text: string } {
  const parsed = JSON.parse(body) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  void label;
  return { isError: parsed.result?.isError ?? false, text: parsed.result?.content?.[0]?.text ?? "" };
}

/**
 * SDK 客户端调用"应被拒"的一次调用：SDK 版本/错误类别决定它是 **throw** 还是**回 isError 结果**，
 * 两者都是合法的"被拒"表现（本片实测：服务端把协议错误包成 isError 工具结果）。
 * 断言只钉一件事——**被拒且带 -32602**——不预设 SDK 的呈现形态。
 */
async function rejectedViaSdk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  label: string,
): Promise<void> {
  const outcome = await client.callTool({ name, arguments: args }).then(
    (r) => ({ kind: "result" as const, r: r as { isError?: boolean; content?: Array<{ text?: string }> } }),
    (e: unknown) => ({ kind: "throw" as const, e: e as { code?: number; message?: string } }),
  );
  if (outcome.kind === "throw") {
    expect(outcome.e.code, label).toBe(-32602);
    return;
  }
  expect(outcome.r.isError ?? false, label).toBe(true);
  expect(outcome.r.content?.[0]?.text ?? "", label).toContain("-32602");
}

beforeAll(async () => {
  stack = await bootstrapE2e("gx-m6-s8-clients-");
  // 第三形态：子路径部署（GX_BASE_PATH 在 config 求值时冻结 -> resetModules 后重新装配）。
  // 该实例同时挂 `${BASE_PATH}` 与根两份副本（app.ts 既有设计），故可断言"子路径与根同源可达"。
  process.env.GX_BASE_PATH = BASE_PATH;
  vi.resetModules();
  const bpApp = (await import("../app.js")).createApp().app;
  delete process.env.GX_BASE_PATH;
  bp = await startTcpServer(bpApp);
}, 240_000);

afterAll(async () => {
  await bp?.close();
  await stack?.close();
});

describe("S8-A-1 curl 裸 JSON-RPC（TCP 根 / unix socket / 子路径）", () => {
  it("curl 可用（本组是子进程真实第三方客户端，不是 Node fetch 冒充）", () => {
    expect(curlAvailable()).toBe(true);
  });

  it.each(FORMS)("%s: initialize -> 200 + serverInfo", async (form) => {
    const { target, pathname, label } = formOf(form);
    const r = await curlRpc(target, INIT_MESSAGE, stack.fx.pat.full.token, pathname);
    expect(r.status, `${label} 返回 ${r.status}: ${r.body.slice(0, 200)}`).toBe(200);
    const body = JSON.parse(r.body) as { result?: { serverInfo?: { name?: string }; protocolVersion?: string } };
    expect(body.result?.serverInfo?.name, label).toBe("gouxiangdb-mcp");
    expect(typeof body.result?.protocolVersion, label).toBe("string");
  });

  it.each(FORMS)("%s: tools/list + 读 call + 写 call（confirm + requestId）", async (form) => {
    const { target, pathname, label } = formOf(form);
    const list = await curlRpc(target, listMessage(), stack.fx.pat.full.token, pathname);
    expect(list.status, label).toBe(200);
    expect(list.body, label).toContain("ping_echo");

    // 读一发
    const call = await curlRpc(target, callMessage("ping_echo", { text: "hello" }), stack.fx.pat.full.token, pathname);
    expect(call.status, label).toBe(200);
    const got = rpcResult(call.body, label);
    expect(got.isError, label).toBe(false);
    expect(got.text, label).toBe("pong:hello");

    // 写实一发：record.create_record 必须带 confirm:true；requestId 走落库幂等（S7）。
    // 每形态用不同 requestId，避免跨形态同 key 重放。
    const write = await curlRpc(
      target,
      callMessage("record.create_record", {
        tableId: stack.fx.ids.tableId,
        fields: { [stack.fx.ids.fVisible]: `curl 写入 ${form}` },
        confirm: true,
        requestId: `curl-write-${form}`,
      }),
      stack.fx.pat.full.token,
      pathname,
    );
    expect(write.status, label).toBe(200);
    const wrote = rpcResult(write.body, label);
    expect(wrote.isError, `${label} 写失败：${wrote.text}`).toBe(false);
    expect(JSON.parse(wrote.text) as { ok: boolean; recordId?: string }, label).toMatchObject({ ok: true });
  });

  it.each(FORMS)("%s: 一次被拒调用（入参越界）-> 协议 -32602", async (form) => {
    const { target, pathname, label } = formOf(form);
    const r = await curlRpc(target, callMessage("ping_echo", { text: REJECTED_TEXT }), stack.fx.pat.full.token, pathname);
    expect(r.status, label).toBe(200); // MCP 协议错误不走 HTTP 4xx（§6 边缘口径）
    expect(r.body, label).toContain("-32602");
  });
});

describe("S8-A-2 官方 SDK StreamableHTTPClientTransport（同一真服务）", () => {
  it.each(FORMS)("%s: listTools + callTool + 被拒", async (form) => {
    const { target, pathname, label } = formOf(form);
    const conn = await openSdkClient(target, stack.fx.pat.full.token, pathname);
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools.map((t) => t.name).sort(), label).toContain("ping_echo");
      // schema 随工具一起下发（第三方 host 靠它构造参数）
      expect(tools.tools.every((t) => typeof t.inputSchema === "object"), label).toBe(true);

      const ok = await conn.client.callTool({ name: "ping_echo", arguments: { text: "sdk" } });
      expect((ok.content as Array<{ text?: string }>)[0]?.text, label).toBe("pong:sdk");
      expect(ok.isError ?? false, label).toBe(false);

      // 写实一发（confirm:true + requestId 幂等键），证明第三方 host 能完成破坏性写。
      const write = await conn.client.callTool({
        name: "record.create_record",
        arguments: {
          tableId: stack.fx.ids.tableId,
          fields: { [stack.fx.ids.fVisible]: `sdk 写入 ${form}` },
          confirm: true,
          requestId: `sdk-write-${form}`,
        },
      });
      const writeText = (write.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(write.isError ?? false, `${label} SDK 写失败：${writeText}`).toBe(false);
      expect(JSON.parse(writeText) as { ok: boolean }, label).toMatchObject({ ok: true });

      await rejectedViaSdk(conn.client, "ping_echo", { text: REJECTED_TEXT }, label);
    } finally {
      await conn.close();
    }
  });
});

describe("S8-A-3 stdio 第二入口（官方 StdioClientTransport 真 spawn）", () => {
  it("initialize / tools/list / tools/call 全通，工具集与 HTTP 同源（共用 buildServer）", async () => {
    const conn = await openStdioClient(stack.fx.pat.full.token);
    try {
      const names = (await conn.client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(expect.arrayContaining([
        "ping_echo", "table.list_bases", "record.create_record", "doc.append_blocks", "canvas.commit_elements",
      ]));
      const ok = await conn.client.callTool({ name: "ping_echo", arguments: { text: "stdio" } });
      expect((ok.content as Array<{ text?: string }>)[0]?.text).toBe("pong:stdio");

      await rejectedViaSdk(conn.client, "no.such_tool", {}, "stdio 直调不存在工具");
    } finally {
      await conn.close();
    }
  }, 120_000);
});

describe("S8-A-4 MCP Inspector CLI（固定版本；网络不允许则显式降级，绝不静默跳过）", () => {
  it(`npx @modelcontextprotocol/inspector@${INSPECTOR_VERSION} --cli --transport http tools/list`, async () => {
    const r = await runInspectorToolsList(`${stack.tcp.target.origin}/mcp`, stack.fx.pat.full.token);
    if (!r.ok) {
      // 允许的降级路径（派工单 §B-3）：结果写入 baseline 的【未自动化 + 原因】条目，由出口复核者人工补测。
      // 关键：本分支**不是通过**——它把"未自动化"显式播报，报告里必须如实写"未自动化"。
      console.warn(`[M6-S8][Inspector 未自动化] v${INSPECTOR_VERSION} —— ${r.reason}（耗时 ${r.elapsedMs}ms）`);
      expect(r.reason.length).toBeGreaterThan(0);
      return;
    }
    expect(r.tools).toContain("ping_echo");
    expect(r.tools).toContain("canvas.commit_elements");
    console.info(`[M6-S8] Inspector v${INSPECTOR_VERSION} 自动化成功：${r.tools.length} 个工具，耗时 ${r.elapsedMs}ms`);
  }, 240_000);
});

describe("S8-A-5 子路径与根同源可达（同一实例双挂载）", () => {
  it(`${BASE_PATH}/mcp 与 /mcp 均可 initialize 且均可调用工具`, async () => {
    const viaPrefix = await rpc(bp.target, INIT_MESSAGE, { token: stack.fx.pat.full.token, pathname: `${BASE_PATH}/mcp` });
    const viaRoot = await rpc(bp.target, INIT_MESSAGE, { token: stack.fx.pat.full.token, pathname: "/mcp" });
    expect(viaPrefix.status).toBe(200);
    expect(viaRoot.status).toBe(200);
    const called = await callTool(bp.target, stack.fx.pat.full.token, "ping_echo", { text: "p" }, { pathname: `${BASE_PATH}/mcp` });
    expect(called.text).toBe("pong:p");
  });
});
