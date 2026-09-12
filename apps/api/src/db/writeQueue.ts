// apps/api/src/db/writeQueue.ts
// 进程内写串行队列（M1/S1）：单 promise 链尾追加，并发度恒 1。
// Prisma SQLite 是单连接，并发 HTTP 写会在应用层争抢写锁（立即 SQLITE_BUSY，
// 或交互事务排队超 5s 后整体失败，见 scripts/bench/write-contention.ts 实测）。
// 队列把「并发写→失败」改造成「并发写→排队」，并为 outbox / MCP 长任务立下
// 「同进程唯一写入口」纪律。零运行时依赖；不开事务、不吞错，异常原样透传。
// 铁律：task 回调体内绝不能再调用同一队列的 run（自死锁），事务回调只用传入 tx。

export interface QueueStats {
  enqueued: number; // 累计入队任务数
  settled: number; // 已完成（成功或失败）任务数
  failed: number; // 失败任务数
  depthSamples: number[]; // 入队那一刻排队深度（不含自己）采样
  waitMsSamples: number[]; // 排队等待毫秒采样
  runMsSamples: number[]; // 实际执行毫秒采样
  byLabel: Record<string, number>; // 按 label 统计入队次数，供 readyz 定位热点写路径
}

export interface WriteQueue {
  /** 串行执行一个写工作单元；异常原样透传 */
  run<T>(label: string, task: () => Promise<T>): Promise<T>;
  /** 当前排队中（含执行中）任务数 */
  pending(): number;
  /** 是否启用串行（false 时 run 直接透传调用） */
  readonly enabled: boolean;
  /** 观测快照（样本有上限，避免长进程内存膨胀） */
  stats(): Readonly<QueueStats>;
}

const MAX_SAMPLES = 2000;

function pushSample(bucket: number[], value: number): void {
  bucket.push(value);
  if (bucket.length > MAX_SAMPLES) bucket.shift();
}

/**
 * 创建一个独立写队列。
 * @param enabled false 时 run 直接 await task（旁路，用于 GX_M1_WRITE_QUEUE=off）
 */
export function createWriteQueue(enabled: boolean): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve(); // 链尾：await 它保证顺序
  let inflight = 0;
  const stats0: QueueStats = {
    enqueued: 0,
    settled: 0,
    failed: 0,
    depthSamples: [],
    waitMsSamples: [],
    runMsSamples: [],
    byLabel: {},
  };

  function run<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (!enabled) return task();

    stats0.enqueued += 1;
    stats0.byLabel[label] = (stats0.byLabel[label] ?? 0) + 1;
    pushSample(stats0.depthSamples, inflight); // 深度=已在链上未结束的任务数
    const enqueuedAt = performance.now();

    const result = tail.then(async () => {
      inflight += 1;
      pushSample(stats0.waitMsSamples, performance.now() - enqueuedAt);
      const runStart = performance.now();
      try {
        return await task();
      } finally {
        pushSample(stats0.runMsSamples, performance.now() - runStart);
        inflight -= 1;
        stats0.settled += 1;
      }
    });

    // 失败透传但不打断链：把失败吞进链状态，业务侧通过返回的 result 接收原始异常。
    // 绝不改写原始 error（HttpError 的 status/中文 message 必须原样透传）。
    tail = result.then(
      () => undefined,
      () => {
        stats0.failed += 1;
      },
    );

    return result;
  }

  return {
    run,
    pending: () => inflight,
    enabled,
    stats: () => stats0,
  };
}

/**
 * 进程级开关解析：GX_M1_WRITE_QUEUE=off 旁路（回退旧行为），=on 显式启用；
 * 未设置时生产/开发默认 on（纯收口），NODE_ENV=test 默认 off（保旧测试路径），
 * 需要验证队列行为的测试/脚本显式置 on。
 */
export function resolveWriteQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.GX_M1_WRITE_QUEUE;
  if (flag === "off") return false;
  if (flag === "on") return true;
  return env.NODE_ENV !== "test";
}
