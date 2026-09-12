// apps/api/src/audit/audit.ts
// 安全事件审计：零依赖 JSONL（每行一条 JSON），append 到 $GX_AUDIT_DIR/audit.logl。
// 轮换交给 logrotate copytruncate（deploy/logrotate）。
// 铁律：绝不落 password/token/Authorization/bearer/secret 明文——detail 内敏感键在写入前脱敏。

import fs from "node:fs";
import path from "node:path";

export type AuditEventName =
  | "login_success"
  | "login_failure"
  | "signup"
  | "change_password"
  | "account_delete"
  | "avatar_delete";

export interface AuditInput {
  event: AuditEventName;
  actorId?: string | null;
  ip?: string;
  method?: string;
  path?: string;
  status: number;
  detail?: Record<string, unknown>;
}

export interface AuditRecord {
  ts: string;
  event: AuditEventName;
  actorId: string | null;
  ip: string;
  method: string;
  path: string;
  status: number;
  detail: Record<string, unknown>;
}

// 命中即脱敏的键名片段（小写子串匹配），覆盖常见凭据命名。
const SENSITIVE_PARTS = [
  "password",
  "passwd",
  "token",
  "secret",
  "authorization",
  "bearer",
  "jwt",
  "cookie",
];

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_PARTS.some((part) => k.includes(part));
}

// 递归脱敏：对象/数组内敏感键替换为 [REDACTED]；非纯数据（函数/Symbol/大对象）不入日志。
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[DEPTH]";
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") return String(value);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactSecrets(v, depth + 1);
    }
  }
  return out;
}

// 纯函数：组装一条审计记录（ISO 时间、缺省字段补齐、detail 脱敏）。
export function formatAuditEvent(input: AuditInput, now: Date = new Date()): AuditRecord {
  return {
    ts: now.toISOString(),
    event: input.event,
    actorId: input.actorId ?? null,
    ip: input.ip || "unknown",
    method: (input.method || "").toUpperCase(),
    path: input.path || "",
    status: input.status,
    detail: (input.detail
      ? (redactSecrets(input.detail) as Record<string, unknown>)
      : {}),
  };
}

// 序列化为单行 JSON（JSONL 一行一条）。
export function serializeAuditRecord(record: AuditRecord): string {
  return JSON.stringify(record);
}

// 追加写：目录缺失自动建；任何 IO 失败只告警不阻断业务（审计不拖垮主流程）。
export function writeAudit(
  auditDir: string,
  input: AuditInput,
  sink: (file: string, line: string) => void = defaultAppend,
): AuditRecord {
  const record = formatAuditEvent(input);
  const line = serializeAuditRecord(record);
  try {
    sink(path.join(auditDir, "audit.logl"), `${line}\n`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[audit] 写入失败（不阻断业务）:", (e as Error).message);
  }
  return record;
}

function defaultAppend(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o640 });
}
