// apps/api/src/domain/update/strategies/fnosFpk.ts
// 飞牛 fnOS fpk 成品包通道——当前唯一注册的更新策略（DESIGN §3.3 差异对照第一列）。
//
// 通道硬约束（违反即坏）：
//   1. artifact 匹配：arch 严格相等且 platform 必须是 linux；【不接受 any】——fpk 内含
//      better-sqlite3 / Prisma / vec0 原生二进制，platform 禁 all 是飞牛硬性要求（§3.3）。
//   2. 版本比较只允许调 @gx/shared-types 的 compareVersions / decideUpdate，禁止另写。
//   3. 安装指引文案只允许取 installGuide.ts 的统一装配，本文件不散写中文步骤。

import {
  compareVersions,
  decideUpdate,
  type ArtifactManifest,
  type ManualInstallGuideDTO,
  type ReleaseManifest,
} from "@gx/shared-types";
import { CHANNEL_FNOS_FPK, mapFnosArch } from "../channel.js";
import { renderFnosUploadGuide } from "../installGuide.js";
import type { InstallGuideContext, SelectReleaseContext, UpdateStrategy } from "./types.js";

export const fnosFpkStrategy: UpdateStrategy = {
  channelId: CHANNEL_FNOS_FPK,
  // 本地自识别通道：服务端凭 env/证据自认，不允许请求方远程声明（DESIGN §3.1 优先级 2 不含它）。
  remoteDeclarable: false,
  installGuideKind: "fnos-upload",

  claimFromEnv(env: NodeJS.ProcessEnv): string | null {
    // 与 ChannelDetector 的启发式对齐（主识别仍以 detectChannel 为准，本方法仅注册期用途）。
    if (env.GX_UPDATE_CHANNEL?.trim() === CHANNEL_FNOS_FPK) return "GX_UPDATE_CHANNEL";
    if (env.GX_DEPLOY_CHANNEL?.trim() === CHANNEL_FNOS_FPK) return "GX_DEPLOY_CHANNEL";
    const hints = ["@appcenter", "@appshare", "/appcenter"];
    const appDest = env.TRIM_APPDEST ?? "";
    const sharePaths = env.TRIM_DATA_SHARE_PATHS ?? "";
    if (hints.some((h) => appDest.includes(h) || sharePaths.includes(h))) return "TRIM_*";
    return null;
  },

  selectRelease(ctx: SelectReleaseContext): ReleaseManifest | null {
    const segment = ctx.channelSegment;
    if (!segment || segment.releases.length === 0) return null;

    // 只留「相对当前版本确为升级」的条目；decideUpdate 已封装：
    //   预发布未放行 -> latest（吞掉）、相等 -> latest、更低 -> downgrade、不可解析 -> incomparable。
    const upgrades = segment.releases.filter((r) =>
      decideUpdate({
        currentVersion: ctx.currentVersion,
        candidateVersion: r.version,
        allowPrerelease: ctx.allowPrerelease,
        candidatePrerelease: r.prerelease,
      }) === "upgrade",
    );
    if (upgrades.length === 0) return null;

    // 取升级候选中的最高版本（manifest 不保证按版本排序，不能假设数组顺序）。
    return upgrades.reduce((best, r) => {
      const cmp = compareVersions(r.version, best.version);
      return cmp !== null && cmp > 0 ? r : best;
    });
  },

  resolveArtifact(
    release: ReleaseManifest,
    arch: string,
    platform: string,
  ): ArtifactManifest | null {
    // fpk 只发 linux；平台不是 linux 直接无解（不接受 platform=any）。
    if (platform !== "linux") return null;
    const wantedArch = mapFnosArch(arch) ?? arch;
    // arch 严格相等：artifact.arch=any 不放行（fpk 原生二进制按架构编译，§3.3）。
    return (
      release.artifacts.find(
        (a) => a.platform === "linux" && a.arch !== "any" && a.arch === wantedArch,
      ) ?? null
    );
  },

  renderInstallGuide(ctx: InstallGuideContext): ManualInstallGuideDTO {
    return renderFnosUploadGuide(ctx.version, ctx.filename);
  },
};
