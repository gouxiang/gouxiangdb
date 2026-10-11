// apps/api/src/domain/update/types.ts
// 应用更新机制：领域层内部类型与错误（domain/update 专用，不含 Hono / db / IO）。
// 设计唯一依据：docs/design/2026-10-app-update/DESIGN.md §3、§6.1、§7。
//
// 依赖方向铁律：domain/update 只允许依赖 @gx/shared-types 与 node 内置；
// 不 import Hono、routes、db、config（config 由 service 层注入）。

import type { ArtifactPlatform } from "@gx/shared-types";

/** 通道探测输出（DESIGN §3.1）。 */
export interface ChannelDetection {
  /** 注册表内通道 id；都不命中为 "unknown"（不是错误）。 */
  channelId: string;
  /** 统一架构词汇 x64 / arm64（已做飞牛 x86/arm → node 词汇映射）。 */
  arch: string;
  /** Node 平台词汇 linux / darwin / win32。 */
  platform: ArtifactPlatform | string;
  /** 命中证据（按优先级，排障用），如 ["GX_DEPLOY_CHANNEL=fnos-fpk"]。 */
  evidence: string[];
  /** 非致命配置问题（如 GX_UPDATE_CHANNEL 非法值），调用方决定是否 warn，绝不让进程退出。 */
  warnings: string[];
}

/** 更新源 / 清单错误码（DESIGN §6.1 错误表；HTTP 状态在路由层映射，domain 只带 code）。 */
export type UpdateSourceErrorCode =
  | "UPDATE_SOURCE_UNCONFIGURED"
  | "UPDATE_SOURCE_AUTH"
  | "UPDATE_SOURCE_UNREACHABLE"
  | "UPDATE_SOURCE_TIMEOUT"
  | "UPDATE_MANIFEST_INVALID";

/**
 * 领域层更新错误：只携带稳定 code + 脱敏 message。
 * 上游状态体 / host / 耗时由调用方写服务端日志，绝不透传给浏览器（防内网地址泄漏，DESIGN §11 D5）。
 */
export class UpdateSourceError extends Error {
  constructor(
    readonly code: UpdateSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpdateSourceError";
  }
}

/** 请求显式声明的通道身份（仅 remoteDeclarable 通道，DESIGN §3.1 优先级 2）。 */
export interface DeclaredIdentity {
  channel: string;
  arch: string;
  platform: string;
}
