// apps/api/src/config.ts
// 配置/环境启动闸门（fail-fast）。
// 铁律：本模块只能依赖 node 内置模块，且必须作为 index.ts 的第一行 side-effect import，
// 借 ESM 深度优先求值保证在 auth.ts → db.ts → @prisma/client（会自动 dotenv 加载 .env）
// 之前完成校验——堵住"prisma 自动加载 apps/api/.env 静默注入开发 JWT_SECRET"的绕过（D3）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type NodeEnv = "development" | "test" | "production";

// M5 统一检索总门（GX_M5_SEARCH 三态）真源在 configM5Search.ts；re-export 供
// import { ... } from "./config.js" 调用方使用，与 configAuthz 同款无感接线。
export type { M5SearchFlag } from "./configM5Search.js";
export { parseM5SearchFlag, parseM5ShadowStrict, parseSearchWorkerFlag } from "./configM5Search.js";
// 0.1.7 公开注册开关（GX_ALLOW_PUBLIC_SIGNUP）真源在 configSignup.ts（运行时 per-request 判定，
// 故导出的是纯函数而非启动期快照字段）；此处 re-export 供 import { ... } from "./config.js" 复用。
export { publicSignupOpen } from "./configSignup.js";
// 记录变更历史（数据日志）写入开关（GX_RECORD_CHANGES）真源在 configRecordChanges.ts：
// 同样是运行时函数而非启动期快照——写路径每次判定读 env，运维打开即生效、无需重启。
export { parseRecordChangesFlag, recordChangesEnabled } from "./configRecordChanges.js";
// 应用更新机制（第 2 章）配置真源在 configUpdate.ts（DESIGN §5.3）：纯函数解析 + 启动期快照。
export type { UpdateConfig, UpdateSourceKind } from "./configUpdate.js";
export { parseUpdateConfig, UPDATE_DEFAULTS } from "./configUpdate.js";
import { parseUpdateConfig, type UpdateConfig } from "./configUpdate.js";
import {
  parseM5SearchFlag, parseM5ShadowStrict, parseSearchWorkerFlag, type M5SearchFlag,
} from "./configM5Search.js";

// 历史上出现在源码/示例/.env 里的开发默认密钥，生产一律拒绝（即使 .env 被误打进发布包）。
const BLOCKED_JWT_SECRETS = new Set([
  "dev-secret-change-me-in-production",
  "dev-secret-change-in-prod-gouxiangdb-v2",
]);

const DEV_JWT_SECRET = "dev-secret-change-me-in-production";
const DEFAULT_PORT = 3001;
const DEFAULT_MIN_DISK_MB = 1024;
const DEFAULT_BODY_LIMIT_JSON_MB = 1;
const DEFAULT_BODY_LIMIT_UPLOAD_MB = 6;
// 附件上传档（/api/attachments）：默认 40MB。它是该端点【整包】请求体总闸
//（Hono bodyLimit 按 Content-Length 先拦，超限直接 413，不会缓冲进内存）。
// 注意：整包 ≠ 单文件。整包必须明显大于单文件上限，否则「一次传多个文件」会被
// multipart 边界开销先挤爆、用户选几张照片就 413。整包调 GX_BODY_LIMIT_ATTACHMENT（MB）；
// 调大时【必须】同步调大网关侧（Caddy request_body / 反代 client_max_body_size），
// 否则请求在到达应用前就被网关 413，报错还不是我们的中文信封。
const DEFAULT_BODY_LIMIT_ATTACHMENT_MB = 40;
// 附件【单文件】上限：默认 20MB，与整包档【分名】，由 GX_ATTACHMENT_MAX_FILE（MB）调。
// 二者必须分离：整包档是容量闸门（调大不影响校验语义），单文件档是给用户的明确错误
// 提示（「文件 xxx 超过 20MB 上限」）。若共用同一个值，调容量就会连带改掉提示口径。
const DEFAULT_ATTACHMENT_MAX_FILE_MB = 20;

