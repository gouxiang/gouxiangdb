#!/usr/bin/env node
// apps/api/scripts/init-admin.ts
// 首次部署超级管理员初始化 CLI（构建产物 dist/init-admin.js）。
//
// 何时跑：仅首次部署。部署链路（Docker / 裸机 systemd / 飞牛 fnOS）在
//   【prisma migrate deploy 完成 + nav-reconcile 之后、服务启动之前】调用一次；
//   本脚本的前置依赖就是迁移已完成（users/role_assignments 表必须存在）。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db node dist/init-admin.js
//   DATABASE_URL=file:/abs/app.db node dist/init-admin.js --email a@b.c --password 'xxx' --name 昵称
//   DATABASE_URL=file:/abs/app.db GX_INIT_ADMIN_EMAIL=a@b.c GX_INIT_ADMIN_PASSWORD='xxx' node dist/init-admin.js --reset
//   node dist/init-admin.js --help
//
// 幂等：users 表已有任何用户
// 凭据优先级（建号路径）：命令行参数 > 环境变量（GX_INIT_ADMIN_EMAIL / _PASSWORD / _NAME） > 本地默认值。（或已存在 user 级 owner 授予）→ 打印「已初始化，跳过」并 exit 0，
//       绝不重复创建、绝不覆盖既有账号，可安全重跑。
// --reset（0.1.7）：按邮箱重置【既有】账号口令（大小写不敏感），只重置不建号；
//       单事务改 passwordHash + mustChangePassword=true + status=ACTIVE + disabledAt=null
//       + tokenVersion+1（踢掉旧会话）。**必须显式提供凭据**（不回落本地默认口令），
//       查无此人 exit 65 并打印明确错误。
// 退出码：0=创建成功/重置成功/已初始化跳过；64=用法/环境变量缺失（缺 DATABASE_URL、生产未提供凭据、
//       邮箱格式或密码长度不合法）；65=--reset 时该邮箱查无此人；1=执行失败（迁移未跑、库不可写等）。
// 纪律：
//   - 生产环境（NODE_ENV=production）严禁使用内置默认口令（admin@gouxiang.local/admin12345），
//     必须显式提供凭据，否则 exit 64。
//   - 绝不打印密码明文；审计 detail 只落脱敏邮箱（a***@example.com），不落密码。
//   - 审计写不进去只告警，不因此让初始化失败（建号成功的事实更重要）。

import type { InitAdminResult } from "../src/domain/org/initAdmin.js";
import type { ResetAdminResult } from "../src/domain/org/initAdminReset.js";
import { writeAudit } from "../src/audit/audit.js";

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function printUsage(): void {
  console.log(`用法：node dist/init-admin.js [--email <email>] [--password <password>] [--name <昵称>]
       node dist/init-admin.js --reset [--email <email>] [--password <password>]

  环境变量：GX_INIT_ADMIN_EMAIL / GX_INIT_ADMIN_PASSWORD / GX_INIT_ADMIN_NAME
  优先级：命令行参数 > 环境变量 > 本地默认值（默认值仅非 production 生效，--reset 不使用默认值）
  --reset：按邮箱重置既有账号口令并置强制改密 + 恢复 ACTIVE + 旧会话失效；只重置不建号
  必填：DATABASE_URL（形如 file:/var/lib/gouxiangdb/app.db），且需先跑完 prisma migrate deploy
  退出码：0=创建/重置成功或已初始化跳过；64=用法/环境变量缺失；65=--reset 时该邮箱查无此人；1=执行失败`);
}

async function writeInitAudit(
  result: InitAdminResult,
  displayName: string,
  maskInitAdminEmail: (email: string) => string,
): Promise<void> {
  try {
    writeAudit(await auditDir(), {
      event: "admin_initialized",
      actorId: result.userId ?? null,
      method: "CLI",
      path: "scripts/init-admin.ts",
      status: 200,
      // detail 严禁出现密码：只落脱敏邮箱 + 昵称 + 授予角色 + 来源。
      detail: {
        emailMasked: maskInitAdminEmail(result.email ?? ""),
        displayName,
        grantedRole: "owner",
        source: "cli",
      },
    });
  } catch (e) {
    console.warn(`[init-admin] 审计写入失败（不阻断初始化）：${(e as Error).message}`);
  }
}

// 0.1.7：--reset 成功留痕。detail 只落脱敏邮箱 + 新 tokenVersion + 来源（新密码绝不能入日志）。
async function writeResetAudit(
  result: ResetAdminResult,
  maskInitAdminEmail: (email: string) => string,
): Promise<void> {
  try {
    writeAudit(await auditDir(), {
      event: "admin_password_reset",
      actorId: result.userId,
      method: "CLI",
      path: "scripts/init-admin.ts",
      status: 200,
      detail: {
        emailMasked: maskInitAdminEmail(result.email ?? ""),
        // 键名刻意不叫 tokenVersion/mustChangePassword：audit.ts 的 SENSITIVE_PARTS 是
        // 子串匹配（"token"/"password"），命中即整值替换为 [REDACTED]，落库反而丢掉事实。
        // 语义与 JWT 的 tv claim 对齐（tv = 会话失效版本号），值本身不是凭据。
        tv: result.tokenVersion,
        forceChangeNextLogin: true,
        source: "cli",
      },
    });
  } catch (e) {
    console.warn(`[init-admin] 审计写入失败（不阻断口令重置）：${(e as Error).message}`);
  }
}

