// M5/S5 indexerSchedule 纯函数单测：退避序列、dead 判定、锁过期/归属/心跳解析。

import { describe, expect, it } from "vitest";
import {
  BACKOFF_STEPS_MS,
  MAX_ATTEMPTS,
  backoffDelayMs,
  nextRunAtMs,
  shouldMarkDead,
  decideFailure,
  isLockStale,
  lockOwnedBy,
  formatLockValue,
  parseLockHeartbeat,
  DEFAULT_STALLED_MS,
} from "../indexerSchedule.js";

describe("backoffDelayMs 指数退避台阶（§5.3：10s/1m/10m/1h）", () => {
  it("attempts 1..3 -> 10s/1m/10m；>=4 恒 1h", () => {
    expect(backoffDelayMs(1)).toBe(10_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(600_000);
    expect(backoffDelayMs(4)).toBe(3_600_000);
    expect(backoffDelayMs(7)).toBe(3_600_000);
    expect(BACKOFF_STEPS_MS).toEqual([10_000, 60_000, 600_000, 3_600_000]);
  });

  it("非法 attempts 防御性回首档；nextRunAtMs = now + delay", () => {
    expect(backoffDelayMs(0)).toBe(10_000);
    expect(backoffDelayMs(-3)).toBe(10_000);
    expect(nextRunAtMs(1000, 2)).toBe(61_000);
  });
});

describe("shouldMarkDead / decideFailure（attempts>=8 转 dead）", () => {
  it("attempts < 8 -> failed；>= 8 -> dead", () => {
    expect(shouldMarkDead(1)).toBe(false);
    expect(shouldMarkDead(7)).toBe(false);
    expect(shouldMarkDead(MAX_ATTEMPTS)).toBe(true);
    expect(shouldMarkDead(9)).toBe(true);
  });

  it("decideFailure 给出状态与下一次时间", () => {
    const f = decideFailure(0, 3);
    expect(f.status).toBe("failed");
    expect(f.nextRunAtMs).toBe(600_000);
    const d = decideFailure(0, 8);
    expect(d.status).toBe("dead");
  });
});

describe("worker 锁过期与归属", () => {
  it("无锁/0 视为过期；达阈值过期；阈值内新鲜（边界 >=）", () => {
    expect(isLockStale(0, 1000, DEFAULT_STALLED_MS)).toBe(true);
    expect(isLockStale(100, 1099, 1000)).toBe(false); // 差 999 < 1000 新鲜
    expect(isLockStale(100, 1100, 1000)).toBe(true);  // 差 1000 恰达阈值 -> 过期
    expect(isLockStale(0, 5000)).toBe(true);
    expect(isLockStale(4001, 5000, 1000)).toBe(false); // 差 999
    expect(isLockStale(4000, 5000, 1000)).toBe(true);  // 差 1000
  });

  it("lockOwnedBy 识别精确/前缀；format/parse 心跳往返", () => {
    expect(lockOwnedBy("w1:123", "w1")).toBe(true);
    expect(lockOwnedBy("w10:1", "w1")).toBe(false); // 前缀不能跨 id
    expect(lockOwnedBy("w1", "w1")).toBe(true);
    expect(lockOwnedBy(undefined, "w1")).toBe(false);
    const v = formatLockValue("w1", 999);
    expect(v).toBe("w1:999");
    expect(parseLockHeartbeat(v)).toBe(999);
    expect(parseLockHeartbeat("garbage")).toBeNull();
    expect(parseLockHeartbeat(undefined)).toBeNull();
  });
});