interface ConfigIssue {
  variable: string;
  reason: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

/**
 * 纯函数：env 对象 → 问题列表。不读 process、不退出，便于单测。
 * test/development 一律放行（缺省回落开发值）；production fail-closed。
 */
export function validateEnv(env: NodeJS.ProcessEnv): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const prod = isProduction(env);
  if (!prod) return issues;

  if (env.NODE_ENV !== "production") {
    issues.push({ variable: "NODE_ENV", reason: "生产启动必须显式 NODE_ENV=production" });
  }

  const jwt = env.JWT_SECRET;
  if (!jwt || jwt.trim().length === 0) {
    issues.push({ variable: "JWT_SECRET", reason: "生产环境必填（至少 16 位随机字符串），开发默认值不可用于生产" });
  } else {
    if (jwt.length < 16) {
      issues.push({ variable: "JWT_SECRET", reason: `长度不足：当前 ${jwt.length} 位，要求至少 16 位` });
    }
    if (BLOCKED_JWT_SECRETS.has(jwt)) {
      issues.push({ variable: "JWT_SECRET", reason: "禁止使用源码内置的开发默认密钥" });
    }
  }

  const db = env.DATABASE_URL;
  if (!db || db.trim().length === 0) {
    issues.push({ variable: "DATABASE_URL", reason: "生产环境必填，形如 file:/var/lib/gouxiangdb/app.db" });
  } else if (!db.startsWith("file:")) {
    issues.push({ variable: "DATABASE_URL", reason: `仅支持 SQLite file: 连接串，当前为 "${db}"` });
  } else if (!path.isAbsolute(db.slice("file:".length))) {
    issues.push({ variable: "DATABASE_URL", reason: "生产环境必须使用绝对路径（发布后 cwd 不固定，相对路径会指错库）" });
  }

  const corsOrigin = env.CORS_ORIGIN ?? env.GX_PUBLIC_ORIGIN;
  if (!corsOrigin || corsOrigin.trim().length === 0) {
    issues.push({ variable: "CORS_ORIGIN", reason: "生产环境必填（逗号分隔的前端域名），禁止裸跨域放行" });
  }

  if (env.PORT !== undefined && env.PORT !== "") {
    const n = Number(env.PORT);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      issues.push({ variable: "PORT", reason: `非法端口："${env.PORT}"` });
    }
  }

  const minDisk = Number(env.GX_MIN_DISK_MB ?? DEFAULT_MIN_DISK_MB);
  if (!Number.isFinite(minDisk) || minDisk <= 0) {
    issues.push({ variable: "GX_MIN_DISK_MB", reason: `必须为正整数（MB），当前 "${env.GX_MIN_DISK_MB}"` });
  }

  for (const [name, raw] of [
    ["GX_BODY_LIMIT_JSON", env.GX_BODY_LIMIT_JSON],
    ["GX_BODY_LIMIT_UPLOAD", env.GX_BODY_LIMIT_UPLOAD],
    // M6/S2：/mcp 第三档（默认 11MB）；只增一档，/api 两档语义不变。
    ["GX_MCP_BODY_LIMIT", env.GX_MCP_BODY_LIMIT],
  ] as const) {
    if (raw !== undefined && raw !== "") {
      const mb = Number(raw);
      if (!Number.isFinite(mb) || mb <= 0) {
        issues.push({ variable: name, reason: `必须为正数（MB），当前 "${raw}"` });
      }
    }
  }

  for (const [name, raw] of [
    ["GX_MCP_RATE_WINDOW_SEC", env.GX_MCP_RATE_WINDOW_SEC],
    ["GX_MCP_RATE_PAT_MAX", env.GX_MCP_RATE_PAT_MAX],
    ["GX_MCP_RATE_IP_MAX", env.GX_MCP_RATE_IP_MAX],
    ["GX_MCP_RATE_PAT_REST_WINDOW_SEC", env.GX_MCP_RATE_PAT_REST_WINDOW_SEC],
    ["GX_MCP_RATE_PAT_REST_MAX", env.GX_MCP_RATE_PAT_REST_MAX],
  ] as const) {
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        issues.push({ variable: name, reason: `必须为正整数，当前 "${raw}"` });
      }
    }
  }

  const authTtlRaw = env.GX_AUTH_STATE_TTL_MS;
  if (authTtlRaw !== undefined && authTtlRaw !== "") {
    const n = Number(authTtlRaw);
    if (!Number.isInteger(n) || n < 0) {
      issues.push({ variable: "GX_AUTH_STATE_TTL_MS", reason: `必须为非负整数毫秒，当前 "${authTtlRaw}"` });
    }
  }

  return issues;
}

