// apps/api/src/domain/update/strategies/desktopClient.ts
// 桌面客户端成品通道（macOS/Windows/Linux 安装包，DESIGN §3.3 差异对照）。
//
// 与 fnos-fpk 的本质差异：
//   1. remoteDeclarable=true：服务端自己永远不是桌面通道，无法凭 env 自证，只能由请求方在
//      status query 中显式声明 channel=desktop-client + arch + platform（DESIGN §3.1 优先级 2）。
//      故【不实现】claimFromEnv，也不进本地注册表/本地探测白名单。
//   2. artifact 匹配走 platform + arch【双键严格相等】：darwin/win32/linux × x64/arm64，
//      platform=any 或 arch=any 一律不放行（安装包按平台/架构分别构建，不可通吃）。
//   3. 版本比较只允许调 @gx/shared-types 的 compareVersions / decideUpdate，禁止另写。
//   4. 安装指引文案只允许取 installGuide.ts 的统一装配，本文件不散写中文步骤。

import {
  compareVersions,
  decideUpdate,
  type ArtifactManifest,
  type ManualInstallGuideDTO,
  type ReleaseManifest,
} from "@gx/shared-types";
import { CHANNEL_DESKTOP_CLIENT } from "../channel.js";
import { renderDesktopInstallerGuide } from "../installGuide.js";
import type { InstallGuideContext, SelectReleaseContext, UpdateStrategy } from "./types.js";

export const desktopClientStrategy: UpdateStrategy = {
  channelId: CHANNEL_DESKTOP_CLIENT,
  // 声明式通道：仅允许请求方远程声明，服务端本地探测永不命中（不实现 claimFromEnv）。
  remoteDeclarable: true,
  installGuideKind: "desktop-installer",

  // 与 fnosFpkStrategy.selectRelease 同构：只留确为升级的条目，再取其中最高版本。
  selectRelease(ctx: SelectReleaseContext): ReleaseManifest | null {
    const segment = ctx.channelSegment;
    if (!segment || segment.releases.length === 0) return null;

    const upgrades = segment.releases.filter((r) =>
      decideUpdate({
        currentVersion: ctx.currentVersion,
        candidateVersion: r.version,
        allowPrerelease: ctx.allowPrerelease,
        candidatePrerelease: r.prerelease,
      }) === "upgrade",
    );
    if (upgrades.length === 0) return null;

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
    // 双键严格相等：platform 与 arch 都必须精确匹配；any 通吃包不放行（安装包按目标分别构建）。
    return (
      release.artifacts.find(
        (a) =>
          a.platform !== "any"
          && a.arch !== "any"
          && a.platform === platform
          && a.arch === arch,
      ) ?? null
    );
  },

  renderInstallGuide(ctx: InstallGuideContext): ManualInstallGuideDTO {
    return renderDesktopInstallerGuide(ctx.version, ctx.filename, ctx.productName);
  },
};
