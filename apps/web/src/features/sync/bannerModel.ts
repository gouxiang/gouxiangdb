// apps/web/src/features/sync/bannerModel.ts
// 顶部 12px 同步横幅的纯展示模型：从六态 + 在线位派生「是否显示 / 文案 / 色调 / 图标 / 点击去哪」。
// 抽成纯函数便于在 node 环境穷举单测（无 DOM）。默认（未启用）返回 null——组件据此逐字节回退旧二态。

import type { SyncPhase } from "../../store/sync";

export type SyncBannerTone = "offline" | "warning" | "danger";

export interface SyncBannerModel {
  /** 细条文案。 */
  text: string;
  /** 语义色调（仅在同色系深条内做图标/细节区分，不改 12px 高度）。 */
  tone: SyncBannerTone;
  /** 点击细条打开同步中心后应聚焦的分区。 */
  tab: "status" | "incoming" | "conflicts";
}

/**
 * 纯函数：六态 → 横幅模型；在线且健康（online/syncing）与未启用返回 null（零像素）。
 *
 * 规则：
 *   - phase=null / online / syncing      → null（在线不占位，与旧「在线 return null」一致）。
 *   - quarantined                        → danger 条（即便在线也提示，失权最需人工介入）→ incoming。
 *   - error                              → warning 条（在线但同步出错退避）→ status。
 *   - offlinePending                     → offline 条（有远端，恢复后自动同步）→ status。
 *   - offlineLocalOnly                   → offline 条（纯本地，提示改动只在本机）→ status。
 * 冲突由命令式弹窗独立承载，不占横幅（phase 不因 conflictCount 改变）。
 */
export function bannerModel(phase: SyncPhase | null): SyncBannerModel | null {
  switch (phase) {
    case "quarantined":
      return {
        text: "部分改动因权限变更未生效，点击处理",
        tone: "danger",
        tab: "incoming",
      };
    case "error":
      return { text: "同步遇到问题，点击查看", tone: "warning", tab: "status" };
    case "offlinePending":
      return { text: "网络已断开，改动将在恢复后同步", tone: "offline", tab: "status" };
    case "offlineLocalOnly":
      return { text: "当前离线，改动仅保存在本机", tone: "offline", tab: "status" };
    case "online":
    case "syncing":
      return null;
    default:
      return null;
  }
}
