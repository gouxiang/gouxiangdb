// apps/web/src/node/useShellRuntime.ts
// 成品壳内本地内核实时态轮询 hook（W2 四态数据源）。
//
// 边界：
//   - 只依赖 react + shellBridge，不碰 store / 注册表；
//   - enabled=false（非壳：浏览器/fnOS/服务器）时返回全 null/noop 稳定对象，**不产生任何
//     effect/timer/invoke**，故非壳构建该模块虽被 import 也零副作用；
//   - SSR 安全：初始 status/info 全 null（renderToStaticMarkup 输出稳定），所有 invoke 都在
//     useEffect 内；卸载清 interval + cancelled 标志防 setState-after-unmount。

import { useCallback, useEffect, useState } from "react";
import {
  getShellInfo,
  localStatus,
  type LocalStatus,
  type ShellInfo,
} from "./shellBridge";

export interface ShellRuntime {
  /** gx:local_status 最近一次结果；未回首/非壳为 null。 */
  status: LocalStatus | null;
  /** gx:get_shell_info 结果（版本号等）；拉取失败不致命，保持 null。 */
  info: ShellInfo | null;
  /** 最近一次 localStatus 错误的中文信息（getShellInfo 失败不在此暴露）。 */
  error: string | null;
  /** 立即重拉一次 localStatus（起/停/连/断完成后由面板调用收口状态）。 */
  refresh: () => void;
}

const DISABLED_RUNTIME: ShellRuntime = {
  status: null,
  info: null,
  error: null,
  refresh: () => {},
};

/**
 * 轮询本地内核实时态。enabled=true 时：挂载先 getShellInfo（失败仅 info=null）再
 * localStatus，之后每 intervalMs 轮询一次；refresh() 立即重拉。
 */
export function useShellRuntime(enabled: boolean, intervalMs = 2000): ShellRuntime {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const pullStatus = async () => {
      try {
        const s = await localStatus();
        if (!cancelled) {
          setStatus(s);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "读取本机内核状态失败");
      }
    };

    // ShellInfo 失败不致命：info=null，status 轮询照常。
    void getShellInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    void pullStatus();

    const timer = setInterval(() => {
      void pullStatus();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void localStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "读取本机内核状态失败");
      });
  }, [enabled]);

  if (!enabled) return DISABLED_RUNTIME;
  return { status, info, error, refresh };
}
