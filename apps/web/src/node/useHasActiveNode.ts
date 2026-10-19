// apps/web/src/node/useHasActiveNode.ts
//
// 「当前是否有活动节点」只读订阅（2026-10-19 修断开死锁）。
//
// Bug 背景：在节点切换抽屉里断开**当前活动节点**后，注册表 activeNodeId 置 null、壳代理上游
// 切到 none（之后业务 API 全 503）。但 resolver 会惰性兜底回 local、本地 gx-auth token 仍在，
// 旧的 RequireAuth 只看「活动数据源有没有 token」，于是误判已登录、继续把用户留在业务页；
// 底部状态条又因「无活动节点」整条隐藏（含节点切换入口）→ 误操作后彻底卡死、无法切换节点。
//
// 修法：桌面壳内以**注册表 activeNodeId** 为「连着某个节点」的唯一事实——没有活动节点就不算
// 进入了工作区（RequireNode 据此时时回 /launcher），与本地/远端 token 是否还在解耦。
//
// 零变化：门控关（浏览器/fnOS/服务器）恒 true（不构造启动器仓库，路由行为与今天逐字节一致）；
// SSR/无 window/单例不可用也恒 true（fail-open，避免把现网/测试误弹到启动器）。
import { useSyncExternalStore } from "react";
import { launcherEnabled } from "./desktopGate";
import { hasShell } from "./shellBridge";
import { getLauncherStore } from "./launcherStore";
import type { NodeRegistryState } from "./registry";

/**
 * 纯判定（可单测）：是否存在活动节点。
 * 门控关 / 非壳环境恒 true（fail-open，现网浏览器/fnOS 不引入活动节点概念）；
 * 只有「门控开 && 物理在壳内」时才以注册表 activeNodeId 为准——为 null 即未连接，
 * 应由路由守卫弹回 /launcher。
 */
export function hasActiveNodeFor(gateOn: boolean, inShell: boolean, state: NodeRegistryState | null | undefined): boolean {
  if (!gateOn || !inShell) return true;
  return !!state && state.activeNodeId != null;
}

/**
 * 无需活动节点即可停留的页面前缀（精确 + 前缀两类）：
 * 节点选择页 /launcher 自身，以及所有公开匿名页（分享 /s、/share，加入 /join，邀请 /invite）。
 * 注意：/login **不**豁免——登录页断开节点后也必须回启动器（这是登录页断开死锁的修复点）。
 */
export const NODE_GATE_EXEMPT_PREFIXES = ["/launcher", "/s/", "/share/", "/join/", "/invite/"] as const;

/** 纯判定：给定路径是否豁免「必须有活动节点」。 */
export function isNodeGateExemptPath(pathname: string): boolean {
  return (
    pathname === "/launcher" ||
    NODE_GATE_EXEMPT_PREFIXES.some(
      (p) => p.endsWith("/") && (pathname === p.replace(/\/$/, "") || pathname.startsWith(p)),
    )
  );
}

function subscribe(onChange: () => void): () => void {
  // 门控关/非壳：没有活动节点这一说，不订阅任何仓库（零副作用）。
  if (!launcherEnabled() || !hasShell()) return () => undefined;
  if (typeof window === "undefined") return () => undefined;
  try {
    return getLauncherStore().subscribe(onChange);
  } catch {
    return () => undefined;
  }
}

function readHasActive(): boolean {
  const gateOn = launcherEnabled();
  const inShell = hasShell();
  if (!gateOn || !inShell) return true;
  if (typeof window === "undefined") return true;
  try {
    // 注册表不可变、每个动作后整体替换；只认 activeNodeId（是否指向某个已注册节点由注册表
    // parse/connect/disconnect 自身保证不悬空）。
    return hasActiveNodeFor(gateOn, inShell, getLauncherStore().getState());
  } catch {
    // 单例/存储不可用时 fail-open：交给既有 token 守卫，避免把用户误锁在启动器外。
    return true;
  }
}

/** 当前是否存在活动节点。仅门控开且物理在 Tauri 壳内才可能为 false；其余环境恒 true。 */
export function useHasActiveNode(): boolean {
  return useSyncExternalStore(subscribe, readHasActive, () => true);
}
