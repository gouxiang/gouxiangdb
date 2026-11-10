// 桌面壳更新身份解析（#1295 阶段二）：仅在成品 Mac 壳内，把壳桥 ShellInfo 的
// platform/arch 映射成更新 API 认识的查询身份（channel=desktop-client + platform + arch）。
//
// 现网零变化铁律：
//   - 浏览器 / fnOS / 服务器构建没有 __TAURI_INTERNALS__，hasShell()=false，本模块恒返回 null，
//     更新请求与历史逐字一致（不带 channel/arch/platform 任何查询参）；
//   - 仅物理桌面壳内才解析出身份；壳 IPC 任何异常都 fail-closed 回 null（退回无参现状），
//     绝不因身份解析失败而阻断「检查更新」本身；
//   - 零 npm 依赖，只复用 node/shellBridge 薄桥；platform/arch 词表与更新 API 逐字一致，零转换。
import { getShellInfo, hasShell, type ShellInfo } from "../../node/shellBridge";

/** 桌面声明通道 id（与后端 strategies/desktopClient.ts CHANNEL_DESKTOP_CLIENT 逐字一致）。 */
export const DESKTOP_UPDATE_CHANNEL = "desktop-client";

/** 传给 AdminUpdateApi 三方法的身份参数（字段名与 client.ts 逐字对齐）。 */
export interface DesktopUpdateIdentity {
  channel: typeof DESKTOP_UPDATE_CHANNEL;
  arch: string;
  platform: string;
}

/**
 * 纯函数：把壳桥 ShellInfo 收敛为更新身份。
 * 抽成纯函数便于表驱动单测；platform/arch 原样透传（Rust 侧词表 darwin/win32/linux、
 * x64/arm64 与更新清单 ArtifactPlatform/ArtifactArch 已逐字对齐，这里不做任何改写）。
 */
export function toDesktopUpdateIdentity(info: ShellInfo): DesktopUpdateIdentity {
  return {
    channel: DESKTOP_UPDATE_CHANNEL,
    platform: info.platform,
    arch: info.arch,
  };
}

/**
 * 解析当前运行环境的桌面更新身份。
 * @returns 壳内返回身份对象；非壳环境或 IPC 失败一律返回 null（调用方按无参现状发请求）。
 */
export async function resolveDesktopUpdateIdentity(): Promise<DesktopUpdateIdentity | null> {
  // 总闸：非壳（浏览器/fnOS/服务器/SSR）立刻 null，连 IPC 都不触达。
  if (!hasShell()) return null;
  try {
    const info = await getShellInfo();
    return toDesktopUpdateIdentity(info);
  } catch {
    // fail-closed：壳在但命令异常（旧壳/桥故障），退回无参现状，不阻断检查更新。
    return null;
  }
}
