// apps/api/src/collab/tickets.ts
// 一次性连接票据：浏览器 new WebSocket() 带不了自定义头，故把登录凭据换成 60s 短票走 ?t=
// （DESIGN §4.1 方案 C）。短票只在内存里，不落库、不进业务日志（nginx 侧另关 access_log）。
//
// 单次核销：核销即删除，同一张票第二次使用必然 4401。惰性清理过期货（核销时顺带 sweep），
// 不额外起定时器——票据表的生命周期跟连接握手一样短，定时器只会带来常驻开销。

import { randomBytes } from "node:crypto";
import type { CollabRole, CollabSubjectKind } from "@gx/shared-types";

/** 票据有效期（§4.1：60s）。 */
const TICKET_TTL_MS = 60_000;

export interface CollabTicketPayload {
  /** 票据只对这一个房间有效（防跨房复用）。 */
  roomId: string;
  /** 登录用户为 userId；阶段 5 的匿名访客为 null（由 shareToken 侧主体补位）。 */
  userId: string | null;
  subject: CollabSubjectKind;
  role: CollabRole;
  /** 服务端下发的展示名与配色，客户端不得自行生成。 */
  nick: string;
  color: string;
}

interface TicketRecord {
  payload: CollabTicketPayload;
  expiresAt: number;
}

const tickets = new Map<string, TicketRecord>();

/** 惰性清理：删除所有已过期票据（在 issue/redeem 时顺带跑，成本 O(表长) 但表恒很小）。 */
function sweep(now: number): void {
  for (const [key, rec] of tickets) {
    // 已过期即失效；多留 1s 余量避免"签发即判过期"的边界抖动。
    if (rec.expiresAt <= now) tickets.delete(key);
  }
}

/** 签发票据：192bit CSPRNG，base64url 32 字符（与 share token 同一编码口径）。 */
export function issueTicket(payload: CollabTicketPayload): { ticket: string; expiresAt: number } {
  const now = Date.now();
  sweep(now);
  const ticket = randomBytes(24).toString("base64url");
  const expiresAt = now + TICKET_TTL_MS;
  tickets.set(ticket, { payload, expiresAt });
  return { ticket, expiresAt };
}

/** 核销票据：成功返回载荷并立即删除该票（单次核销）；无效/已用/过期返回 null。 */
export function redeemTicket(ticket: string): CollabTicketPayload | null {
  if (!ticket) return null;
  const rec = tickets.get(ticket);
  if (!rec) return null;
  tickets.delete(ticket);
  const now = Date.now();
  sweep(now);
  return rec.expiresAt > now ? rec.payload : null;
}
