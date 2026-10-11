// apps/api/src/domain/update/channel.ts
// ChannelDetector：识别当前部署通道（DESIGN §3.1 六级优先级，第一条命中生效）。
//
// 纯函数、不出网、不读文件系统、不读版本：env / node 平台架构全部由调用方注入，便于表驱动单测。
// 优先级 2（请求显式声明 remoteDeclarable 通道）不在本地探测内——那是桌面通道，服务端无法自证，
// 由 service 结合注册表的 declarableStrategy() 单独裁决（DESIGN §3.1 表第 2 行）。

import type { ArtifactPlatform } from "@gx/shared-types";
import type { ChannelDetection } from "./types.js";

export const CHANNEL_FNOS_FPK = "fnos-fpk";
export const CHANNEL_SOURCE_BARE = "source-bare";
export const CHANNEL_DESKTOP_CLIENT = "desktop-client";

/** 可由「本地证据」识别的通道（desktop-client 只能远程声明，不在此列）。 */
export const LOCAL_CHANNEL_IDS: readonly string[] = [
  CHANNEL_FNOS_FPK,
  CHANNEL_SOURCE_BARE,
];

/** 飞牛 manifest platform 词汇 → 统一（node/manifest）架构词汇（DESIGN §3.1 映射表，不能猜）。 */
export function mapFnosArch(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "x64" || v === "x86" || v === "amd64") return "x64";
  if (v === "arm64" || v === "arm" || v === "aarch64") return "arm64";
  return null;
}

/** Node process.arch 归一到统一架构词汇；无法识别返回原值（不猜）。 */
export function normalizeNodeArch(nodeArch: string): string {
  const mapped = mapFnosArch(nodeArch);
  return mapped ?? nodeArch;
}

export interface DetectChannelArgs {
  env?: NodeJS.ProcessEnv;
  nodeArch: string;
  nodePlatform: string;
  /**
   * 当前注册表内「可本地识别」的通道 id 白名单（优先级 1 合法性校验用）。
   * 默认 LOCAL_CHANNEL_IDS；注入测试集可模拟未来通道。
   */
  knownLocalChannels?: readonly string[];
}

/**
 * 本地通道探测。优先级（DESIGN §3.1）：
 *   1 GX_UPDATE_CHANNEL 显式合法 id（非法值 warn 并忽略，绝不退出）
 *   3 GX_DEPLOY_CHANNEL=<已知本地通道>（fpk 由 cmd/main 在启动 node 前 export）
 *   4 TRIM_APPDEST / TRIM_DATA_SHARE_PATHS 含 /@appshare/ 或 /appcenter（老 fpk 兜底）
 *   5 source-bare 部署标记（GX_DEPLOY_CHANNEL=source-bare 已被 3 覆盖；预留 GX_DEPLOY_CHANNEL_FILE）
 *   6 都不命中 → unknown（正常，非错误）
 */
export function detectChannel(args: DetectChannelArgs): ChannelDetection {
  const {
    env = {},
    nodeArch,
    nodePlatform,
    knownLocalChannels = LOCAL_CHANNEL_IDS,
  } = args;

  const evidence: string[] = [];
  const warnings: string[] = [];
  const arch = normalizeNodeArch(nodeArch);
  const platform: ArtifactPlatform | string = nodePlatform;

  const known = new Set(knownLocalChannels);

  // 优先级 1：运维强制覆盖。只接受注册表内的本地通道 id；非法值告警并忽略。
  const explicit = env.GX_UPDATE_CHANNEL?.trim();
  if (explicit) {
    if (known.has(explicit)) {
      evidence.push("GX_UPDATE_CHANNEL");
      return { channelId: explicit, arch, platform, evidence, warnings };
    }
    warnings.push(
      `GX_UPDATE_CHANNEL 取值「${explicit}」不在已知通道列表中，已忽略`,
    );
  }

  // 优先级 3：部署标记（cmd/main export 的 GX_DEPLOY_CHANNEL）。
  const deployChannel = env.GX_DEPLOY_CHANNEL?.trim();
  if (deployChannel && known.has(deployChannel)) {
    evidence.push("GX_DEPLOY_CHANNEL");
    return { channelId: deployChannel, arch, platform, evidence, warnings };
  }

  // 优先级 4：飞牛启发式证据（老版本 fpk 未 export GX_DEPLOY_CHANNEL 时兜底）。
  // 真机实测路径（docs/baseline/gate6-evidence/2026-09-18-*）：
  //   TRIM_APPDEST≈/vol1/@appcenter/<name>，TRIM_DATA_SHARE_PATHS 含 /vol1/@appshare/<name>
  // 标记词是【带 @】的 @appcenter / @appshare；另保留设计稿字面 /appcenter 兜底其它卷布局。
  const trimAppDest = env.TRIM_APPDEST ?? "";
  const trimShare = env.TRIM_DATA_SHARE_PATHS ?? "";
  const trimHints = ["@appcenter", "@appshare", "/appcenter"];
  const looksFnos = trimHints.some(
    (hint) => trimAppDest.includes(hint) || trimShare.includes(hint),
  );
  if (looksFnos) {
    evidence.push("TRIM_*");
    return { channelId: CHANNEL_FNOS_FPK, arch, platform, evidence, warnings };
  }

  // 优先级 6：无法识别为已知本地通道。
  evidence.push("none");
  return { channelId: "unknown", arch, platform, evidence, warnings };
}
