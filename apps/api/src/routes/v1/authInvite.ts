// M2/S4 公开邀请接受端点：POST /api/v1/auth/invite/accept。
//
// 刻意【不挂】requireActiveUser（接受邀请发生在登录前，凭一次性激活码兑换 ACTIVE 与 JWT）。
// 作为独立 Hono 实例在 app.ts 的 GX_ENTERPRISE_ORG 条件块内挂到 /api/v1/auth/invite，
// 与受保护的 v1 实例平级、路径不重叠；bodyLimit/限流/安全头等全局中间件照常继承。

import { Hono } from "hono";
import { acceptInvite } from "../../domain/org/lifecycle.js";

export const inviteRoutes = new Hono();

inviteRoutes.post("/accept", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const result = await acceptInvite(body as { token: unknown; password: unknown; displayName?: unknown });
  return c.json(result, 200);
});
