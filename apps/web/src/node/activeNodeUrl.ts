// apps/web/src/node/activeNodeUrl.ts
// 「服务端网址（对外访问地址）」在桌面壳里的正确取值（2026-10 戴总真机反馈）。
//
// 背景 bug：品牌外观面板「服务端网址 · 当前默认（自动识别）」原先直接用浏览器同源地址
// （window.location.origin）。浏览器/fnOS 下它就是用户访问服务器的地址，正确；但在桌面壳里
// 页面由壳在回环口（http://127.0.0.1:<随机口>）静态托管，无论活动上游是本机还是某台远端，
// origin 恒为壳回环口——连远端时也显示 127.0.0.1，对外完全不可访问，是误导。
//
// 正确口径（仅门控开启的桌面壳改变，门控关闭逐字节保持旧行为）：
//   - 活动节点是远端：显示该远端节点注册表保存的真实 baseURL 的 origin（如 http://192.168.31.15:3001）；
//   - 活动节点是本机：回环口不能对外，暂不显示自动地址（返回 ""，由「本机局域网地址探测」后续补）；
//   - 门控关闭（浏览器/fnOS/服务器）：仍用 window.location.origin，与现状一致。

import { launcherEnabled } from "./desktopGate";
import { getLauncherStore } from "./launcherStore";
import { activeEntry } from "./registry";

/** 取 http(s) URL 的 origin（scheme://host[:port]）；非法/非 http(s) 返回 ""。 */
export function originOfHttpUrl(raw: string): string {
  const s = raw?.trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch {
    return "";
  }
}

export interface BrandingAutoOriginArgs {
  /** 桌面启动器门控是否开启（门控关＝浏览器/fnOS/服务器）。 */
  enabled: boolean;
  /** 当前活动节点种类。 */
  kind: "local" | "remote";
  /** 浏览器同源地址（门控关时的旧真源）。 */
  browserOrigin: string;
  /** 壳远端活动节点的真实对外 origin（readActiveRemoteOrigin 的结果）。 */
  routedRemoteOrigin: string;
}

/**
 * 纯选择器：决定「服务端网址」自动识别该用哪个 origin。
 * - 门控关：恒返回 browserOrigin（旧行为，零变化）；
 * - 壳 + 远端：返回该远端真实 origin（取不到为 ""，面板据此隐藏自动块而非显示回环口）；
 * - 壳 + 本机：返回 ""（回环口不对外；LAN 地址探测未接入前不展示，避免 127.0.0.1 误导）。
 */
export function resolveBrandingAutoOrigin(args: BrandingAutoOriginArgs): string {
  if (!args.enabled) return args.browserOrigin;
  if (args.kind === "remote") return args.routedRemoteOrigin;
  return "";
}

/**
 * 成品壳 + 活动节点是远端时，返回该远端节点的真实对外 origin。
 * 门控关 / 本机节点 / SSR / 无 localStorage / 任何异常 → ""（fail-closed，绝不抛错炸面板）。
 */
export function readActiveRemoteOrigin(): string {
  if (!launcherEnabled() || typeof window === "undefined") return "";
  try {
    const entry = activeEntry(getLauncherStore().getState());
    if (entry?.kind !== "remote") return "";
    return originOfHttpUrl(entry.baseURL);
  } catch {
    return "";
  }
}
