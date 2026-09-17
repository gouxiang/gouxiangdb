// M6/S4 record.search 的 domain 桥（C-7：薄封装 M5 searchService）。
//
// 为什么放在 domain 而非 mcp/**：M5 的查询运行时需要 prisma 客户端（buildQueryRuntime 的注入参数），
// 而 §3-3 规定 mcp/** 内不得出现 prisma（PAT 存储为唯一例外）。故在此做一层**极薄**的域内桥：
// 只负责组装运行时并调用 executeUnifiedSearch。
//
// 【P0-A 安全收窄】MCP 调用方必须显式传入该 PAT 的允许检索实体族 allowedEntityTypes（由 PAT 六位
// scope 推导）。scope 收敛只认「登录用户 r 授权」，并不知道 PAT 的 scope；若不收窄，一枚仅持
// record:read 的 PAT 会借 type:"all" 读到其在 M4 有 r、但 PAT 未授 doc/canvas 读的正文片段。
// 因此：
//   1) scope 层（安全闸）：把允许族映射成 nav resource kind 透传 resolveVisibleNodeIds(actions:r,kinds)，
//      不在 kind 内的族在 temp_scope 物化期即被排除（召回三路都 JOIN temp_scope）。
//   2) 输出层（纵深第二道）：再按允许类型过滤一次 items，即使召回混入也不吐正文。
// 非 MCP 调用不传 allowedEntityTypes -> undefined，行为与历史逐字节一致（全族）。

import { prisma } from "../db.js";
import { config } from "../config.js";
import { buildQueryRuntime } from "./search/queryRuntime.js";
import { executeUnifiedSearch } from "./search/query.js";
import type { SearchEntityType } from "./search/queryPlan.js";

export interface McpSearchResult {
  items: unknown[];
  total: number;
  mode: string;
  degraded: string[];
  scopeTruncated: boolean;
}

/** 检索实体类型 -> nav 资源 kind（record 族在 nav 里的资源类型是 table）。 */
const ENTITY_TYPE_TO_KIND: Readonly<Record<SearchEntityType, string>> = {
  record: "table",
  doc: "doc",
  canvas: "canvas",
};

/**
 * 执行一次统一检索（供 MCP record.search 调用）。异常由调用方转结构化错误。
 *
 * @param allowedEntityTypes 该 PAT 允许检索的实体族；**不得传 undefined/空数组表示「全族」**——
 *   调用方须在 PAT 无任何读族时 fail-closed 直接拒绝，不要走到这里。本函数对空数组同样按
 *   「零结果」处理（纵深防御，绝不回落成全族）。
 */
export async function runMcpUnifiedSearch(
  userId: string,
  q: string,
  mode: "auto" | "fts" | "vector",
  limit: number,
  allowedEntityTypes?: readonly SearchEntityType[],
): Promise<McpSearchResult> {
  // 显式允许族：scope 收窄到对应 nav kinds；type 仍传 "all"（向量 entityTypeCodes 含全族无妨，
  // 因为召回 JOIN temp_scope，scope 没有的族一行也匹配不上）。
  const narrowed = allowedEntityTypes !== undefined;
  const allowed = narrowed ? [...new Set(allowedEntityTypes)] : null;
  const scopeKinds = allowed ? allowed.map((t) => ENTITY_TYPE_TO_KIND[t]) : undefined;
  const allowedSet = allowed ? new Set<string>(allowed) : null;

  const { deps } = await buildQueryRuntime(userId, "all", {
    prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir, jwtSecret: config.jwtSecret,
    ...(scopeKinds ? { scopeKinds } : {}),
  });
  const res = await executeUnifiedSearch(deps, { q, type: "all", mode, limit }, false);
  // 纵深第二道：输出再按 PAT 允许族过滤（与 scope 闸双保险；零允许族 -> 零结果，不回落全族）。
  const items = allowedSet ? res.items.filter((it) => allowedSet.has(it.type)) : res.items;
  return {
    items: items as unknown[],
    total: narrowed ? items.length : res.total,
    mode: res.mode,
    degraded: res.degraded,
    scopeTruncated: res.scopeTruncated,
  };
}
