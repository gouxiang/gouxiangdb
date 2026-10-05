// M6/S7 写工具 requestId 幂等（C-8 定稿：**落库** mcp_idempotency，不用进程内 Map）。
//
// 权威依据：M6-implementation-plan §242（键 = patId+tool+requestId，24h 去重窗，轻表只增，重启不丢）、
//           §409（同 requestId 重放返首次结果且只产生一次写）、§478（idempotency.ts）。
//
// 为什么**先占位再执行**（reserve-first）而不是"执行后再落库"：
//   若先执行后落库，两个并发同 key 请求会**都执行 handler**（各写一次库），随后才在落库时撞 PK——
//   写已经发生两次，违反"只产生一次写"。故：先以 PENDING 哨兵占位（PK 唯一约束即互斥锁），
//   占位成功者才执行 handler，执行完把响应写回占位行；占位失败者读回首次结果（绝不重复执行）。
//
// 窗口语义：createdAt 早于 now-24h 视为过期（可重放 → 覆盖占位行）。过期行不主动清理（表极小），
// runbook 给定期 DELETE；runbook 见 S9。
//
// 行操作一律经 runWrite（进程级串行写队列）：与业务写同队列，避免 SQLITE_BUSY 且语义可推理；
// 本模块只在 handler **之外**调用（占位/回填），不会与 handler 内的 withWriteTx 自死锁。

import { prisma, runWrite } from "../db.js";

/** 去重窗：24h（§242）。 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 占位哨兵：**不是合法 ToolResult JSON**（首字符 \u0000），故绝不可能与真实响应混淆。
 * 读到它表示"同 key 的首次调用正在执行中"。
 */
const PENDING = "\u0000PENDING";

/**
 * 幂等键：JSON 数组字符串化，**避免分隔符注入歧义**（若用 `a|b|c` 拼接，requestId 含 '|' 时
 * 不同 (patId,tool,requestId) 三元组可能碰撞到同一键——JSON 编码天然无歧义）。
 * 注：patId 为 cuid、tool 为固定目录名，requestId 上限 128 字符（schemas.ts 已限）。
 */
export function idempotencyKey(patId: string, tool: string, requestId: string): string {
  return JSON.stringify([patId, tool, requestId]);
}

function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= IDEMPOTENCY_TTL_MS;
}

type IdemReserve =
  /** 占位成功：调用方**独占**该 key，执行 handler 后必须 finalize 或 release。 */
  | { kind: "reserved" }
  /** 命中已完成的首调：直接返首次结果，**不得再执行 handler**。 */
  | { kind: "replay"; responseJson: string }
  /** 首调仍在执行中（真并发）：等待后仍未完成，调用方返结构化错误（绝不 500）。 */
  | { kind: "in_progress" };

/**
 * 尝试占位。命中未过期且已完成的占位行 -> replay；命中未完成的占位行 -> 轮询等待后仍未见结果 -> in_progress。
 * 未命中或已过期 -> 占位（过期行先删再插，避开 PK 冲突）。
 */
export async function reserveIdempotency(
  key: string,
  patId: string,
  tool: string,
  now: Date = new Date(),
): Promise<IdemReserve> {
  const existing = await prisma.mcpIdempotency.findUnique({ where: { key } });
  if (existing && !isExpired(existing.createdAt, now)) {
    if (existing.responseJson !== PENDING) return { kind: "replay", responseJson: existing.responseJson };
    return await waitForResult(key);
  }
  if (existing) {
    // 过期行：先删再插（PK 唯一；过期行已无价值）
    await runWrite("mcp.idempotency.expire", () => prisma.mcpIdempotency.deleteMany({ where: { key } }));
  }
  try {
    await runWrite("mcp.idempotency.reserve", () =>
      prisma.mcpIdempotency.create({ data: { key, patId, tool, responseJson: PENDING, createdAt: now } }),
    );
    return { kind: "reserved" };
  } catch {
    // PK 冲突（并发同 key 抢占）：读回；已完成 -> replay，仍 PENDING -> 轮询等待
    const row = await prisma.mcpIdempotency.findUnique({ where: { key } });
    if (row && row.responseJson !== PENDING) return { kind: "replay", responseJson: row.responseJson };
    return await waitForResult(key);
  }
}

/** 有界轮询等待首调回填响应（真并发场景）；超时返回 in_progress。 */
async function waitForResult(key: string, tries = 40, delayMs = 25): Promise<IdemReserve> {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const row = await prisma.mcpIdempotency.findUnique({ where: { key } });
    if (!row) return { kind: "reserved" }; // 首调已 release（异常/超时路径）-> 允许本次接管
    if (row.responseJson !== PENDING) return { kind: "replay", responseJson: row.responseJson };
  }
  return { kind: "in_progress" };
}

/** 回填首次结果（占位者执行完后调用）。行可能已被 release 删除，update 影响 0 行即忽略。 */
export async function finalizeIdempotency(key: string, responseJson: string): Promise<void> {
  await runWrite("mcp.idempotency.finalize", () =>
    prisma.mcpIdempotency.updateMany({ where: { key }, data: { responseJson } }),
  );
}

/** 释放占位（handler 抛异常或超时：**不**把非确定性结果固化为"首次结果"，允许后续重放重新执行）。 */
export async function releaseIdempotency(key: string): Promise<void> {
  await runWrite("mcp.idempotency.release", () => prisma.mcpIdempotency.deleteMany({ where: { key } }));
}
