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
  // 企业化定位：管理员删除成员账号（需 delete_users，物理删除不可恢复）
  | "member_deleted"
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
  // 嵌入连通性自检（只探活不落库；detail 只带 ok/耗时/失败类别，绝不落密钥）
  | "embedding_connection_tested"
  // S12 状态降级跳变采样（S9 仅预留常量，不打点）
  | "search_degraded"
  // M6/S1 鉴权 MCP 服务：PAT 生命周期（S1 起接线；S7 补 mcp_* 工具调用/认证失败两枚）
  | "mcp_pat_create"
  | "mcp_pat_revoke"
  // M6/S7 鉴权 MCP 服务调用面（§409）：每次 tools/call 收尾必记（成功/被拒/未注册工具同记，
  // resultCode 区分）；认证失败单独一枚（ip/patPrefix 级，绝不记完整 token）。
  | "mcp_tool_call"
  | "mcp_auth_failure"
  // 首次部署超级管理员初始化（deploy 链路 init-admin 脚本在迁移后创建首个 ACTIVE 用户 +
  // 系统 owner 授予，并置 mustChangePassword=true 强制首登改密）。detail 绝不落初始密码。
  | "admin_initialized"
  // 0.1.7 管理员口令重置（init-admin --reset）：按邮箱重置既有账号口令并置强制改密 +
  // 恢复 ACTIVE + tokenVersion+1 踢掉旧会话。detail 只落脱敏邮箱与版本号，绝不落新密码。
  | "admin_password_reset"
  // 分享链接生命周期（对象化分享：base/table/kb_doc）。
  // 创建时带 objectType/objectId/mode；mode=edit 的创建意味着放行了一条外部写通道，必须留痕。
  | "share_link_created"
  | "share_link_revoked"
  // 外部访问者（无登录态）经分享链接的写入：成功记 share_external_write，
  // 被档位/权限/字段闸拒绝记 share_external_denied。detail 记 action 与字段 id，绝不记 token。
  | "share_external_write"
  | "share_external_denied"
  // R2 附件外置：服务端上传/删除（detail 只带 id/bytes/mime 等元数据，绝不落文件内容）。
  // 删除被「仍被记录引用」挡下时同样记 attachment_delete，status=409。
  | "attachment_upload"
  | "attachment_delete"
  // 应用版本更新（owner 手动触发；detail 只带通道/版本/裁决/源种类/耗时，
  // 绝不含 url、GX_UPDATE_TOKEN、Authorization，见 update DESIGN §5.5）。
  | "update_checked"
  | "update_downloaded"
  // 应用更新【后台预缓存】（方案 A；owner 触发。detail 只带 channel/version/arch/platform/
  // filename/sha256/state/bytes?/errorCode?，绝不含 url、GX_UPDATE_TOKEN、Authorization）。
  // started：POST /update/prefetch 已受理（同步记）；completed：后台分块拉取并校验落地成功；
  // failed：后台拉取失败（带稳定 PREFETCH_* errorCode，断点保留可续传）。
  | "update_prefetch_started"
  | "update_prefetch_completed"
  | "update_prefetch_failed";

interface AuditInput {
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
