// apps/web/src/node/syncGate.ts
// 离线同步前端切片的唯一总门控（beta.2 S4/S5-WEB）。
//
// 铁律：浏览器 / fnOS / 服务器部署面**默认零行为变化**——只有同时满足
//   ① 构建在桌面壳启动器标志下（VITE_NODE_LAUNCHER 显式 "1"/"true"），且
//   ② 运行在成品桌面壳内（Tauri invoke 通道存在），且
//   ③ 状态端点确认「本地副本离线功能」已启用（fail-closed，探活前一律视为未就绪），
// 才允许出现任何同步 UI（横幅 / 同步中心入口 / 抽屉 / 冲突弹窗）与任何轮询网络。
//
// 三层刻意拆开：
//   - isSyncShell：构建+壳，决定 React 树里是否挂载 useSyncStatus（是否允许轮询）。
//   - isSyncActive：再叠「副本功能已确认启用」，决定是否渲染任何可见 UI / 入口。
//   - syncShellGateEnabled()：生产默认，从 import.meta.env + Tauri 桥现场读（同 desktopGate 范式）。
//
// 纯布尔运算，node 环境可直接单测，不依赖 DOM/Tauri（生产默认函数除外，它只做薄读取）。

import { launcherEnabled } from "./desktopGate";
import { hasShell } from "./shellBridge";

/** 第①+②层：是否处于「桌面壳」语境。为真才允许挂载状态轮询；浏览器面恒 false。 */
export function isSyncShell(input: { launcherEnabled: boolean; shellPresent: boolean }): boolean {
  // 两条件与：缺任一都不是桌面壳语境（fail-closed）。
  return input.launcherEnabled === true && input.shellPresent === true;
}

/**
 * 第③层：副本离线功能是否已由状态端点确认启用。
 * 必须在 isSyncShell 通过的前提下再与；探活未知 / 明确关闭 / 404 SYNC_DISABLED 一律 false。
 */
export function isSyncActive(input: { shell: boolean; replicaEnabled: boolean }): boolean {
  return input.shell === true && input.replicaEnabled === true;
}

/**
 * 生产默认：当前是否在桌面壳内（第①+②层）。
 * 浏览器构建（不注入 VITE_NODE_LAUNCHER）或非壳 WebView 恒为 false——零挂载、零轮询、零入口。
 * 允许注入两参数（测试 / 未来壳运行时覆盖）。
 */
export function syncShellGateEnabled(overrides?: {
  launcherFlag?: string;
  shellPresent?: boolean;
}): boolean {
  const launcher =
    overrides?.launcherFlag !== undefined
      ? launcherEnabled(overrides.launcherFlag)
      : launcherEnabled();
  const shell = overrides?.shellPresent !== undefined ? overrides.shellPresent : hasShell();
  return isSyncShell({ launcherEnabled: launcher, shellPresent: shell });
}