/**
 * 网关前缀归一（GX_BASE_PATH）：飞牛 fnOS 统一网关以 unix socket 转发时仍带
 * "/app/gouxiangdb" 前缀。规则：
 *   - 空/纯空白 → ""（仅根路径挂载，裸机/Docker 现状）
 *   - 必须以 "/" 开头，否则视为非法 → ""（fail-safe 回落根路径）
 *   - 去掉所有末尾斜杠（"/app/gx/" → "/app/gx"）
 *   - 根 "/" 归一为 ""（根挂载已覆盖，无需重复挂）
 *   - 拒绝路径穿越段 ".." 与 NUL，非法 → ""
 * 纯字符串归一、不碰文件系统（socket/basePath 均可用于相对临时路径测试）。
 */
export function normalizeBasePath(raw: string | undefined): string {
  const t = raw?.trim();
  if (!t || t === "/") return "";
  if (!t.startsWith("/")) return "";
  if (t.includes("..") || t.includes("\0")) return "";
  return t.replace(/\/+$/, "");
}

// 请求体上限环境变量按 MB（正整数）解释；非法值回退默认，生产侧另在 validateEnv 报错。
function parseBodyLimit(raw: string | undefined, fallbackBytes: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackBytes;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return fallbackBytes;
  return Math.round(mb * 1024 * 1024);
}

