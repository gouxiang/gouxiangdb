// apps/web/src/hooks/useSyncStatus.ts
// 离线同步状态轮询的 React 薄包装：门控 + 在线位订阅 + 纯内核 poller + 切源重查。
//
// 挂载点纪律（默认零行为的关键）：本 hook 只在桌面壳且存在活动节点时被 ShellStatusDock
// 的 DockInner 挂载——浏览器/非壳构建下调用方根本不渲染，本 hook 不被 import 到任何常驻树，
// 故 enabled 恒 false：不建 timer、不发 fetch、不订阅 resolver、不写 localStorage 新键。
//
// 轮询：5000ms（本地侧车状态报告，离线也准），enabled 收敛自「壳门控 && 副本语境」；首次探活确认
// disabled（404 收敛值）即停轮询。切源（dataSourceResolver emit）重置运行时态并立即重探（新节点可能启用）。
//
// 冲突明细是【侧车代理远端】的在线操作，与本地状态轮询解耦：
//   - 仅当 report.conflictCount>0 且浏览器在线时才拉 conflict 队列；计数归零立即清队列；
//   - 离线 / 侧车代理 502（远端不可达）时保留上一次拉到的队列做只读展示，绝不清空、绝不刷错；
//   - 隔离区明细在抽屉打开时按需拉取，不进 5s 轮询，保持轮询纯本地、轻量。

import { useEffect } from "react";
import { getLocalSyncStatus, listIncoming } from "../api/localSync";
import { useSyncStore } from "../store/sync";
import { startSyncPoller } from "../node/syncPoller";
import { syncShellGateEnabled } from "../node/syncGate";
import { dataSourceResolver } from "../node/datasource";

export const SYNC_POLL_INTERVAL_MS = 5000;

function readNavigatorOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

export interface UseSyncStatusOptions {
  /** 显式门控（测试 / 宿主已判）；缺省由壳门控现场决定。 */
  enabled?: boolean;
  intervalMs?: number;
}

/**
 * 挂载同步状态轮询。返回当前是否处于「壳 + 副本已启用」活动态（供宿主决定是否渲染入口）。
 * 门控关时不产生任何副作用。
 */
export function useSyncStatus(opts: UseSyncStatusOptions = {}): boolean {
  const shell = syncShellGateEnabled();
  const enabled = (opts.enabled ?? shell) && shell;
  const intervalMs = opts.intervalMs ?? SYNC_POLL_INTERVAL_MS;

  // 订阅选择器拆细，避免在 effect 闭包里拿陈旧快照：actions 引用稳定，活动位单独读。
  const setSyncSnapshot = useSyncStore((s) => s.setSyncSnapshot);
  const resetRuntime = useSyncStore((s) => s.resetRuntime);
  const setOnline = useSyncStore((s) => s.setOnline);
  const replaceConflicts = useSyncStore((s) => s.replaceConflicts);

  useEffect(() => {
    if (!enabled) return;

    // ① 在线位：先同步当前值，再监听 online/offline（与 useOnlineStatus 同源语义）。
    setOnline(readNavigatorOnline());
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    if (typeof window !== "undefined") {
      window.addEventListener("online", onUp);
      window.addEventListener("offline", onDown);
    }

    // ② 轮询内核：只轮询本地 status（离线也准）。冲突明细是侧车代理远端的在线操作，
    //    仅在「报告有冲突计数 && 浏览器在线」时顺带拉取；计数归零立即清队列；
    //    离线 / 代理 502 / 瞬时错误一律保留上一次队列只读展示，绝不清空或刷错。
    const poller = startSyncPoller({
      enabled: true, // 外层已门控；内核内部 disabled 收敛由 fetchStatus 回 {enabled:false} 决定。
      intervalMs,
      fetchStatus: () => getLocalSyncStatus(),
      onStatus: (status) => {
        const online = readNavigatorOnline();
        setSyncSnapshot(status, online);
        if (!status.enabled) return;
        if (status.conflictCount > 0 && online) {
          void listIncoming("conflict")
            .then((list) => replaceConflicts(list.items))
            .catch(() => {
              // 502（远端不可达）/ 瞬时错误：保留旧冲突队列，下轮在线自愈。
              // 404 已在 api 层收敛为空列表（功能 disabled 时不会进入本分支）。
            });
        } else if (status.conflictCount === 0) {
          replaceConflicts([]);
        }
      },
      onDisabled: () => resetRuntime(),
      onError: () => {
        // 瞬时网络/服务错误：不写假状态；phase 仍可由在线位/上次报告派生，下一轮自愈。
      },
    });

    // ③ 切源：本地↔远端节点切换时先回零（避免把旧节点报告错配到新节点），再立即重探。
    const unsubscribeResolver = dataSourceResolver.subscribe(() => {
      resetRuntime();
      poller.restart();
    });

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onUp);
        window.removeEventListener("offline", onDown);
      }
      unsubscribeResolver();
      poller.stop();
    };
  }, [enabled, intervalMs, setSyncSnapshot, resetRuntime, setOnline, replaceConflicts]);

  return enabled;
}
