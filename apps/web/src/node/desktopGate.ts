// apps/web/src/node/desktopGate.ts
// 启动器 UI 的唯一总门控（DESIGN-MACOS-APP.md §8.5、主设计 §15.1 NodeModeGate）。
//
// 铁律：浏览器 / fnOS / 服务器部署面**默认关闭**——构建时不注入 VITE_NODE_LAUNCHER=1，
// 整个启动器界面（欢迎/添加节点/节点列表/悬浮气泡）不渲染、不占路由、不产生任何行为变化。
// 只有桌面壳（D 阶段由 Tauri 注入显式标志）才打开。
//
// 纯布尔运算 + 一个读 import.meta.env 的薄默认，node 环境可直接单测，不依赖 DOM/Tauri。

/** 桌面启动器门控构建标志：仅显式 "1" 才开启，未设/空/其它值一律关闭（fail-closed）。 */
export const LAUNCHER_FLAG = "VITE_NODE_LAUNCHER";

/**
 * 纯函数：判定门控标志原始值是否视为开启。
 * 只认真值 "1"（兼容 "true"），大小写不敏感；undefined / 空串 / "0" 均为关。
 */
export function isLauncherFlagEnabled(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * 生产判定：从构建环境读标志。默认（现网任何构建都不注入）恒为 false。
 * @param flag 允许显式注入（桌面壳将来可用 Tauri command 的运行时值覆盖、测试注入）。
 */
export function launcherEnabled(flag?: string): boolean {
  if (flag !== undefined) return isLauncherFlagEnabled(flag);
  const env =
    typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env.VITE_NODE_LAUNCHER as string | undefined)
      : undefined;
  return isLauncherFlagEnabled(env);
}
