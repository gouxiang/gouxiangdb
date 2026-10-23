// apps/api/src/ops/scopeBackfillBoot.ts
// #1046b 老库权限投影【启动/安装自愈】：进程 listen 前幂等补齐存量 scope→auth_policies 投影。
//
// 背景（戴总拍板）：飞牛 NAS 版卸载保留数据、重装即应顺手自愈，不接受人工跑脚本。四面部署
// （Docker / 飞牛 fpk / 裸机 / macOS Rust 壳）最终都执行 node dist/index.js，所以把自愈挂在
// 本进程 listen 之前覆盖最全，且对 Rust 壳零冲突。
//
// 安全姿态（最高硬约束：不破坏真实数据）：
//   - 纯增量、只补不动旧数据：写路径唯一走权威修复 rebuildScopePoliciesTx，只删/建
//     reason='scope:role' 的行，legacy:* / policy:v1 / user 行一根不碰；
//   - 幂等：changed=0 零写，第二次启动直接跳过，故本备份目录一生最多产生寥寥几个快照；
//   - 先备份后写：物理文件库在写入前用 better-sqlite3 .backup() 做 WAL 安全一致性快照，
//     备份【失败则宁可不写】（status=backup-failed-skip），绝不在没有回滚副本时动真实数据；
//   - 不阻断启动：任何异常只 warn，服务照常 listen（与 search/replica worker 的失败姿态一致）；
//   - 逃生开关：GX_SCOPE_BACKFILL=off 整体旁路（status=disabled），零查询零写入。
//
// 本模块是【薄编排】，不含任何映射/比较规则：只读计划与写入全部复用 domain/authz/scopeBackfill
// （与 scripts/authz/project-scope.ts 同源同幂等），事务参数也与该 CLI 一致（120s/30s）。

import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { resolveDatabaseFile } from "../db/databaseFile.js";
import { backupDatabase } from "./backup.js";
import {
  applyScopeBackfill,
  planScopeBackfill,
  type ScopeBackfillApplyResult,
  type ScopeBackfillPlan,
} from "../domain/authz/scopeBackfill.js";

/** 与 scripts/authz/project-scope.ts 同一口径：大库逐库 loadLiveShape 可能超 Prisma 默认 5s。 */
const TX_OPTS = { timeout: 120_000, maxWait: 30_000 } as const;

export type ScopeBackfillBootStatus =
  | "disabled"
  | "in-memory"
  | "up-to-date"
  | "backed-up-and-applied"
  | "backup-failed-skip"
  | "failed";

export interface ScopeBackfillBootResult {
  status: ScopeBackfillBootStatus;
  /** plan.totals.changed（disabled 时缺省）。 */
  changed?: number;
  /** 写入前的一致性快照绝对路径（内存库或缺省跳过备份时无）。 */
  backupFile?: string;
  applied?: ScopeBackfillApplyResult;
  /** status=failed / backup-failed-skip 时的错误信息（只用于日志，不外抛）。 */
  error?: string;
}

export interface ScopeBackfillBootDeps {
  prisma: PrismaClient;
  /** 当前 DATABASE_URL（相对路径按 prismaDir 解析）。 */
  databaseUrl: string;
  /** 解析相对 SQLite 路径的基准（prisma/ 目录绝对路径）。 */
  prismaDir: string;
  /** 快照根目录（实际落到 <backupDir>/scope-backfill/）。 */
  backupDir: string;
  /** false（GX_SCOPE_BACKFILL=off）时整体旁路。默认 true。 */
  enabled?: boolean;
  log?: (msg: string) => void;
  warn?: (msg: string, e?: unknown) => void;
  now?: () => Date;
  /** 备份函数注入点（默认 ops/backup.backupDatabase，测试可替换）。 */
  backup?: (sourceFile: string, destFile: string) => Promise<void>;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 文件名安全的时间戳（YYYYMMDD-HHMMSS-mmm），避免 ISO 冒号进文件名。 */
function stampOf(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${pad2(d.getMilliseconds())}`
  );
}

/**
 * listen 前调用一次。永不抛异常：成功返回各状态，失败返回 status=failed 并经 warn 记录。
 */
export async function runScopeBackfillBoot(deps: ScopeBackfillBootDeps): Promise<ScopeBackfillBootResult> {
  const log = deps.log ?? ((m) => console.log(m));
  const warn = deps.warn ?? ((m, e) => console.warn(m, e));
  const doBackup = deps.backup ?? backupDatabase;
  const now = deps.now ?? (() => new Date());

  if (deps.enabled === false) {
    return { status: "disabled" };
  }

  let plan: ScopeBackfillPlan;
  try {
    plan = await deps.prisma.$transaction((tx) => planScopeBackfill(tx), TX_OPTS);
  } catch (e) {
    warn("[scope-backfill] 只读计划失败，跳过本次启动自愈（不影响启动）", e);
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }

  const changed = plan.totals.changed;
  if (changed === 0) {
    return { status: "up-to-date", changed: 0 };
  }

  log(
    `[scope-backfill] 检出存量权限投影缺口 ${changed} 项`
      + `（待新增=${plan.totals.toCreate} 待更新=${plan.totals.toUpdate} 待删除=${plan.totals.toDelete}），开始启动自愈`,
  );

  // 解析物理库文件：内存库无文件可备（仅测试/临时场景，非持久真实数据），直接在事务内补齐。
  // 注意 resolveDatabaseFile 对裸 :memory: 会 path.resolve 成物理路径，故在其之前先判内存库
  // （同时兼容 file::memory: 写法）。
  const rawUrl = deps.databaseUrl.startsWith("file:")
    ? deps.databaseUrl.slice("file:".length)
    : deps.databaseUrl;
  const urlNoQuery = rawUrl.split("?")[0] ?? rawUrl;
  const isMemory = urlNoQuery === ":memory:" || urlNoQuery === "";
  const dbFile = isMemory ? ":memory:" : resolveDatabaseFile(deps.databaseUrl, deps.prismaDir);
  let backupFile: string | undefined;
  if (dbFile !== ":memory:") {
    backupFile = path.join(deps.backupDir, "scope-backfill", `app-${stampOf(now())}.db`);
    try {
      await doBackup(dbFile, backupFile);
      log(`[scope-backfill] 写入前一致性快照已保存：${backupFile}`);
    } catch (e) {
      // 没有回滚副本就绝不动真实数据：本次跳过，下次启动仍会重新检出并重试。
      warn(
        `[scope-backfill] 写入前快照失败，为保护数据本次不做投影补齐（服务正常启动，下次启动重试）：${backupFile}`,
        e,
      );
      return {
        status: "backup-failed-skip",
        changed,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  try {
    const applied = await deps.prisma.$transaction(
      (tx) => applyScopeBackfill(tx, plan),
      TX_OPTS,
    );
    log(
      `[scope-backfill] 启动自愈完成：created=${applied.created} updated=${applied.updated}`
        + ` deleted=${applied.deleted} skipped=${applied.skipped}`,
    );
    return {
      status: dbFile === ":memory:" ? "in-memory" : "backed-up-and-applied",
      changed,
      backupFile,
      applied,
    };
  } catch (e) {
    // 单事务整体回滚，库保持自愈前状态；快照已落盘可人工核对。不阻断启动。
    warn(
      `[scope-backfill] 投影补齐事务失败（已整体回滚，数据未变；快照：${backupFile ?? "无"}），服务正常启动`,
      e,
    );
    return {
      status: "failed",
      changed,
      backupFile,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
