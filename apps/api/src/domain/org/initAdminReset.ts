// apps/api/src/domain/org/initAdminReset.ts
// init-admin --reset【领域层】：按邮箱（大小写不敏感）重置既有管理员口令。
//
// 与 initAdmin.ts 的分工同构：只回答"找不找得到、改成什么、踢不踢旧会话"，不碰
// process.argv/process.exit/日志文案/审计落盘；退出码固化在 InitAdminError.exitCode：
//   64 = 用法/凭据缺失或非法（外壳据此 exit 64）；
//   65 = 邮箱查无此人（--reset 只重置、绝不建号，故"没有"必须显式报错而非静默创建）；
//   1  = 迁移未跑/库不可写等执行失败。
//
// 重置语义（0.1.7 定稿，单事务）：passwordHash=新摘要、mustChangePassword=true、
// status=ACTIVE、disabledAt=null、tokenVersion+1（旧 JWT 的 tv claim 失配即失效）。
// 不触碰角色授予：--reset 只解决"进不去"，不重新分配权限。
//
// 与运行时写原语 withWriteTx 的区别同 initAdmin.ts：独立 CLI 进程（无并发写、无请求上下文），
// 直接用 prisma 交互事务，不入写队列。

import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../db.js";
import { USER_STATUS } from "./authState.js";
import { BCRYPT_ROUNDS } from "./members.js";
import {
  InitAdminError,
  readArg,
  toInitError,
  validateEmail,
  validatePassword,
  maskInitAdminEmail,
  type CredentialSource,
} from "./initAdmin.js";

/** --reset 的凭据（邮箱已归一化小写）。displayName 不参与重置。 */
export interface ResetAdminInput {
  email: string;
  password: string;
}

export interface ResetAdminResult {
  status: "reset";
  userId: string;
  email: string;
  /** 重置后的 tokenVersion（原值 +1），供外壳诚实打印"旧会话已失效"。 */
  tokenVersion: number;
}

export interface ResetAdminCredentialsResolved {
  ok: true;
  input: ResetAdminInput;
  source: { email: CredentialSource; password: CredentialSource };
}

/** 解析失败：调用方据此 exit 64。 */
export interface ResetAdminCredentialsMissing {
  ok: false;
  missing: string[];
  reason: string;
}

export type ResetAdminCredentials =
  | ResetAdminCredentialsResolved
  | ResetAdminCredentialsMissing;

export type ResetAdminClient = PrismaClient;

/**
 * 解析 --reset 凭据（纯函数，可直接单测）：**只认显式提供**（命令行参数 > 环境变量），
 * 一律不回落 initAdmin 的本地默认口令——默认口令是"首次建号"用的，拿它去重置既有账号
 * 属于把生产账号改成已知弱口令，必须视为配置缺失（exit 64）。
 */
export function resolveResetAdminCredentials(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): ResetAdminCredentials {
  const fromArgvEmail = readArg(argv, "--email");
  const fromEnvEmail = env.GX_INIT_ADMIN_EMAIL;
  const email = pickExplicit(fromArgvEmail, fromEnvEmail);
  const password = pickExplicit(
    readArg(argv, "--password"),
    env.GX_INIT_ADMIN_PASSWORD,
  );

  const missing: string[] = [];
  if (!email.value) missing.push("email");
  if (!password.value) missing.push("password");
  if (missing.length > 0 || !email.value || !password.value) {
    return {
      ok: false,
      missing,
      reason: `--reset 缺少管理员凭据（${missing.join("、")}）：必须显式提供 --email/--password `
        + "或 GX_INIT_ADMIN_EMAIL/GX_INIT_ADMIN_PASSWORD（--reset 只重置既有账号，不回落本地默认口令）",
    };
  }

  const emailErr = validateEmail(email.value);
  if (emailErr) return { ok: false, missing: ["email"], reason: emailErr };
  const pwdErr = validatePassword(password.value);
  if (pwdErr) return { ok: false, missing: ["password"], reason: pwdErr };

  return {
    ok: true,
    input: { email: email.value, password: password.value },
    source: { email: email.source, password: password.source },
  };
}

/** 显式取值：argv > env，空/空白一律视为未提供；无第三档默认值（与 initAdmin.pick 的区别）。 */
function pickExplicit(
  fromArgv: string | undefined,
  fromEnv: string | undefined,
): { value: string | undefined; source: CredentialSource } {
  if (typeof fromArgv === "string" && fromArgv.trim() !== "") {
    return { value: fromArgv.trim(), source: "argv" };
  }
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { value: fromEnv.trim(), source: "env" };
  }
  return { value: undefined, source: "default" };
}

/**
 * 按邮箱查用户 id（大小写不敏感）。
 *
 * 先走唯一索引精确命中（绝大多数场景一次查询）；未命中再用 lower(email) 兜底——SQLite 列
 * 默认 BINARY 排序，"Admin@X.com" 与 "admin@x.com" 不相等，而 Prisma 的 mode:"insensitive"
 * 在 SQLite connector 不可用，故按仓库纪律走 $queryRawUnsafe 参数化（不拼字符串）。
 */
async function findUserIdByEmail(
  client: ResetAdminClient,
  email: string,
): Promise<string | null> {
  const exact = await client.user.findUnique({ where: { email }, select: { id: true } });
  if (exact) return exact.id;
  const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "users" WHERE lower("email") = lower(?) LIMIT 1',
    email,
  );
  return rows[0]?.id ?? null;
}

/**
 * 重置既有账号口令：单事务内改 passwordHash / mustChangePassword / status / disabledAt
 * 并 tokenVersion+1。
 *
 * 查无此人抛 InitAdminError(65)：--reset 绝不建号（建号是 initAdmin 的职责，幂等语义不同）。
 */
export async function resetAdminPassword(
  input: ResetAdminInput,
  client: ResetAdminClient = prisma,
): Promise<ResetAdminResult> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";

  const emailErr = validateEmail(email);
  if (emailErr) throw new InitAdminError(emailErr, 64);
  const pwdErr = validatePassword(password);
  if (pwdErr) throw new InitAdminError(pwdErr, 64);

  let userId: string | null;
  try {
    userId = await findUserIdByEmail(client, email);
  } catch (e) {
    throw toInitError(e, "查询待重置账号失败");
  }
  if (!userId) {
    throw new InitAdminError(
      `未找到该邮箱对应的账号：${maskInitAdminEmail(email)}（--reset 只重置既有账号，不创建新账号；`
        + "如库为空请先不带 --reset 执行初始化）",
      65,
    );
  }

  // 收窄到 const：事务回调是闭包，let 变量的非空收窄不会带进去。
  const targetId = userId;
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const user = await client.$transaction(async (tx) =>
      tx.user.update({
        where: { id: targetId },
        data: {
          passwordHash,
          // 与 initAdmin 同口径：重置后首登强制改密（middleware/mustChangePassword 闸门拦截）。
          mustChangePassword: true,
          // 顺带解停用：重置口令的典型场景就是"管理员被停用/锁死进不去"。
          status: USER_STATUS.ACTIVE,
          disabledAt: null,
          // +1 使已签发 JWT 的 tv claim 失配 -> 旧会话立即失效（不依赖客户端主动登出）。
          tokenVersion: { increment: 1 },
        },
        select: { id: true, email: true, tokenVersion: true },
      }));
    return { status: "reset", userId: user.id, email: user.email, tokenVersion: user.tokenVersion };
  } catch (e) {
    throw toInitError(e, "重置管理员口令失败");
  }
}
