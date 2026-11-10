// apps/api/src/domain/update/strategies/registry.ts
// 更新策略唯一登记表（DESIGN §3.2）：「注册即接入」——service 只经本注册表取策略，
// 对具体通道零感知。新增通道 = 写一个 UpdateStrategy 实现 + 在对应注册表数组追加一行
// + 发布侧 manifest 增加对应通道段，service / 路由无需改动。
//
// 双表隔离（v0.3.1 起，防回归关键）：
//   - 本地自识别通道（fnos-fpk）进 registered：可被 ChannelDetector/env 自认，localStrategy 可取；
//   - 远程声明通道（desktop-client，remoteDeclarable=true）只进 declarableRegistered：
//     服务端永不是该通道，只能由请求显式声明，declarableStrategy 可取，绝不进本地识别。
// 两个 Map 互不重叠，localStrategy 永不返回声明通道、declarableStrategy 永不返回本地通道。

import { desktopClientStrategy } from "./desktopClient.js";
import { fnosFpkStrategy } from "./fnosFpk.js";
import type { UpdateStrategy } from "./types.js";

// 顺序即本地识别的兜底顺序。
const registered: readonly UpdateStrategy[] = [fnosFpkStrategy];
// 仅远程声明通道（remoteDeclarable）；不参与任何本地探测/自认。
const declarableRegistered: readonly UpdateStrategy[] = [desktopClientStrategy];

const localMap = new Map<string, UpdateStrategy>(registered.map((s) => [s.channelId, s]));
const declarableMap = new Map<string, UpdateStrategy>(
  declarableRegistered.map((s) => [s.channelId, s]),
);

/** 全部本地可识别策略（ChannelDetector 白名单/遍历用）；不含任何声明式通道。 */
export function localStrategies(): readonly UpdateStrategy[] {
  return registered;
}

/** 按 channelId 取本地策略；未注册（含声明式通道 id）返回 null。 */
export function localStrategy(id: string): UpdateStrategy | null {
  return localMap.get(id) ?? null;
}

/**
 * 取允许请求方远程声明的策略（remoteDeclarable=true）。
 * 仅查声明表：本地通道 id（如 fnos-fpk）与未知 id 一律返回 null（status 的 channel query 传值即 400）。
 */
export function declarableStrategy(id: string): UpdateStrategy | null {
  return declarableMap.get(id) ?? null;
}
