/**
 * 授权时钟：所有状态机时间判定走注入时钟而非裸 Date。
 * 核心防回拨规则（与 simulator/clock.ts 一致）：
 *   effectiveNow = max(本机秒, 历史观测最大值 maxSeen)
 * maxSeen 同时吸收「本机推进」与「服务端 serverTime」，并由 store 持久化（防重启回拨）。
 */

/** 纯函数：本机秒与历史最大取严。 */
export function effectiveNowSec(localSec: number, maxSeen: number): number {
  return Math.max(localSec, maxSeen);
}

export interface Clock {
  /** 当前有效 unix 秒（已对回拨取严）。 */
  current(): number;
  /** 收到服务端 serverTime 校时（取更晚者），返回更新后的 maxSeen（调用方负责持久化）。 */
  observeServerTime(serverSec: number): number;
  /** 当前持久化的 maxSeen。 */
  maxSeen(): number;
}

/**
 * 生产时钟。localNow 取系统秒；maxSeen 读 store。
 * 关键：本机时间自然前进也要抬高并持久化水位——否则仅靠服务端校时无法防「本机手动回拨」
 *（用户回拨系统时钟后从未再收到 serverTime 就会被旧时间续命）。调用频率低（每次心跳/闸门判定），
 * 持久化为 KV 幂等写，可接受。不内置计时器/IO，副作用经注入函数，便于单测与零依赖。
 */
export class PersistedClock implements Clock {
  private seen: number;
  constructor(
    private readonly localNow: () => number,
    initialMaxSeen: number,
    private readonly persistMaxSeen: (sec: number) => void,
  ) {
    this.seen = Math.max(0, Math.floor(initialMaxSeen || 0));
  }

  current(): number {
    const local = Math.floor(this.localNow());
    if (local > this.seen) {
      this.seen = local;
      this.persistMaxSeen(this.seen);
    }
    return this.seen;
  }

  observeServerTime(serverSec: number): number {
    const s = Math.floor(serverSec || 0);
    if (s > this.seen) {
      this.seen = s;
      this.persistMaxSeen(this.seen);
    }
    return this.seen;
  }

  maxSeen(): number {
    return this.seen;
  }
}

/**
 * 虚拟时钟（移植自 simulator/clock.ts）：支持快进、回拨、服务端校时，供向量/故障注入测试。
 */
export class MockClock implements Clock {
  private now: number;
  private seen: number;

  constructor(startSec = Math.floor(Date.now() / 1000)) {
    this.now = startSec;
    this.seen = startSec;
  }

  current(): number {
    return Math.max(this.now, this.seen);
  }

  rawNow(): number {
    return this.now;
  }

  advance(seconds: number): void {
    this.now += seconds;
    if (this.now > this.seen) this.seen = this.now;
  }

  /** 系统时钟被回拨（不应续命）。 */
  rollback(seconds: number): void {
    this.now -= seconds;
  }

  observeServerTime(serverSec: number): number {
    if (serverSec > this.seen) this.seen = serverSec;
    return this.seen;
  }

  maxSeen(): number {
    return this.seen;
  }

  date(): Date {
    return new Date(this.current() * 1000);
  }
}
