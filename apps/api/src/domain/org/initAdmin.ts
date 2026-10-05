// apps/api/src/domain/org/initAdmin.ts
// 首次部署超级管理员初始化【领域层】：凭据解析（纯函数）+ 幂等判定 + 单事务建号 +
// 系统 owner 授予。CLI 外壳在 scripts/init-admin.ts（产物 dist/init-admin.js）。
//
// 分工：本模块只回答"该不该建、怎么建、建了什么"，不碰 process.argv/process.exit/日志文案/
// 审计落盘；但把"哪些情况该退 64、哪些该退 1"固化在 InitAdminError.exitCode 上，
// 使外壳无需再判一遍业务语义。
//
// 与运行时写原语 withWriteTx 的区别：这是独立 CLI 进程（无并发写、无请求上下文），
// 直接用 prisma 交互事务，不入写队列；校验失败/库未迁移一律抛 InitAdminError。
//
// 幂等语义（与 docs/deployment/first-admin-init.md §2 一致）：users 表已有任何用户即跳过，
// 不按"已有 owner"判定——否则会与 members.bootstrapFirstOwnerTx 的首个注册者抢跑出第二个 owner。

import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../db.js";
import { OWNER_ROLE_ID } from "./roles.js";
import { DEFAULT_WORKSPACE_ID } from "./workspace.js";
import { USER_STATUS } from "./authState.js";
import { BCRYPT_ROUNDS } from "./members.js";

/** 交给 init-admin 的凭据（已归一化：邮箱小写去空格）。 */
interface InitAdminInput {
  email: string;
  password: string;
  displayName: string;
}

export interface InitAdminResult {
  status: "created" | "skipped";
  userId?: string;
  email?: string;
  reason?: string;
}

/** 解析成功：input 可直接交给 initAdmin；source 用于外壳诚实打印凭据来源。 */
interface InitAdminCredentialsResolved {
  ok: true;
  input: InitAdminInput;
  source: {
    email: CredentialSource;
    password: CredentialSource;
    displayName: CredentialSource;
  };
}

/** 解析失败：调用方据此 exit 64（用法/环境变量缺失）。 */
interface InitAdminCredentialsMissing {
  ok: false;
  missing: string[];
  reason: string;
}

type InitAdminCredentials =
  | InitAdminCredentialsResolved
  | InitAdminCredentialsMissing;

export type CredentialSource = "argv" | "env" | "default";

/** 事务/查询客户端：需支持交互事务，故限定 PrismaClient（不是 DbTx）。 */
type InitAdminClient = PrismaClient;

/** 本地默认值：仅 NODE_ENV !== "production" 时可用，生产用即视为配置缺失（exit 64）。 */
const INIT_ADMIN_DEFAULT_EMAIL = "admin@gouxiang.local";
const INIT_ADMIN_DEFAULT_PASSWORD = "admin12345";
const INIT_ADMIN_DEFAULT_NAME = "超级管理员";

/** 授予行 createdBy 锚点：与运行时自举 "system-signup-bootstrap" 区分，审计可追溯来源。 */
const INIT_ADMIN_CREATED_BY = "system-init-admin";

// 与 members.ts:138 isValidEmail 同一口径（不重复发明正则，也不把成员内部函数提为公共 API）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 与 auth.ts change-password（min 8 / max 72）一致：8 位是下限，72 字节是 bcrypt 硬上限。
const INIT_ADMIN_PASSWORD_MIN = 8;
const INIT_ADMIN_PASSWORD_MAX = 72;

/** 初始化失败的统一错误：exitCode 供 CLI 外壳直接采用（64=用法/凭据，1=执行失败）。 */
export class InitAdminError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = 1) {
    super(message);
    this.name = "InitAdminError";
    this.exitCode = exitCode;
  }
}

/** 邮箱脱敏：保留首字符与域名（a***@example.com），审计/日志一律用它，绝不落完整邮箱。 */
export function maskInitAdminEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

export function validateEmail(email: string): string | null {
  if (!EMAIL_RE.test(email)) {
    return `邮箱格式不正确：${maskInitAdminEmail(email)}（期望形如 admin@example.com）`;
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < INIT_ADMIN_PASSWORD_MIN || password.length > INIT_ADMIN_PASSWORD_MAX) {
    return `初始密码长度须在 ${INIT_ADMIN_PASSWORD_MIN}-${INIT_ADMIN_PASSWORD_MAX} 之间（bcrypt 72 字节上限），当前 ${password.length}`;
  }
  return null;
}

// 以下三个内部件在 initAdminReset.ts（--reset 领域层）复用，故导出：
// 邮箱/口令口径必须单一真源（members.ts:138 正则同源、auth.ts change-password 长度同源），
// readArg 的参数写法（--email x 与 --email=x）也必须一致，否则 CLI 两侧行为会分叉。

/** 读命令行参数：同时支持 "--email x" 与 "--email=x"；空值视为未提供。 */
export function readArg(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === flag) {
      const next = argv[i + 1];
      return typeof next === "string" && !next.startsWith("--") ? next : undefined;
    }
    if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** 优先级：命令行参数 > 环境变量 > 本地默认值（默认值仅非 production 可用）。 */
function pick(
  fromArgv: string | undefined,
  fromEnv: string | undefined,
  fallback: string | undefined,
): { value: string | undefined; source: CredentialSource } {
  if (typeof fromArgv === "string" && fromArgv.trim() !== "") {
    return { value: fromArgv.trim(), source: "argv" };
  }
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { value: fromEnv.trim(), source: "env" };
  }
  if (typeof fallback === "string") return { value: fallback, source: "default" };
  return { value: undefined, source: "default" };
}

