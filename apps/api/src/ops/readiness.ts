// apps/api/src/ops/readiness.ts
// /readyz 五探针：dbPing / dbWritable / migrations / uploadsWritable / disk。
// 铁律：探针只产出布尔与短码，任何失败都不向上抛出堆栈、不回传绝对路径或异常原文。
// dbWritable / migrations 使用独立 better-sqlite3 连接（WAL 多连接安全），
// 与 db.ts 的 Prisma 连接及悬空 PRAGMA promise 解耦。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { resolveDatabaseFile } from "../db/databaseFile.js";
import { VERSION } from "../version.js";

// 历史导出口径保留：resolveDatabaseFile 实现已抽到 db/databaseFile.ts（M1/S2，
// readiness 与 rawRead 共用同一解析），此处 re-export 不破坏既有测试/调用方导入。
export { resolveDatabaseFile };

export const SERVICE_NAME = "gouxiangdb-api";

export type CheckName =
  | "dbPing"
  | "dbWritable"
  | "migrations"
  | "uploadsWritable"
  | "disk";

export interface ProbeResult {
  ok: boolean;
  code?: string;
}

interface MigrationState {
  applied: number;
  latest: string | null;
}

interface ReadinessReport {
  status: "ready" | "not_ready";
  service: string;
  version: string;
  checks: Record<CheckName, boolean>;
  failureCodes: Partial<Record<CheckName, string>>;
  migration: MigrationState;
}

export interface ReadinessDeps {
  dbPing(): Promise<ProbeResult>;
  dbWritable(): Promise<ProbeResult>;
  migrations(): Promise<ProbeResult & MigrationState>;
  uploadsWritable(): Promise<ProbeResult>;
  disk(): Promise<ProbeResult>;
  dispose(): void;
}

// 纯函数：磁盘迁移目录与库内 _prisma_migrations 对账。
export function reconcileMigrations(
  disk: { count: number; latest: string | null },
  db: MigrationState,
): ProbeResult & MigrationState {
  const matched =
    disk.count > 0 && disk.count === db.applied && disk.latest === db.latest;
  return {
    ok: matched,
    code: matched ? undefined : "MISMATCH",
    applied: db.applied,
    latest: db.latest,
  };
}

function listDiskMigrations(migrationsDir: string): {
  count: number;
  latest: string | null;
} {
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return { count: names.length, latest: names[names.length - 1] ?? null };
}

interface PrismaMigrationRow {
  migration_name: string;
  finished_at: string | null;
  rolled_back_at: string | null;
}

const CHECK_ORDER: CheckName[] = [
  "dbPing",
  "dbWritable",
  "migrations",
  "uploadsWritable",
  "disk",
];

// 串行跑完五项（不短路，一次暴露全部故障）。
export async function runChecks(deps: ReadinessDeps): Promise<ReadinessReport> {
  const checks = {
    dbPing: false,
    dbWritable: false,
    migrations: false,
    uploadsWritable: false,
    disk: false,
  } as Record<CheckName, boolean>;
  const failureCodes: Partial<Record<CheckName, string>> = {};
  let migration: MigrationState = { applied: 0, latest: null };

  for (const name of CHECK_ORDER) {
    if (name === "migrations") {
      const r = await deps.migrations();
      checks.migrations = r.ok;
      migration = { applied: r.applied, latest: r.latest };
      if (!r.ok && r.code) failureCodes.migrations = r.code;
    } else {
      const r = await deps[name]();
      checks[name] = r.ok;
      if (!r.ok && r.code) failureCodes[name] = r.code;
    }
  }

  const ready = CHECK_ORDER.every((n) => checks[n]);
  return {
    status: ready ? "ready" : "not_ready",
    service: SERVICE_NAME,
    version: VERSION,
    checks,
    failureCodes,
    migration,
  };
}

// 探针连接必须是【进程级常驻单例】，不能在每次 /readyz 响应后关闭：
// SQLite 当"最后一个打开的连接关闭"时会自动 checkpoint 并 unlink -wal/-shm。
// 启动探针（systemd/k8s）几乎总是在 Prisma 建库后、其它常驻只读单例建立前第一个、
// 也是当时唯一的 better-sqlite3 连接；若请求结束即 close，会删掉 Prisma 引擎正持有的
// wal/shm，导致其首个写事务 SQLITE_IOERR_FSYNC(extended 522)（库越大 checkpoint 窗口
// 越宽，竞态越稳定复现）。常驻后该连接永不成为"关闭瞬间的最后连接"，仅随进程退出回收。
let probeConn: Database.Database | undefined;
let probeConnFile: string | undefined;

