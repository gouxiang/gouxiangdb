// apps/api/src/ops/benchMetrics.ts
// M1/S9 压测观测：服务端单请求耗时 + 两类查询计数，仅 GX_BENCH=on 时挂响应头。
// 非 bench（默认）所有函数零副作用直通，不进响应契约（x-gx-* 仅压测 harness 读取）。
//
// 计数口径（客观可得，规避 Prisma SQLite 限制）：
//   x-gx-physical-sql：better-sqlite3 只读连接（S2 rawRead / S6-S7 sidecar connection）
//     每次 run/get/all 计 1。这是 M1 下推读路径实际发出的物理 SQL，精确。
//   x-gx-prisma-calls：Prisma ORM 往返次数（hydrate 的唯一 IO 出口 prismaDeps 每个方法 +
//     视图/字段/主键等读路径调用，完成一次计 1；IN 批量为 1 次往返）。
//     Prisma 在 SQLite connector 上不支持 query 日志事件（类型判 never），无法逐条计 SQL，
//     故以 ORM 往返为口径，并在报告中显式标注——它正是 S5 批量化要压平的指标。

import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";
import type Database from "better-sqlite3";

interface BenchStore {
  physicalSql: number;
  prismaCalls: number;
  startedAt: bigint;
}
const als = new AsyncLocalStorage<BenchStore>();

export function benchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GX_BENCH === "on";
}

/** 记一次物理只读 SQL（rawRead/sidecar connection 的 instrumentDatabase 调用）。 */
export function notePhysicalSql(): void {
  const store = als.getStore();
  if (store) store.physicalSql++;
}

/** 记一次 Prisma ORM 往返（仅在请求 bench 上下文内累加）。 */
export function notePrismaCall(): void {
  const store = als.getStore();
  if (store) store.prismaCalls++;
}

/**
 * 包一层 better-sqlite3 Database：prepare 返回的 Statement 在执行时计物理 SQL。
 * 仅 bench 启用时调用；用 Proxy 透传全部属性，行为与原连接一致。
 */
export function instrumentDatabase(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (...args: unknown[]) => {
          const stmt = Reflect.apply(target.prepare, target, args) as Database.Statement;
          return new Proxy(stmt, {
            get(stmtTarget, sprop, sReceiver) {
              const val = Reflect.get(stmtTarget, sprop, sReceiver);
              if (sprop === "run" || sprop === "get" || sprop === "all" || sprop === "iterate") {
                return (...sargs: unknown[]) => {
                  notePhysicalSql();
                  return Reflect.apply(val as (...a: unknown[]) => unknown, stmtTarget, sargs);
                };
              }
              return typeof val === "function" ? val.bind(stmtTarget) : val;
            },
          });
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

/**
 * Hono 中间件：bench 模式下为每请求开观测上下文，结束后挂 x-gx-serve-ms /
 * x-gx-physical-sql / x-gx-prisma-calls（服务端口径，覆盖完整路由处理，不含网络）。
 * 非 bench 直接 next()。
 */
export async function benchMetricsMiddleware(c: Context, next: Next): Promise<void> {
  if (!benchEnabled()) {
    await next();
    return;
  }
  const store: BenchStore = { physicalSql: 0, prismaCalls: 0, startedAt: process.hrtime.bigint() };
  await als.run(store, next);
  const elapsedMs = Number(process.hrtime.bigint() - store.startedAt) / 1e6;
  c.header("x-gx-serve-ms", elapsedMs.toFixed(3));
  c.header("x-gx-physical-sql", String(store.physicalSql));
  c.header("x-gx-prisma-calls", String(store.prismaCalls));
  // 当前进程常驻内存（含 better-sqlite3/Prisma）；harness 对全程取 max 得峰值 RSS。
  c.header("x-gx-rss-bytes", String(process.memoryUsage.rss()));
}
