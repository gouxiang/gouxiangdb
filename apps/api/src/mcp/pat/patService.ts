// M6/S1 patService：PAT 创建 / 列表 / 吊销 + lastUsedAt 节流落库。
//
// 说明（M6-implementation-plan §4.3/§5.1/§5.2）：PAT 属"自身存储"，是 §3-3 明文允许直接访问
// prisma 的两处例外之一（另一处为审计）；**不涉任何资源授权**（资源判定归 M4，见 S3）。
//
// 写纪律：单行写走既有串行写队列 runWrite（计划原文的 `runSerialized` 在当前 HEAD 已更名为
// db.ts 的 runWrite/withWriteTx/withWriteBatch，见 docs/baseline/2026-09-18-m6-baseline.md §2-5）。
//
// 节流：lastUsedAt 进程内 Map 按 patId 节流 60s（同 token 60s 内多次使用只落库一次）。
// **不设定时器**（§3-10 零额外定时器纪律）——故为"节流写"而非"定时批量"。

import { prisma, runWrite } from "../../db.js";
import {
  expiresAtFromDays, generateToken, hashToken, parseScopes, serializeScopes,
  type PatScope,
} from "./tokens.js";

export interface CreatePatInput {
  name: string;
  scopes: PatScope[];
  /** 30/90/365/null（null=永不过期）；路由层已把缺省补成默认 90。 */
  expiresInDays: 30 | 90 | 365 | null;
}

/** 对外元数据（绝不含 token / tokenHash）。 */
export interface PatMetadata {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: PatScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toMetadata(row: {
  id: string; name: string; tokenPrefix: string; scopes: string;
  expiresAt: Date | null; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date;
}): PatMetadata {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: parseScopes(row.scopes),
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 创建一枚 PAT：返回元数据 + 明文（**明文仅此一次**，调用方只可回给创建响应，绝不入库/入日志）。
 */
export async function createPat(
  userId: string,
  input: CreatePatInput,
  now: Date = new Date(),
): Promise<{ pat: PatMetadata; plaintext: string }> {
  const { token, tokenPrefix, tokenHash } = generateToken();
  const expiresAt = expiresAtFromDays(input.expiresInDays, now);
  const row = await runWrite("mcp.pat.create", () =>
    prisma.personalAccessToken.create({
      data: {
        userId,
        name: input.name,
        tokenPrefix,
        tokenHash,
        scopes: serializeScopes(input.scopes),
        expiresAt,
      },
    }),
  );
  return { pat: toMetadata(row), plaintext: token };
}

/** 列表：本人全部 PAT（一次 findMany、按 createdAt desc；不 join 任何关系，防 N+1）。 */
export async function listPats(userId: string): Promise<PatMetadata[]> {
  const rows = await prisma.personalAccessToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, tokenPrefix: true, scopes: true,
      expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true,
    },
  });
  return rows.map(toMetadata);
}

/**
 * 吊销：**本人限定**（where 同时约束 id + userId，他人 patId 视为不存在）。
 * 已吊销行幂等（再次调用返回 false，不覆盖原 revokedAt）。
 * @returns 是否本次真正吊销（false = 不存在 / 非本人 / 已吊销）
 */
export async function revokePat(userId: string, patId: string, now: Date = new Date()): Promise<boolean> {
  return runWrite("mcp.pat.revoke", async () => {
    const res = await prisma.personalAccessToken.updateMany({
      where: { id: patId, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return res.count > 0;
  });
}

// ---------------------------------------------------------------------------
// lastUsedAt 节流（进程内 Map；60s 内同 patId 只落库一次）
// ---------------------------------------------------------------------------

const TOUCH_THROTTLE_MS = 60_000;
const lastFlushedAt = new Map<string, number>();

/**
 * 记录一次使用（认证成功路径调用）。节流 60s；失败只告警不抛出——**认证结果不因记账失败而改变**。
 * 调用方在 S2 认证边缘以 `void touchLastUsed(...)` 触发（不阻塞请求）。
 */
export async function touchLastUsed(patId: string, now: Date = new Date()): Promise<boolean> {
  const t = now.getTime();
  const prev = lastFlushedAt.get(patId);
  if (prev !== undefined && t - prev < TOUCH_THROTTLE_MS) return false;
  lastFlushedAt.set(patId, t);
  try {
    await runWrite("mcp.pat.touch", () =>
      prisma.personalAccessToken.update({ where: { id: patId }, data: { lastUsedAt: now } }),
    );
    return true;
  } catch (err) {
    console.error("[mcp-pat] lastUsedAt 写入失败（不阻断认证）:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** 仅供测试：清空节流记忆。 */
export function __resetLastUsedThrottle(): void {
  lastFlushedAt.clear();
}

/** 认证查库：按 tokenHash 等值点查（@unique）。查不到由调用方走 dummyHashCompare 抹平时序。 */
export async function findByTokenHash(tokenHash: string): Promise<{
  id: string; userId: string; scopes: string; revokedAt: Date | null; expiresAt: Date | null;
} | null> {
  return prisma.personalAccessToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, scopes: true, revokedAt: true, expiresAt: true },
  });
}

export { hashToken };
