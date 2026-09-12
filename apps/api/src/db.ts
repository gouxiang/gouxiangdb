// apps/api/src/db.ts
// Prisma client 单例（避免 dev 模式下多个实例）

import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * 事务客户端 / 全局 client 的公共类型。
 * 写操作函数统一接收该类型，调用方可以选择在事务内执行（失败整体回滚）或直接执行。
 */
export type DbTx = Prisma.TransactionClient;

declare global {
  var __gx_prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__gx_prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__gx_prisma = prisma;
}

// U-7：SQLite 写并发时默认立即报 SQLITE_BUSY。设置 busy_timeout 让驱动等待锁释放
// （Prisma SQLite 单连接，PRAGMA 一次生效）；WAL 模式进一步降低读写互斥。
// PRAGMA 返回结果集，必须用 queryRaw（executeRaw 会抛错被吞）。
// 失败不阻断启动（只读副本/内存库等场景静默降级为默认行为）。
void prisma
  .$queryRawUnsafe("PRAGMA busy_timeout = 5000")
  .then(() => prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL"))
  .catch(() => {});