/**
 * 解析管理员凭据（纯函数，可直接单测）。
 *
 * 生产环境（NODE_ENV=production）缺 email 或 password → ok:false，调用方 exit 64：
 * 绝不在生产回落到默认口令，也绝不硬编码真实凭据。
 * displayName 恒有兜底（缺省「超级管理员」），不参与"缺失"判定。
 */
export function resolveInitAdminCredentials(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): InitAdminCredentials {
  const isProd = env.NODE_ENV === "production";
  const email = pick(
    readArg(argv, "--email"),
    env.GX_INIT_ADMIN_EMAIL,
    isProd ? undefined : INIT_ADMIN_DEFAULT_EMAIL,
  );
  const password = pick(
    readArg(argv, "--password"),
    env.GX_INIT_ADMIN_PASSWORD,
    isProd ? undefined : INIT_ADMIN_DEFAULT_PASSWORD,
  );
  const displayName = pick(
    readArg(argv, "--name"),
    env.GX_INIT_ADMIN_NAME,
    INIT_ADMIN_DEFAULT_NAME,
  );

  const emailRaw = email.value;
  const passwordRaw = password.value;
  const missing: string[] = [];
  if (!emailRaw) missing.push("email");
  if (!passwordRaw) missing.push("password");
  if (missing.length > 0 || !emailRaw || !passwordRaw) {
    const how = isProd
      ? "生产环境（NODE_ENV=production）必须显式提供，禁止使用内置默认口令"
      : "请提供";
    return {
      ok: false,
      missing,
      reason: `缺少管理员凭据（${missing.join("、")}）：${how} --email/--password 或 GX_INIT_ADMIN_EMAIL/GX_INIT_ADMIN_PASSWORD；--name/GX_INIT_ADMIN_NAME 可选`,
    };
  }

  const emailErr = validateEmail(emailRaw);
  if (emailErr) return { ok: false, missing: ["email"], reason: emailErr };
  const pwdErr = validatePassword(passwordRaw);
  if (pwdErr) return { ok: false, missing: ["password"], reason: pwdErr };

  return {
    ok: true,
    input: {
      email: emailRaw,
      password: passwordRaw,
      displayName: displayName.value ?? INIT_ADMIN_DEFAULT_NAME,
    },
    source: { email: email.source, password: password.source, displayName: displayName.source },
  };
}

/** Prisma 错误 → 中文可读错误；表不存在明确指向"迁移没跑"。--reset 复用同一套映射。 */
export function toInitError(e: unknown, stage: string): InitAdminError {
  const code = typeof e === "object" && e !== null && "code" in e
    ? String((e as { code?: unknown }).code)
    : "";
  const message = e instanceof Error ? e.message : String(e);
  if (code === "P2002" || message.includes("UNIQUE constraint failed")) {
    return new InitAdminError(`该邮箱已被使用（P2002），未重复创建：${stage}`, 1);
  }
  if (code === "P2021" || message.includes("no such table") || message.includes("does not exist")) {
    return new InitAdminError(
      `${stage}：users/role_assignments 表不存在，请先执行 prisma migrate deploy（${message.split("\n")[0]}）`,
      1,
    );
  }
  return new InitAdminError(`${stage}：${message.split("\n")[0]}`, 1);
}

/**
 * 创建首个超级管理员：ACTIVE 用户 + 系统 owner 授予 + mustChangePassword=true。
 *
 * 幂等：users 表已有任何用户、或已存在任何 user 级 owner 授予 → skipped（绝不重复创建）。
 * 失败一律抛 InitAdminError（外壳按 exitCode 退出）。
 */
export async function initAdmin(
  input: InitAdminInput,
  client: InitAdminClient = prisma,
): Promise<InitAdminResult> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const displayName = typeof input.displayName === "string" && input.displayName.trim() !== ""
    ? input.displayName.trim()
    : INIT_ADMIN_DEFAULT_NAME;
  const password = typeof input.password === "string" ? input.password : "";

  const emailErr = validateEmail(email);
  if (emailErr) throw new InitAdminError(emailErr, 64);
  const pwdErr = validatePassword(password);
  if (pwdErr) throw new InitAdminError(pwdErr, 64);

  let userCount: number;
  let ownerCount: number;
  try {
    userCount = await client.user.count();
    ownerCount = await client.roleAssignment.count({
      where: { roleId: OWNER_ROLE_ID, subjectType: "user" },
    });
  } catch (e) {
    throw toInitError(e, "读取 users/role_assignments 失败");
  }
  if (userCount > 0) {
    return { status: "skipped", reason: `users 表已有 ${userCount} 个用户` };
  }
  if (ownerCount > 0) {
    return { status: "skipped", reason: `已存在 ${ownerCount} 条 user 级 owner 授予` };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const user = await client.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          displayName,
          passwordHash,
          status: USER_STATUS.ACTIVE,
          workspaceId: DEFAULT_WORKSPACE_ID,
          // 首次登录强制改密：登录成功后由 middleware/mustChangePassword.ts 闸门拦截（403）。
          mustChangePassword: true,
        },
      });
      await tx.roleAssignment.create({
        data: {
          roleId: OWNER_ROLE_ID,
          subjectType: "user",
          subjectId: created.id,
          scopeType: "workspace",
          createdBy: INIT_ADMIN_CREATED_BY,
        },
      });
      return created;
    });
    return { status: "created", userId: user.id, email: user.email };
  } catch (e) {
    throw toInitError(e, "创建超级管理员失败");
  }
}
