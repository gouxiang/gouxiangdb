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
//   node dist/init-admin.js --help
//
// 凭据优先级：命令行参数 > 环境变量（GX_INIT_ADMIN_EMAIL / _PASSWORD / _NAME） > 本地默认值。
// 幂等：users 表已有任何用户（或已存在 user 级 owner 授予）→ 打印「已初始化，跳过」并 exit 0，
//       绝不重复创建、绝不覆盖既有账号，可安全重跑。
// 退出码：0=创建成功或已初始化跳过；64=用法/环境变量缺失（缺 DATABASE_URL、生产未提供凭据、
//       邮箱格式或密码长度不合法）；1=执行失败（迁移未跑、库不可写等）。
// 纪律：
//   - 生产环境（NODE_ENV=production）严禁使用内置默认口令（admin@gouxiang.local/admin12345），
//     必须显式提供凭据，否则 exit 64。
//   - 绝不打印密码明文；审计 detail 只落脱敏邮箱（a***@example.com），不落密码。
//   - 审计写不进去只告警，不因此让初始化失败（建号成功的事实更重要）。

import type { InitAdminResult } from "../src/domain/org/initAdmin.js";
import { writeAudit } from "../src/audit/audit.js";

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function printUsage(): void {
  console.log(`用法：node dist/init-admin.js [--email <email>] [--password <password>] [--name <昵称>]

  环境变量：GX_INIT_ADMIN_EMAIL / GX_INIT_ADMIN_PASSWORD / GX_INIT_ADMIN_NAME
  优先级：命令行参数 > 环境变量 > 本地默认值（默认值仅非 production 生效）
  必填：DATABASE_URL（形如 file:/var/lib/gouxiangdb/app.db），且需先跑完 prisma migrate deploy
  退出码：0=创建成功或已初始化跳过；64=用法/环境变量缺失；1=执行失败`);
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

  const { initAdmin, resolveInitAdminCredentials, maskInitAdminEmail, InitAdminError } =
    await loadDomain();

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
