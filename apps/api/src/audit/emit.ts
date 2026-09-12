// apps/api/src/audit/emit.ts
// 从 Hono 上下文发一条安全审计：自动填来源 IP、方法、路径，业务只给 event/status/actorId/detail。

import type { Context } from "hono";
import { config } from "../config.js";
import { sourceIp } from "../utils/client-ip.js";
import { writeAudit, type AuditEventName } from "./audit.js";

export interface EmitAudit {
  event: AuditEventName;
  status: number;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

export function audit(c: Context, input: EmitAudit): void {
  writeAudit(config.auditDir, {
    event: input.event,
    actorId: input.actorId ?? null,
    ip: sourceIp(c),
    method: c.req.method,
    path: c.req.path,
    status: input.status,
    // 只允许显式传入的 detail；脱敏在 writeAudit 内统一做。
    detail: input.detail,
  });
}
