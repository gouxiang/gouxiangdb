// apps/web/src/node/useShellHealth.ts
// 桌面壳底部状态条的「连接稳定度」数据源：对当前活动上游做轻量同源健康探测。
//
// 为什么前端直接 fetch 就够（无需 Rust 改动）：
//   成品壳把 web 静态托管在 127.0.0.1 随机口，并把 /healthz 反代到「当前单活上游」
//   （本机内核或被连远端，见 shell_server.rs 业务前缀表）。浏览器全程同源，一次
//   GET /healthz 既测了「浏览器→壳→上游」整段往返延迟（performance.now 计时），
//   又从返回体拿到核心版本号（healthz.ts 返回 {status,service,version,time}，免鉴权、
//   不查库，毫秒级、极廉价）。故实时 ms 与核心版本同源一次取得。
//
// 边界（与 useShellRuntime 同纪律）：
//   - enabled=false（非壳：浏览器/fnOS/服务器）返回稳定 null 态，**零 timer/fetch**；
//   - SSR 安全：首拍 ping/version/ok 为初始值，所有 fetch 都在 useEffect 内；
//   - 卸载清 interval + cancelled 标志，防 setState-after-unmount；
//   - 单次失败不抛错：ok=false、ping=null（信号格显离线），下轮自动重试。

import { useEffect, useState } from "react";

/** /healthz 返回体的最小结构（只取底部条需要的字段）。 */
interface HealthBody {
  status?: string;
  version?: string;
}

export interface ShellHealth {
  /** 最近一次往返毫秒（整数）；探测未回首拍或失败为 null。 */
  ping: number | null;
  /** 核心（API/内核）版本号，来自 /healthz 返回体；未取得为 null。 */
  version: string | null;
  /** 最近一次探测是否成功（2xx 且 status=ok）。 */
  ok: boolean;
}

const UNKNOWN_HEALTH: ShellHealth = { ping: null, version: null, ok: false };

/**
 * 周期探测当前活动上游健康。
 * @param enabled    仅成品壳内为 true
 * @param intervalMs 轮询间隔（默认 3000ms：足够呈现「实时毫秒延迟变化」，又不刷上游）
 */
export function useShellHealth(enabled: boolean, intervalMs = 3000): ShellHealth {
  const [health, setHealth] = useState<ShellHealth>(UNKNOWN_HEALTH);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window !== "undefined" && typeof window.fetch !== "function") return;
    let cancelled = false;
    let inFlight = false;

    const probe = async () => {
      // 上一轮还没回来就跳过本轮，避免慢网下请求堆积。
      if (inFlight) return;
      inFlight = true;
      const start =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      try {
        // cache:no-store 保证每次都是真实往返，不被 WebKit 磁盘/内存缓存短路出 0ms。
        const res = await fetch("/healthz", {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body = (await res.json().catch(() => null)) as HealthBody | null;
        const end =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        if (cancelled) return;
        const good = res.ok && (!body || body.status === undefined || body.status === "ok");
        setHealth({
          ping: good ? Math.max(0, Math.round(end - start)) : null,
          version: typeof body?.version === "string" ? body.version : null,
          ok: good,
        });
      } catch {
        if (!cancelled) setHealth((h) => ({ ping: null, version: h.version, ok: false }));
      } finally {
        inFlight = false;
      }
    };

    void probe();
    const timer = setInterval(() => {
      void probe();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  if (!enabled) return UNKNOWN_HEALTH;
  return health;
}
