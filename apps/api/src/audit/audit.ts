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
  | "avatar_delete"
  // M2 组织通讯录（只增；S6 接线，复用既有脱敏，不落邮箱外敏感信息）
  | "member_invited"
  | "member_activated"
  | "member_disabled"
  | "member_reactivated"
  | "department_created"
  | "department_moved"
  | "department_deleted"
  | "role_created"
  | "role_deleted"
  | "role_assignment_changed"
  // M3 导航对账脚本（--purge-broken 物理清理 broken 节点/shortcut，脚本侧主动留痕）
  | "nav_broken_purged"
  // M3/S6 导航编排（菜单写/分组/权威移动，全部需 manage_menu）
  | "menu_changed"
  | "nav_group_created"
  | "nav_group_deleted"
  | "nav_node_moved"
  // M4/S5 节点授权策略整单写（需 manage_share；detail 带 upserts/deletes 与前后 diff）
  | "policy_changed"
  // M4/S7 中断/恢复继承（需 manage_share；detail 带 from/to/失访或恢复人数）
  | "inheritance_changed"
  // M5/S9 统一检索管理面（仅 role_owner；detail 脱敏，绝不落 apiKey 明文/向量/查询词）
  | "search_reindex_started"
  | "search_reindex_done"
  | "search_reindex_failed"
  | "embedding_config_changed"
  | "embedding_api_key_rotated"
  | "embedding_api_key_cleared"
  // S12 状态降级跳变采样（S9 仅预留常量，不打点）
  | "search_degraded";

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
  // M5/S9 embedding 凭据（apiKey / api_key_cipher 等任何形态命中即脱敏）。
  "apikey",
  "api_key",
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
    console.error("[audit] 写入失败（不阻断业务）:", (e as Error).message);
  }
  return record;
}

function defaultAppend(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o640 });
}
