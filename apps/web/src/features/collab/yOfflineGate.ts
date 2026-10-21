// apps/web/src/features/collab/yOfflineGate.ts
// 离线 Yjs 累积（gx-y，YN9 / S6-WEB-a）的唯一 fail-closed 门控，仿 node/desktopGate.ts。
//
// 铁律：普通浏览器在线态 / fnOS / 服务器部署面**默认关闭**——构建时不注入 VITE_OFFLINE_Y=1，
// 则：
//   · 不建离线本地 Y 会话（VITE_COLLAB 未开时 roomId 仍为 null）；
//   · 不写任何 gx-y:* localStorage；
//   · 文档编辑器的协同 active 判定仍是仅 "connected"，与引入前逐字一致。
// 只有桌面副本 / 壳语境的构建显式注入该标志（与 VITE_NODE_LAUNCHER 同一条注入链）才打开。
//
// 纯布尔运算 + 一个读 import.meta.env 的薄默认，node 环境可直接单测，不依赖 DOM。

/** 离线 Y 累积门控构建标志：仅显式 "1" 才开启。 */
export const Y_OFFLINE_FLAG = "VITE_OFFLINE_Y";

/**
 * 纯函数：判定门控标志原始值是否视为开启。
 * 只认真值 "1"（兼容 "true"），大小写不敏感；undefined / 空串 / "0" 均为关。
 */
export function isYOfflineFlagEnabled(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * 生产判定：从构建环境读标志。默认（现网任何构建都不注入）恒为 false。
 * @param flag 允许显式注入（壳运行时值覆盖、测试注入）。
 */
export function yOfflineEnabled(flag?: string): boolean {
  if (flag !== undefined) return isYOfflineFlagEnabled(flag);
  const env =
    typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env.VITE_OFFLINE_Y as string | undefined)
      : undefined;
  return isYOfflineFlagEnabled(env);
}

/** 需要绑定 Y.Doc 的协同会话状态。 */
export type CollabBindingStatus = "connected" | "reconnecting" | "offline" | "connecting" | "denied" | "idle";

/**
 * 文档/画布编辑器是否应把 Y.Doc 绑定到编辑器：
 *   · "connected" 恒为 true（门控关时的既有行为，逐字不变）；
 *   · 门控开时，连接中 / 重连中 / 离线（等退避）也绑定——离线编辑正是本特性的目标；
 *   · "denied"（被拒终态）/"idle" 恒 false；
 *   · 门控关时，除 "connected" 外一律 false —— 与引入前的 `status === "connected"` 等价。
 *
 * @param enabled 默认读构建门控；画布刀（#942）可显式注入复用同一判定。
 */
export function isCollabBindingStatus(
  status: CollabBindingStatus,
  enabled: boolean = yOfflineEnabled(),
): boolean {
  if (status === "connected") return true;
  if (!enabled) return false;
  return status === "connecting" || status === "reconnecting" || status === "offline";
}
