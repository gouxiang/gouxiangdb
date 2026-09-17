// M6/S4 record.search 的 domain 桥（C-7：薄封装 M5 searchService）。
//
// 为什么放在 domain 而非 mcp/**：M5 的查询运行时需要 prisma 客户端（buildQueryRuntime 的注入参数），
// 而 §3-3 规定 mcp/** 内不得出现 prisma（PAT 存储为唯一例外）。故在此做一层**极薄**的域内桥：
// 只负责组装运行时并调用 executeUnifiedSearch，**不含任何鉴权**（scope 先收敛由 M5 内部保证，
// MCP 侧只做 PAT 粗档，不重复鉴权 —— C-7 定稿）。

import { prisma } from "../db.js";
import { config } from "../config.js";
import { buildQueryRuntime } from "./search/queryRuntime.js";
import { executeUnifiedSearch } from "./search/query.js";

export interface McpSearchResult {
  items: unknown[];
  total: number;
  mode: string;
  degraded: string[];
  scopeTruncated: boolean;
}

/** 执行一次统一检索（供 MCP record.search 调用）。异常由调用方转结构化错误。 */
export async function runMcpUnifiedSearch(
  userId: string,
  q: string,
  mode: "auto" | "fts" | "vector",
  limit: number,
): Promise<McpSearchResult> {
  const { deps } = await buildQueryRuntime(userId, "all", {
    prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir, jwtSecret: config.jwtSecret,
  });
  const res = await executeUnifiedSearch(deps, { q, type: "all", mode, limit }, false);
  return {
    items: res.items as unknown[], total: res.total, mode: res.mode,
    degraded: res.degraded, scopeTruncated: res.scopeTruncated,
  };
}