// config.js 在 import 瞬间做启动闸门校验（生产缺 DATABASE_URL 会直接 exit 2），
// 故延迟到 DATABASE_URL 校验通过后再取，保证本脚本自己的退出码语义（64）优先。
async function auditDir(): Promise<string> {
  const { config } = await import("../src/config.js");
  return config.auditDir;
}

/**
 * 加载领域层（动态 import，刻意延迟）。
 *
 * 为什么不能静态 import：initAdmin.js -> db.js 依赖 @prisma/client，而后者在【模块求值】
 * 阶段就 dotenv 加载 .env 并写回 process.env（已实测：import 后 DATABASE_URL 从 undefined
 * 变成 file:./dev.db，无需等 new PrismaClient()）。
 *
 * 效果边界（均已实测，如实记录）：
 *  - 发布包内无 .env（package-release.mjs 只拷白名单）-> 本守卫稳定 exit 64；
 *  - 开发仓库 apps/api/.env 存在时，@prisma/client 作为 external 被提升到产物顶层 import，
 *    Node 在任何用户代码之前完成求值，本守卫挡不住：实测 exit 0 并落在 dev.db 上
 *    （"已初始化，跳过（users 表已有 58 个用户）"）。该行为与 scripts/nav/reconcile-nav.ts
 *    同构，属仓库既有面，不是本脚本引入；修它需要动 db.ts/打包策略，不在本次改动范围。
 */
async function loadDomain(): Promise<typeof import("../src/domain/org/initAdmin.js")> {
  return import("../src/domain/org/initAdmin.js");
}

/**
 * 加载 --reset 领域层（动态 import，原因同 loadDomain）。
 */
async function loadResetDomain(): Promise<typeof import("../src/domain/org/initAdminReset.js")> {
  return import("../src/domain/org/initAdminReset.js");
}

/**
 * --reset 分支：重置既有账号口令（不建号、不改角色）。
 * 退出码：64=凭据缺失/非法；65=邮箱查无此人；1=执行失败；0=成功。
 */
async function runReset(
  domain: typeof import("../src/domain/org/initAdmin.js"),
  argv: readonly string[],
): Promise<number> {
  const { resolveResetAdminCredentials, resetAdminPassword } = await loadResetDomain();
  const credentials = resolveResetAdminCredentials(process.env, argv);
  if (!credentials.ok) {
    console.error(`[init-admin] ${credentials.reason}`);
    return 64;
  }
  try {
    const result = await resetAdminPassword(credentials.input);
    console.log(
      `[init-admin] 已重置 ${result.email} 的口令：已开启首次登录强制改密、账号恢复 ACTIVE、`
        + `旧会话已失效（tokenVersion=${result.tokenVersion}）`,
    );
    await writeResetAudit(result, domain.maskInitAdminEmail);
    console.log(
      "[init-admin] 安全提示：请立即用新密码登录并完成改密；完成后建议从 env 中删除 GX_INIT_ADMIN_* 两行。",
    );
    return 0;
  } catch (e) {
    if (e instanceof domain.InitAdminError) {
      console.error(`[init-admin] ${e.message}`);
      return e.exitCode;
    }
    console.error("[init-admin] 口令重置失败：", e);
    return 1;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printUsage();
    return 0;
  }

  if (!process.env.DATABASE_URL) {
    console.error("[init-admin] 缺少 DATABASE_URL，形如 file:/var/lib/gouxiangdb/app.db");
    return 64;
  }

  const domain = await loadDomain();
  const { initAdmin, resolveInitAdminCredentials, maskInitAdminEmail, InitAdminError } = domain;

  // --reset 只重置既有账号：凭据必须显式提供（不回落默认口令），故走独立解析（exit 64/65）
  // 且必须先于建号路径判定（否则会以"已初始化"跳过，永远重置不到）。
  if (hasFlag(argv, "--reset")) return runReset(domain, argv);

  const credentials = resolveInitAdminCredentials(process.env, argv);
  if (!credentials.ok) {
    console.error(`[init-admin] ${credentials.reason}`);
    return 64;
  }
  const { input, source } = credentials;
  if (source.password === "default") {
    console.warn(
      `[init-admin] 警告：正在使用内置默认口令（非 production 本地开发用），生产部署必须显式提供凭据`,
    );
  }

  try {
    const result = await initAdmin(input);
    if (result.status === "skipped") {
      console.log(`[init-admin] 已初始化，跳过（${result.reason ?? "users 表非空"}）`);
      return 0;
    }
    console.log(
      `[init-admin] 已创建超级管理员 ${result.userId} ${result.email}，已授予系统 owner，已标记首次登录强制改密`,
    );
    await writeInitAudit(result, input.displayName, maskInitAdminEmail);
    console.log(
      "[init-admin] 安全提示：请立即用初始账号登录并修改密码；完成后建议从 env 中删除 GX_INIT_ADMIN_* 三行。",
    );
    return 0;
  } catch (e) {
    if (e instanceof InitAdminError) {
      console.error(`[init-admin] ${e.message}`);
      return e.exitCode;
    }
    console.error("[init-admin] 初始化失败：", e);
    return 1;
  }
}

main()
  .then((rc) => process.exit(rc))
  .catch((e: unknown) => {
    console.error("[init-admin] 未预期失败：", e);
    process.exit(1);
  });
