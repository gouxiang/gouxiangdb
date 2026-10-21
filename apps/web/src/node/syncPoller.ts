// apps/web/src/node/syncPoller.ts
// useSyncStatus 的轮询调度【纯内核】：与 React/DOM 解耦，定时器/取数均可注入，node 环境单测。
//
// 复刻 useShellHealth 的纪律，并加两条同步专属规则：
//   - enabled=false（非壳 / 副本功能未确认）→ 不建任何 timer、不发任何请求（默认零行为）；
//   - 首次探活若确认功能 disabled（404/SYNC_DISABLED 已在 api 层收敛为 {enabled:false}）→
//     立刻停止轮询并清定时器，绝不对无同步能力的节点每 5s 打一次；onDisabled 回调让外层回零 store。
//   - 切源（resolver emit）→ restart()：重置 disabled 闭锁、立即重探一次（新节点可能启用）。
//   - inFlight 防慢网堆积；单轮网络/服务错误不致命，下一轮继续（不 stop）。

import type { LocalSyncStatus } from "../api/localSync";

export interface SyncPollerTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export interface SyncPollerOptions {
  /** 是否允许轮询（壳内 + 副本语境门控通过）。false 时 start 立即返回，零副作用。 */
  enabled: boolean;
  intervalMs: number;
  fetchStatus: () => Promise<LocalSyncStatus>;
  onStatus: (status: LocalSyncStatus) => void;
  /** 探活确认功能关闭（404/未启用）时回调一次；外层据此回零运行时态、卸载 UI。 */
  onDisabled?: () => void;
  /** 单轮失败（非 disabled，如网络/5xx）回调，外层记 lastError/退避展示；不停止轮询。 */
  onError?: (e: unknown) => void;
  timers?: SyncPollerTimers;
}

export interface SyncPollerHandle {
  /** 停轮询、清定时器。幂等。 */
  stop: () => void;
  /** 切源后调用：重置 disabled 闭锁，立即重探并按需重建定时器。enabled=false 时空操作。 */
  restart: () => void;
}

/** 纯内核：启动同步状态轮询。 */
export function startSyncPoller(opts: SyncPollerOptions): SyncPollerHandle {
  const timers: SyncPollerTimers =
    opts.timers ??
    (typeof setInterval === "function" && typeof clearInterval === "function"
      ? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>) }
      : { setInterval: () => 0, clearInterval: () => {} });

  let timer: unknown = null;
  let inFlight = false;
  let stopped = false;
  /** 一旦确认 disabled，停掉周期轮询；restart（切源）才解除。 */
  let disabledLatch = false;

  const clearTimer = () => {
    if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  };

  const probe = async () => {
    if (stopped || inFlight || disabledLatch) return;
    inFlight = true;
    try {
      const status = await opts.fetchStatus();
      if (stopped) return;
      if (!status.enabled) {
        // 功能未启用/端点不存在：收敛一次、永久停轮询直到切源或重新使能。
        disabledLatch = true;
        clearTimer();
        opts.onStatus(status);
        opts.onDisabled?.();
        return;
      }
      opts.onStatus(status);
    } catch (e) {
      if (stopped) return;
      opts.onError?.(e); // 瞬时错误不置 disabledLatch，下轮自愈。
    } finally {
      inFlight = false;
    }
  };

  const arm = () => {
    if (!opts.enabled || stopped) return;
    disabledLatch = false;
    clearTimer();
    void probe();
    timer = timers.setInterval(() => {
      void probe();
    }, opts.intervalMs);
  };

  if (!opts.enabled) {
    return { stop: () => {}, restart: () => {} };
  }

  arm();

  return {
    stop: () => {
      stopped = true;
      clearTimer();
    },
    restart: () => {
      if (!opts.enabled || stopped) return;
      disabledLatch = false;
      clearTimer();
      void probe();
      if (!disabledLatch) {
        timer = timers.setInterval(() => {
          void probe();
        }, opts.intervalMs);
      }
    },
  };
}
