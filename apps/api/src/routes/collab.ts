// apps/api/src/routes/collab.ts
// 协同的两个 HTTP 端点：换连接票据、取在线名单快照。
//
//   GET /api/collab/ticket?roomId=<kind>:<objectId>   → 一次性 60s 短票（单次核销）
//   GET /api/collab/presence?roomId=                  → 在线名单（WS 未连上时的首屏兜底）
//
// 浏览器 new WebSocket() 带不了自定义头（DESIGN §4.1），所以 WS 鉴权走「HTTP 换短票」：
// 本端点仍在既有 X-GX-Token 链上，权限判定走既有唯一出口 requireDocAccess，不新造口径。
// **匿名/分享票据在阶段 5 才做**（§9 阶段 5），本阶段不实现访客主体。

import { Hono } from "hono";
import type { CollabPresenceSnapshot, CollabRole, CollabTicketResponse } from "@gx/shared-types";
import { parseCollabRoomId } from "@gx/shared-types";
import { prisma } from "../db.js";
import { errorResponse, HttpError, requireUserId } from "../guards.js";
import { requireDocAccess } from "./kb/shared.js";
import { config } from "../config.js";
import { colorForId } from "../collab/presence.js";
import { issueTicket } from "../collab/tickets.js";
import { getRoomPresence } from "../collab/index.js";

export const collab = new Hono();

/** 解析并校验 roomId；不合法一律 400（不泄漏对象是否存在）。 */
function requireRoomId(raw: string | undefined): { roomId: string; objectId: string } {
  const roomId = (raw ?? "").trim();
  const ref = parseCollabRoomId(roomId);
  if (!ref) {
    throw new HttpError(400, "roomId 非法：应为 <kind>:<objectId>，kind ∈ doc|canvas|table");
  }
  // 阶段 1 只服务文档与画布；数据表协同在**阶段 3** 接入（房间模型与按行收口一起做，
  // 见 DESIGN §9 阶段 3）——现在不做，故此处显式 400 而不是静默放行。
  if (ref.kind === "table") {
    throw new HttpError(400, "数据表协同在阶段 3 接入，当前未开放");
  }
  return { roomId, objectId: ref.objectId };
}

/** 可读即可连；再试一次可写，403 说明是只读档位（viewer），其余错误原样抛。 */
async function resolveRole(userId: string, objectId: string): Promise<CollabRole> {
  await requireDocAccess(userId, objectId, false);
  try {
    await requireDocAccess(userId, objectId, true);
    return "editor";
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) return "viewer";
    throw e;
  }
}

collab.get("/ticket", async (c) => {
  try {
    const userId = await requireUserId(c);
    const { roomId, objectId } = requireRoomId(c.req.query("roomId"));
    const role = await resolveRole(userId, objectId);
    // 昵称取 users 表的展示名（schema.prisma:200 model User.displayName）。
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    const nick = user?.displayName?.trim() || "协作者";
    // 配色由服务端按 userId 确定性哈希到调色板：同一人每次进来颜色一致（§5.1）。
    const color = colorForId(userId);
    const issued = issueTicket({
      roomId,
      userId,
      subject: "user",
      role,
      nick,
      color,
    });
    const body: CollabTicketResponse = {
      ticket: issued.ticket,
      roomId,
      expiresAt: issued.expiresAt,
      role,
      kind: "user",
      // 阶段 1 只有登录用户主体，故恒为当前 userId（访客为 null 是阶段 5 的事，§9）。
      // attach.ts 建连接时读 payload.userId；presence 也以服务端下发的这个为准，不信客户端自报。
      userId,
      nick,
      color,
      wsPath: `${config.basePath}/ws/collab/${encodeURIComponent(roomId)}`,
      serverTime: Date.now(),
    };
    return c.json(body);
  } catch (e) {
    return errorResponse(c, e);
  }
});

collab.get("/presence", async (c) => {
  try {
    const userId = await requireUserId(c);
    const { roomId, objectId } = requireRoomId(c.req.query("roomId"));
    await requireDocAccess(userId, objectId, false);
    const body: CollabPresenceSnapshot = {
      roomId,
      entries: getRoomPresence(roomId),
      serverTime: Date.now(),
    };
    return c.json(body);
  } catch (e) {
    return errorResponse(c, e);
  }
});
