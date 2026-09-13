// apps/api/src/db.ts
// Prisma client 单例 + 写访问门面（M1/S1 写串行队列）

import { PrismaClient, type Prisma } from "@prisma/client";
import { createWriteQueue, resolveWriteQueueEnabled, type WriteQueue } from "./db/writeQueue.js";
import { benchEnabled, notePrismaCall } from "./ops/benchMetrics.js";

/**
 * 事务客户端 / 全局 client 的公共类型。
 * 写操作函数统一接收该类型，调用方可以选择在事务内执行（失败整体回滚）或直接执行。
 */
export type DbTx = Prisma.TransactionClient;

declare global {
  var __gx_prisma: PrismaClient | undefined;
  var __gx_write_queue: WriteQueue | undefined;
}

// S9 bench 说明：Prisma 在 SQLite connector 上不支持 query 日志事件（类型判 never），
// 无法用 $on("query") 逐条计 SQL。改为两个应用层口径（见 ops/benchMetrics）：
//   - 物理下推 SQL：sidecar/raw 只读连接 instrumentDatabase 精确计数；
//   - Prisma 模型操作往返：bench 模式在 client 外包一层计数 Proxy（instrumentPrisma），
//     覆盖全部模型的 find*/create/update/count/aggregate 等，含交互事务内的 tx.*。
// 两口径仅 GX_BENCH=on 生效，默认关闭零开销、零行为变化。

const baseClient: PrismaClient =
  globalThis.__gx_prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

/**
 * 包模型委托：任一函数式属性被调用即计为一次 ORM 往返（findMany/count/aggregate 等均为 IO）。
 * 非函数属性（fields/元数据）与 symbol 透传。
 */
function instrumentDelegate(delegate: unknown): unknown {
  if (delegate === null || typeof delegate !== "object") return delegate;
  return new Proxy(delegate as object, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        notePrismaCall();
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      };
    },
  });
}

/**
 * 递归计数 Proxy：`prisma.<model>.<op>(...)` 计一次；`$transaction(fn)` 回调收到的 tx
 * 同样被包裹，故事务内操作也计数。`$`/`_` 前缀的内部属性与 raw 查询原样透传。
 * 仅压测使用，返回类型仍声明为 PrismaClient，调用方零类型涟漪。
 */
function instrumentPrisma(client: PrismaClient): PrismaClient {
  const wrap = (target: object): PrismaClient =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "$transaction") {
          const orig = Reflect.get(t, prop, receiver) as (arg: unknown) => Promise<unknown>;
          return (arg: unknown) => {
            if (typeof arg !== "function") return Reflect.apply(orig, t, [arg]);
            return Reflect.apply(orig, t, [
              (tx: object) => Reflect.apply(arg as (...a: unknown[]) => unknown, undefined, [wrap(tx)]),
            ]);
          };
        }
        if (typeof prop === "symbol" || prop.startsWith("$") || prop.startsWith("_")) {
          const value = Reflect.get(t, prop, receiver);
          return typeof value === "function" ? value.bind(t) : value;
        }
        return instrumentDelegate(Reflect.get(t, prop, receiver));
      },
    }) as PrismaClient;
  return wrap(client);
}

export const prisma: PrismaClient = benchEnabled() ? instrumentPrisma(baseClient) : baseClient;

if (process.env.NODE_ENV !== "production") {
  globalThis.__gx_prisma = prisma;
}

// U-7：SQLite 写并发时默认立即报 SQLITE_BUSY。设置 busy_timeout 让驱动等待锁释放
// （Prisma SQLite 单连接，PRAGMA 一次生效）；WAL 模式进一步降低读写互斥。
// PRAGMA 返回结果集，必须用 queryRaw（executeRaw 会抛错被吞）。
// 失败不阻断启动（只读副本/内存库等场景静默降级为默认行为）。
//
// M1/S1：改为模块级「一次性、可等待」的就绪 promise。写队列与只读 raw 连接（S2）
// 在首次工作前 await 它，保证 PRAGMA 已生效；但即便就绪失败也只是静默降级，不阻塞启动。
export const dbReady: Promise<void> = prisma
  .$queryRawUnsafe("PRAGMA busy_timeout = 5000")
  .then(() => prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL"))
  .then(() => undefined)
  .catch(() => undefined);

// 进程级单例写队列（dev/test 热重载复用同一实例，避免队列状态被意外重置）。
export const writeQueue: WriteQueue =
  globalThis.__gx_write_queue ?? createWriteQueue(resolveWriteQueueEnabled());
if (process.env.NODE_ENV !== "production") {
  globalThis.__gx_write_queue = writeQueue;
}

/**
 * 在串行写队列中执行一个【交互事务】。
 *
 * 铁律：回调体内只能使用传入的 `tx`，绝不能再调用 runWrite/withWriteTx
 * （队列并发度恒 1，事务回调内再次入队会自死锁）。
 *
 * 异常原样透传（含 HttpError 的 status），不开额外事务、不吞错。
 * GX_M1_WRITE_QUEUE=off 时队列旁路，退化为直接执行（旧行为）。
 */
export async function withWriteTx<T>(
  label: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  await dbReady;
  return await writeQueue.run(label, () => prisma.$transaction(fn));
}

/**
 * 在串行写队列中执行一个【非事务】写工作单元（如尽力而为的默认值补偿写、
 * 多步领域写）。回调内同样禁止再次入队。
 */
export async function runWrite<T>(label: string, task: () => Promise<T>): Promise<T> {
  await dbReady;
  return await writeQueue.run(label, task);
}

/**
 * 串行执行一个【批量数组事务】（prisma.$transaction([...]) 形态）。
 * 与 withWriteTx 同样入队，仅入参形态不同。
 */
export async function withWriteBatch(
  label: string,
  statements: Prisma.PrismaPromise<unknown>[],
): Promise<void> {
  await dbReady;
  await writeQueue.run(label, () => prisma.$transaction(statements));
}
