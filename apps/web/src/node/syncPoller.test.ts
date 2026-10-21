// apps/web/src/node/syncPoller.test.ts
// 轮询调度内核：门控关零定时器、disabled 停轮询、瞬时错误继续、切源重查。注入假 timer。
import { describe, it, expect, vi } from "vitest";
import { startSyncPoller } from "./syncPoller";
import { disabledSyncStatus, type LocalSyncStatus } from "../api/localSync";

function enabledStatus(over: Partial<LocalSyncStatus> = {}): LocalSyncStatus {
  return { ...disabledSyncStatus(), enabled: true, ...over };
}

/** 手工驱动的假 setInterval：返回 id，flush() 触发一次回调。 */
function fakeTimers() {
  let seq = 0;
  const ticks = new Map<number, () => void>();
  return {
    setInterval: vi.fn((fn: () => void) => {
      const id = ++seq;
      ticks.set(id, fn);
      return id;
    }),
    clearInterval: vi.fn((id: unknown) => {
      ticks.delete(id as number);
    }),
    pendingCount: () => ticks.size,
    flush: () => {
      for (const fn of [...ticks.values()]) fn();
    },
  };
}

function flushMicro() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe("startSyncPoller 门控", () => {
  it("enabled=false 不建定时器、不取数（默认零行为）", () => {
    const timers = fakeTimers();
    const fetchStatus = vi.fn(async () => enabledStatus());
    startSyncPoller({
      enabled: false,
      intervalMs: 5000,
      fetchStatus,
      onStatus: vi.fn(),
      timers,
    });
    expect(timers.setInterval).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("enabled=true 立即探一次并建一个周期定时器", async () => {
    const timers = fakeTimers();
    const fetchStatus = vi.fn(async () => enabledStatus());
    startSyncPoller({ enabled: true, intervalMs: 5000, fetchStatus, onStatus: vi.fn(), timers });
    await flushMicro();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(1);
  });
});

describe("disabled 闭锁", () => {
  it("首次探活 disabled → 回传一次、清定时器、不再周期取数", async () => {
    const timers = fakeTimers();
    const fetchStatus = vi.fn(async () => disabledSyncStatus());
    const onStatus = vi.fn();
    const onDisabled = vi.fn();
    startSyncPoller({ enabled: true, intervalMs: 5000, fetchStatus, onStatus, onDisabled, timers });
    await flushMicro();
    expect(onStatus).toHaveBeenCalledWith(disabledSyncStatus());
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);
    timers.flush();
    expect(fetchStatus).toHaveBeenCalledTimes(1); // 不再周期取数
  });
});

describe("错误与防堆积", () => {
  it("单轮抛错（非 disabled）不停止轮询，下轮继续", async () => {
    const timers = fakeTimers();
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(enabledStatus());
    const onError = vi.fn();
    startSyncPoller({ enabled: true, intervalMs: 5000, fetchStatus, onStatus: vi.fn(), onError, timers });
    await flushMicro();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(1); // 定时器仍在
    timers.flush();
    await flushMicro();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});

describe("切源 restart", () => {
  it("disabled 闭锁后 restart 重置并立即重探；若启用则重建定时器", async () => {
    const timers = fakeTimers();
    let enabled = false;
    const fetchStatus = vi.fn(async () => (enabled ? enabledStatus() : disabledSyncStatus()));
    const handle = startSyncPoller({
      enabled: true, intervalMs: 5000, fetchStatus, onStatus: vi.fn(), onDisabled: vi.fn(), timers,
    });
    await flushMicro();
    expect(timers.pendingCount()).toBe(0);

    enabled = true;
    handle.restart();
    await flushMicro();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(timers.pendingCount()).toBe(1);
  });

  it("stop 后定时器被清、不再响应 tick", async () => {
    const timers = fakeTimers();
    const handle = startSyncPoller({
      enabled: true, intervalMs: 5000, fetchStatus: vi.fn(async () => enabledStatus()), onStatus: vi.fn(), timers,
    });
    await flushMicro();
    expect(timers.pendingCount()).toBe(1);
    handle.stop();
    expect(timers.clearInterval).toHaveBeenCalled();
    expect(timers.pendingCount()).toBe(0);
  });
});