// 非负整数毫秒；缺省/空白/非法回退默认值（生产侧非法值另在 validateEnv 报错）。
function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function buildCorsPatterns(raw: string | undefined): RegExp[] {
  if (!raw) return [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`));
}

interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  jwtSecret: string;
  databaseUrl: string;
  port: number;
  corsOriginPatterns: RegExp[];
  dataDir: string;
  /**
   * 应用根目录（dist 上一级；开发=apps/api）。供原生扩展（vec0 native/<triplet>）解析 appDir，
   * 与 dataDir 分离：dataDir 是可写数据目录，appDir 是只读应用资源目录。
   */
  appDir: string;
  uploadRoot: string;
  migrationsDir: string;
  minDiskMb: number;
  bodyLimitJsonBytes: number;
  bodyLimitUploadBytes: number;
  /**
   * 附件上传档（GX_BODY_LIMIT_ATTACHMENT，默认 40MB）：/api/attachments 的 multipart
   * 【整包】请求体总闸。与头像档（bodyLimitUploadBytes）分名，互不影响。
   * 调大时必须同步调大网关侧请求体上限，否则请求先被网关 413。
   */
  bodyLimitAttachmentBytes: number;
  /**
   * 附件【单文件】上限（GX_ATTACHMENT_MAX_FILE，默认 20MB）。只用于路由内逐个文件的
   * 校验与错误提示，与整包档 bodyLimitAttachmentBytes 分离：调容量不改提示口径。
   * 约束：应恒 ≤ bodyLimitAttachmentBytes，否则中间件会先 413、业务提示永远走不到。
   */
  attachmentMaxFileBytes: number;
  /** M6/S2：/mcp 请求体上限（GX_MCP_BODY_LIMIT，默认 11MB）；/api 两档语义不变。 */
  mcpBodyLimitBytes: number;
  /** M6/S2 /mcp 限流：窗口秒 / patId 桶上限 / IP 预桶上限（C-1 默认 60/120/300）。 */
  mcpRateWindowMs: number;
  mcpRatePatMax: number;
  mcpRateIpMax: number;
  /** M6/S2 PAT REST 敏感档（§5.2：30 次/60s/人）；与 /mcp 桶分名避免歧义。 */
  mcpPatRestWindowMs: number;
  mcpPatRestMax: number;
  /**
   * M6/S7 单次 MCP 工具调用超时（GX_MCP_TOOL_TIMEOUT_MS，**默认 30000 = 30s**，SPEC §10 铁律）。
   * 在 mcp 适配层用 Promise.race 实现（不改 service 签名）；超时返结构化 TIMEOUT 并正常返回响应。
   */
  mcpToolTimeoutMs: number;
  auditDir: string;
  backupDir: string;
  rateLimitEnabled: boolean;
  /**
   * M2 企业组织管理面开关（GX_ENTERPRISE_ORG）：
   * on（默认，含 test）= 挂载 /api/v1 组织路由、启用工作区自举；
   * off = 不挂 /api/v1（请求 404，与未升级一致），组织表/列闲置，旧 /api 不受影响。
   */
  enterpriseOrg: boolean;
  /**
   * M3 统一导航资源树开关（GX_ENTERPRISE_NAV）：
   * on（默认，含 test）= 挂载 /api/v1/workspaces/current/tree|menu 读端点；
   * off = 这两个子路由 404（/api/v1 是否挂载由 enterpriseOrg || enterpriseNav 决定）。
   * 与 enterpriseOrg 正交：nav on / org off 时仅导航读可达，org 子路由仍 404。
   */
  enterpriseNav: boolean;
  /**
   * M5 统一检索总门（GX_M5_SEARCH），启动期解析的三态（parseM5SearchFlag，未知/大写回 off）：
   * off（默认）= 不挂 /api/v1/search、不起 indexer worker、不建 search.db 连接，旧 /api/search 不变；
   * shadow = 挂载路由，新链路对拍旧 /api/search（S7 起）；on = 新链路对外（S7 起）。
   */
  m5Search: M5SearchFlag;
  /**
   * GX_SEARCH_WORKER（计划 §4 R6 / M7 回滚面 R6）：内嵌索引 worker 排障开关。
   * 显式 "off" = 不起 worker（即便 m5Search=on；检索读路径与 outbox 写入均不受损，
   * 只是 change_events 积压待追平）；其余（含未设/"on"）= on。
   * 单独一个开关不够启动 worker：还须 m5Search === "on"（出厂默认 off，故默认零副作用）。
   */
  searchWorker: boolean;
  /**
   * GX_M5_SHADOW_STRICT（M5/S7，仅在 m5Search=shadow 时有意义）：严格小写 on 时，
   * 新链路与旧 /api/search 在可比集上对拍 drift 非 0 即让该请求失败（§6 对拍闸门）；
   * 默认 off，shadow 只记脱敏日志/metric，不改变响应。
   */
  m5ShadowStrict: boolean;
  /**
   * 鉴权状态缓存 TTL 毫秒（GX_AUTH_STATE_TTL_MS，默认 0=完全旁路零缓存，每请求一次 PK 点查，
   * 严格满足"停用后下一次请求即 401"）。>0 时启用进程内有界缓存，停用时同进程主动 invalidate。
   */
  authStateTtlMs: number;
  /**
   * 以下三项为【可选部署适配】（默认全空 = 与历史行为逐字节一致）：
   * - socketPath：非空时监听 unix socket（飞牛网关转发）而非 TCP。env GX_SOCKET_PATH。
   * - basePath：网关前缀（如 "/app/gouxiangdb"），同一路由单元同时挂根与该前缀。env GX_BASE_PATH。
   * - webDist：web vite 产物目录；仅当目录存在且含 index.html 才托管 SPA 静态。env GX_WEB_DIST。
   * 三者均不进入生产 fail-closed 必填校验。
   */
  socketPath: string;
  basePath: string;
  webDist: string;
  /**
   * 应用更新机制配置（DESIGN §5.3，全部可选适配，默认 on）：
   * 零轮询/零定时器/零后台出网，唯一出网发生在 owner 手动点「检查更新」瞬间；
   * 不配任何 GX_UPDATE_* 时不影响既有功能，off 时更新子路由不注册（404）。
   */
  update: UpdateConfig;
}

function buildConfig(env: NodeJS.ProcessEnv): AppConfig {
  const prod = isProduction(env);
  const dataDir = env.GX_DATA_DIR?.trim()
    || (prod ? "/var/lib/gouxiangdb" : apiRoot);
  const uploadRoot = env.UPLOAD_ROOT?.trim() || path.join(dataDir, "uploads");
  const migrationsDir = env.GX_MIGRATIONS_DIR?.trim()
    || path.resolve(apiRoot, "prisma/migrations");
  return {
    nodeEnv: (env.NODE_ENV === "production" || env.NODE_ENV === "test"
      ? env.NODE_ENV
      : "development") as NodeEnv,
    isProduction: prod,
    jwtSecret: env.JWT_SECRET || (prod ? "" : DEV_JWT_SECRET),
    databaseUrl: env.DATABASE_URL || "file:./dev.db",
    port: Number(env.PORT ?? DEFAULT_PORT),
    corsOriginPatterns: buildCorsPatterns(env.CORS_ORIGIN ?? env.GX_PUBLIC_ORIGIN),
    dataDir,
    appDir: apiRoot,
    uploadRoot,
    migrationsDir,
    minDiskMb: Number(env.GX_MIN_DISK_MB ?? DEFAULT_MIN_DISK_MB),
    bodyLimitJsonBytes: parseBodyLimit(
      env.GX_BODY_LIMIT_JSON,
      DEFAULT_BODY_LIMIT_JSON_MB * 1024 * 1024,
    ),
    mcpBodyLimitBytes: parseBodyLimit(env.GX_MCP_BODY_LIMIT, 11 * 1024 * 1024),
    mcpRateWindowMs: parseNonNegInt(env.GX_MCP_RATE_WINDOW_SEC, 60) * 1000,
    mcpRatePatMax: parseNonNegInt(env.GX_MCP_RATE_PAT_MAX, 120),
    mcpRateIpMax: parseNonNegInt(env.GX_MCP_RATE_IP_MAX, 300),
    mcpPatRestWindowMs: parseNonNegInt(env.GX_MCP_RATE_PAT_REST_WINDOW_SEC, 60) * 1000,
    mcpPatRestMax: parseNonNegInt(env.GX_MCP_RATE_PAT_REST_MAX, 30),
    // 30s 为 SPEC §10 铁律；env 只用于测试注入短超时，生产不得调大（超时是"不挂死连接"的保证）。
    mcpToolTimeoutMs: parseNonNegInt(env.GX_MCP_TOOL_TIMEOUT_MS, 30_000),
    bodyLimitUploadBytes: parseBodyLimit(
      env.GX_BODY_LIMIT_UPLOAD,
      DEFAULT_BODY_LIMIT_UPLOAD_MB * 1024 * 1024,
    ),
    bodyLimitAttachmentBytes: parseBodyLimit(
      env.GX_BODY_LIMIT_ATTACHMENT,
      DEFAULT_BODY_LIMIT_ATTACHMENT_MB * 1024 * 1024,
    ),
    attachmentMaxFileBytes: parseBodyLimit(
      env.GX_ATTACHMENT_MAX_FILE,
      DEFAULT_ATTACHMENT_MAX_FILE_MB * 1024 * 1024,
    ),
    auditDir: env.GX_AUDIT_DIR?.trim()
      || (prod ? "/var/log/gouxiangdb" : path.join(dataDir, ".audit")),
    backupDir: env.BACKUP_DIR?.trim()
      || (prod ? "/var/backups/gouxiangdb" : path.resolve(apiRoot, ".db-backups")),
    rateLimitEnabled: env.NODE_ENV === "test"
      ? env.GX_RATE_LIMIT === "on"
      : env.GX_RATE_LIMIT !== "off",
    // M2：组织管理面默认 on（test 亦默认 on，便于新测试直跑；显式 off 摘除 org 子路由）。
    enterpriseOrg: env.GX_ENTERPRISE_ORG !== "off",
    // M3：统一导航读默认 on（同纪律）；显式 off 摘除 tree/menu 子路由。
    enterpriseNav: env.GX_ENTERPRISE_NAV !== "off",
    // M5：统一检索默认 off（仅精确小写 shadow/on 生效，见 parseM5SearchFlag）；off 不挂 v1 search。
    m5Search: parseM5SearchFlag(env.GX_M5_SEARCH),
    // M5/S7：shadow 对拍严格门（仅精确小写 on），默认 off 只记日志不改变响应。
    m5ShadowStrict: parseM5ShadowStrict(env.GX_M5_SHADOW_STRICT),
    // M7 R6：内嵌索引 worker 排障开关（显式 off 才关）；是否真起由 workerRuntime 与
    // m5Search==="on" 合取决定（出厂 m5Search=off，故默认不起 worker、不建 search.db）。
    searchWorker: parseSearchWorkerFlag(env.GX_SEARCH_WORKER),
    authStateTtlMs: parseNonNegInt(env.GX_AUTH_STATE_TTL_MS, 0),
    socketPath: env.GX_SOCKET_PATH?.trim() ?? "",
    basePath: normalizeBasePath(env.GX_BASE_PATH),
    webDist: env.GX_WEB_DIST?.trim() ?? "",
    update: parseUpdateConfig(env).config,
  };
}

function formatIssues(issues: ConfigIssue[]): string {
  const lines = [
    "[config] 启动配置校验失败，服务拒绝启动（退出码 2）：",
    ...issues.map((i) => `  - ${i.variable}: ${i.reason}`),
    "请通过环境变量或 systemd EnvironmentFile 提供合法配置；.env 仅用于本地开发且不进发布包。",
  ];
  return lines.join("\n");
}

// —— 顶层闸门：本模块被 import 的瞬间即校验（先于任何 prisma 求值）——
const startupIssues = validateEnv(process.env);
if (startupIssues.length > 0) {
  console.error(formatIssues(startupIssues));
  process.exit(2);
}

const resolved = buildConfig(process.env);

// 更新机制配置的非致命问题（非法回退默认）只 warn、绝不退出；与迁移目录缺失同款。
// parseUpdateConfig 是纯函数，此处再算一次仅为取 warnings（buildConfig 内已取 config）。
for (const w of parseUpdateConfig(process.env).warnings) {
  console.warn(`[config] ${w}`);
}

// 迁移目录缺失不阻断启动（只读提示）；readyz 探针会给出权威失败结论。
if (!fs.existsSync(resolved.migrationsDir)) {
  console.warn(`[config] 迁移目录不存在：${resolved.migrationsDir}`);
}
// 单文件上限不该大于整包档：否则超大文件会先被 bodyLimit 以 413 拦下，
// 路由内「文件 xxx 超过 N MB 上限」的中文提示永远走不到（只提示不拦截，配置错也不至于起不来）。
if (resolved.attachmentMaxFileBytes > resolved.bodyLimitAttachmentBytes) {
  console.warn(
    `[config] 附件单文件上限（${(resolved.attachmentMaxFileBytes / 1024 / 1024).toFixed(0)}MB）` +
      `大于整包档（${(resolved.bodyLimitAttachmentBytes / 1024 / 1024).toFixed(0)}MB）：` +
      `请调大 GX_BODY_LIMIT_ATTACHMENT 或调小 GX_ATTACHMENT_MAX_FILE。`,
  );
}

export const config: AppConfig = Object.freeze(resolved);
