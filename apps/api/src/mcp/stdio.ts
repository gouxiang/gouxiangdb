#!/usr/bin/env node
// M6/S6 stdio 第二入口（C-5 定稿：**只是文件，不起第二个常驻服务、不占端口、不碰 index.ts 监听**）。
//
// 用法：GX_MCP_TOKEN=<完整 PAT 明文> node dist/mcp-stdio.js
// 校验与 HTTP **同一套** authenticatePat("Bearer <token>")（§4.3 五态：前缀/查库/吊销/过期/停用）。
// 失败（缺失/为空/非法/不可用）一律 **退出码 2**（对外同表"token 不可用"，仅 stderr 文案区分原因）。
// 通过后由 PAT 记录构 McpSubject，用 StdioServerTransport + **同一个 buildServer** 起服务
// （工具/Resources 注册与 HTTP 共用一处，无第二份实现）。
//
// 通道纪律：stdout 只写 JSON-RPC（StdioServerTransport 独占）；一切诊断走 stderr，绝不污染协议流。

import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_AUDIT_CTX, emitAuthFailure } from "./audit.js";
import { PAT_PREFIX_DISPLAY_LEN, hasPatPrefix } from "./pat/tokens.js";
import { mcpPermissionPortFactory } from "./permissions/m4Adapter.js";
import { buildServer } from "./server.js";
import { authenticatePat } from "./transport/authenticate.js";

/** token 不可用（缺失/为空/非法/不可用）统一退出码。 */
export const EXIT_TOKEN_UNUSABLE = 2;

function fail(reason: string): never {
  process.stderr.write(`[gx-mcp-stdio] ${reason}\n`);
  process.exit(EXIT_TOKEN_UNUSABLE);
}

async function main(): Promise<void> {
  const raw = (process.env.GX_MCP_TOKEN ?? "").trim();
  if (raw === "") {
    fail("GX_MCP_TOKEN missing: 请在启动前设置完整 PAT 明文（gxpat_...）");
  }
  const auth = await authenticatePat(`Bearer ${raw}`);
  if (!auth.ok) {
    // S7：stdio 认证失败同样入审计（来源固定 stdio；只记明文前缀，绝不记完整 token）。
    emitAuthFailure({
      ctx: STDIO_AUDIT_CTX,
      reason: auth.reason,
      patPrefix: hasPatPrefix(raw) ? raw.slice(0, PAT_PREFIX_DISPLAY_LEN) : undefined,
    });
    fail(`GX_MCP_TOKEN invalid (${auth.reason}): token 不可用`);
  }
  // 与 HTTP 同构：每连接按主体构建权限端口（内部惰性预取一次 scope 复用）；审计来源固定 stdio。
  const server = await buildServer(auth.subject, {
    port: mcpPermissionPortFactory(auth.subject),
    audit: STDIO_AUDIT_CTX,
  });
  const transport = new StdioServerTransport();
  // 客户端关闭 stdin（管道 EOF）即视为会话结束，正常退出，避免残留进程。
  process.stdin.on("end", () => process.exit(0));
  await server.connect(transport); // connect 内部会 start()，开始读 stdin
}

void main().catch((err: unknown) => {
  process.stderr.write(`[gx-mcp-stdio] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
