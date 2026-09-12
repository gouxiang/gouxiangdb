// apps/api/src/config.ts
// 配置/环境启动闸门（fail-fast）。
// 铁律：本模块只能依赖 node 内置模块，且必须作为 index.ts 的第一行 side-effect import，
// 借 ESM 深度优先求值保证在 auth.ts → db.ts → @prisma/client（会自动 dotenv 加载 .env）
// 之前完成校验——堵住"prisma 自动加载 apps/api/.env 静默注入开发 JWT_SECRET"的绕过（D3）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type NodeEnv = "development" | "test" | "production";

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

export interface ConfigIssue {
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
  ] as const) {
    if (raw !== undefined && raw !== "") {
      const mb = Number(raw);
      if (!Number.isFinite(mb) || mb <= 0) {
        issues.push({ variable: name, reason: `必须为正数（MB），当前 "${raw}"` });
      }
    }
  }

  return issues;
}

// 请求体上限环境变量按 MB（正整数）解释；非法值回退默认，生产侧另在 validateEnv 报错。
function parseBodyLimit(raw: string | undefined, fallbackBytes: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackBytes;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return fallbackBytes;
  return Math.round(mb * 1024 * 1024);
}

function buildCorsPatterns(raw: string | undefined): RegExp[] {
  if (!raw) return [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`));
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  jwtSecret: string;
  databaseUrl: string;
  port: number;
  corsOriginPatterns: RegExp[];
  dataDir: string;
  uploadRoot: string;
  migrationsDir: string;
  minDiskMb: number;
  bodyLimitJsonBytes: number;
  bodyLimitUploadBytes: number;
  auditDir: string;
  backupDir: string;
  rateLimitEnabled: boolean;
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
    uploadRoot,
    migrationsDir,
    minDiskMb: Number(env.GX_MIN_DISK_MB ?? DEFAULT_MIN_DISK_MB),
    bodyLimitJsonBytes: parseBodyLimit(
      env.GX_BODY_LIMIT_JSON,
      DEFAULT_BODY_LIMIT_JSON_MB * 1024 * 1024,
    ),
    bodyLimitUploadBytes: parseBodyLimit(
      env.GX_BODY_LIMIT_UPLOAD,
      DEFAULT_BODY_LIMIT_UPLOAD_MB * 1024 * 1024,
    ),
    auditDir: env.GX_AUDIT_DIR?.trim()
      || (prod ? "/var/log/gouxiangdb" : path.join(dataDir, ".audit")),
    backupDir: env.BACKUP_DIR?.trim()
      || (prod ? "/var/backups/gouxiangdb" : path.resolve(apiRoot, ".db-backups")),
    rateLimitEnabled: env.NODE_ENV === "test"
      ? env.GX_RATE_LIMIT === "on"
      : env.GX_RATE_LIMIT !== "off",
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

// 迁移目录缺失不阻断启动（只读提示）；readyz 探针会给出权威失败结论。
if (!fs.existsSync(resolved.migrationsDir)) {
  console.warn(`[config] 迁移目录不存在：${resolved.migrationsDir}`);
}

export const config: AppConfig = Object.freeze(resolved);
