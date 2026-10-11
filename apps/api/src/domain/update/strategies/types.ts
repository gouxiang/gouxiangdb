// apps/api/src/domain/update/strategies/types.ts
// UpdateStrategy：单通道策略接口（DESIGN §2.2、§3.2、§3.3）。
//
// 「注册即接入」：service.ts 只依赖本接口，对具体通道零感知。
// 新增通道 = 新增一个实现 + 在 registry.ts 数组追加一行 + 发布侧 manifest 增加通道段。
// 本文件只有接口 / 类型，不含实现、不含 IO。

import type {
  ArtifactManifest,
  ChannelManifest,
  InstallGuideKind,
  ManualInstallGuideDTO,
  ReleaseManifest,
} from "@gx/shared-types";

/** selectRelease 的输入：service 已按 channelId 取出对应 manifest 通道段。 */
export interface SelectReleaseContext {
  /** manifest.channels[channelId]；通道段缺失时为 undefined（视为无更新，非错误）。 */
  channelSegment: ChannelManifest | undefined;
  /** 当前运行版本（VERSION 常量）。 */
  currentVersion: string;
  /** GX_UPDATE_ALLOW_PRERELEASE=on 精确小写时为 true。 */
  allowPrerelease: boolean;
}

/** renderInstallGuide 需要的展示上下文。filename 在 below-min（artifact=null）时为 null。 */
export interface InstallGuideContext {
  version: string;
  filename: string | null;
}

/**
 * 单通道更新策略。通道间的差异只允许体现在三处（DESIGN §3.3）：
 *   1. 如何从通道段里选 release（当前各通道一致，保留覆写位）；
 *   2. artifact 的 arch/platform 匹配规则（fnos 严格相等；source-bare 允许 any；desktop 双键）；
 *   3. 人工安装指引文案（kind + 步骤）。
 * 版本比较一律走 @gx/shared-types 的纯函数，策略内不得另写比较逻辑。
 */
export interface UpdateStrategy {
  /** 通道 id，同时是 manifest.channels 的段 key。 */
  readonly channelId: string;
  /** 是否允许请求方在 query 中远程声明（仅未来 desktop-client=true；本地自识别通道 false）。 */
  readonly remoteDeclarable: boolean;
  /** 人工安装指引类型，决定前端渲染口径。 */
  readonly installGuideKind: InstallGuideKind;

  /**
   * 可选：仅凭进程 env 自证属于本通道时返回命中证据名，否则 null。
   * 本地通道实现它（与 ChannelDetector 的启发式对齐）；desktop-client 不实现（服务端永不是该通道）。
   * 主识别仍以 ChannelDetector 为准，本方法仅作注册期/一致性用途。
   */
  claimFromEnv?(env: NodeJS.ProcessEnv): string | null;

  /**
   * 从通道段选出「相对当前版本为升级」的最高 release；预发布按 allowPrerelease 决定是否纳入。
   * 无通道段 / 无合法条目 / 没有更高版本 → 返回 null（调用方据此给 update=null 或 latest）。
   * 不可解析版本的 release 条目由实现跳过（DESIGN §4.1 规则 7）。
   */
  selectRelease(ctx: SelectReleaseContext): ReleaseManifest | null;

  /**
   * 在选定 release 内按当前 arch/platform 定位可下载 artifact；无匹配返回 null。
   * 匹配规则由各通道决定（fnos：arch 严格相等且 platform=linux，不接受 any；
   * source-bare：arch 可被 any 通吃；desktop：platform+arch 双键）。
   */
  resolveArtifact(
    release: ReleaseManifest,
    arch: string,
    platform: string,
  ): ArtifactManifest | null;

  /** 装配本通道的人工安装指引（中文、有序步骤、禁嵌 HTML；集中一处维护，DESIGN §7.2）。 */
  renderInstallGuide(ctx: InstallGuideContext): ManualInstallGuideDTO;

  /**
   * 保留位：未来的自动安装钩子。【当前没有任何策略实现它，API 也不暴露 apply 端点】
   * （fpk 通道应用代码目录由 fnOS 框架整体替换并受 ACL 管控，进程无自更新能力——DESIGN §2.0）。
   */
  apply?(context: ApplyUpdateContext): Promise<ApplyUpdateResult>;
}

/** apply() 预留入参（当前无实现/无调用；仅为锁定未来签名，勿据此提前构建端点）。 */
export interface ApplyUpdateContext {
  artifact: ArtifactManifest;
  downloadedPath: string;
}

/** apply() 预留结果（当前无实现）。 */
export interface ApplyUpdateResult {
  /** 安装是否已被平台接管（如已触发外部安装器）；当前不会产生。 */
  handedOff: boolean;
  note?: string;
}