function getProbeConn(dbFile: string): Database.Database {
  if (!probeConn || probeConnFile !== dbFile) {
    closeProbeConn();
    probeConn = new Database(dbFile, { timeout: 1000 });
    probeConnFile = dbFile;
  }
  return probeConn;
}

/** 关闭常驻探针连接（进程退出随句柄回收；仅供优雅停机与测试在换库时收尾）。 */
export function closeProbeConn(): void {
  try {
    probeConn?.close();
  } catch {
    /* 文件被替换/已关闭时安全收尾 */
  }
  probeConn = undefined;
  probeConnFile = undefined;
}

// 真实探针：进程级常驻 better-sqlite3 连接 + Prisma ping + 文件系统探测。
export function createDefaultDeps(): ReadinessDeps {
  const prismaDir = path.dirname(config.migrationsDir);
  const dbFile = resolveDatabaseFile(config.databaseUrl, prismaDir);

  const sqlite = (): Database.Database => getProbeConn(dbFile);
  // 连接是进程单例，不在请求末关闭（见文件头说明）；BUSY 重试复用同一连接即可
  // （BEGIN IMMEDIATE 失败时并无残留事务，直接重开事务）。
  const resetSqlite = (): void => {
    /* no-op：探针连接常驻，关闭会触发 WAL 末连接 unlink，毒化 Prisma */
  };

  return {
    async dbPing() {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { ok: true };
      } catch {
        return { ok: false, code: "FAIL" };
      }
    },

    async dbWritable() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const conn = sqlite();
          conn.exec("BEGIN IMMEDIATE");
          conn.exec("ROLLBACK");
          return { ok: true };
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "SQLITE_BUSY" && attempt === 0) {
            // 写锁竞争：丢弃可能残留事务的连接，短等后重试一次再判失败。
            resetSqlite();
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }
          return { ok: false, code: code === "SQLITE_BUSY" ? "BUSY" : "FAIL" };
        }
      }
      return { ok: false, code: "FAIL" };
    },

    async migrations() {
      try {
        const rows = sqlite()
          .prepare(
            "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations",
          )
          .all() as PrismaMigrationRow[];
        const applied = rows
          .filter((r) => r.finished_at != null && r.rolled_back_at == null)
          .map((r) => r.migration_name)
          .sort();
        const dbState: MigrationState = {
          applied: applied.length,
          latest: applied[applied.length - 1] ?? null,
        };
        const r = reconcileMigrations(
          listDiskMigrations(config.migrationsDir),
          dbState,
        );
        return { ok: r.ok, code: r.code, applied: r.applied, latest: r.latest };
      } catch {
        return { ok: false, code: "FAIL", applied: 0, latest: null };
      }
    },

    async uploadsWritable() {
      const stamp = `${process.pid}-${Date.now()}`;
      const tmp = path.join(config.uploadRoot, `.readyz-${stamp}`);
      const renamed = `${tmp}.ok`;
      try {
        fs.mkdirSync(config.uploadRoot, { recursive: true });
        fs.writeFileSync(tmp, "ok");
        fs.renameSync(tmp, renamed);
        fs.rmSync(renamed, { force: true });
        return { ok: true };
      } catch {
        for (const f of [tmp, renamed]) {
          try {
            fs.rmSync(f, { force: true });
          } catch {
            /* ignore */
          }
        }
        return { ok: false, code: "FAIL" };
      }
    },

    async disk() {
      try {
        const target = fs.existsSync(config.dataDir)
          ? config.dataDir
          : fs.existsSync(path.dirname(dbFile))
            ? path.dirname(dbFile)
            : "/";
        const st = fs.statfsSync(target);
        const availBytes = Number(st.bavail) * Number(st.bsize);
        return availBytes >= config.minDiskMb * 1024 * 1024
          ? { ok: true }
          : { ok: false, code: "LOW_SPACE" };
      } catch {
        return { ok: false, code: "FAIL" };
      }
    },

    dispose() {
      resetSqlite();
    },
  };
}
