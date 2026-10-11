// apps/api/src/domain/update/strategies/registry.ts
// 更新策略唯一登记表（DESIGN §3.2）：「注册即接入」——service 只经本注册表取策略，
// 对具体通道零感知。新增通道 = 写一个 UpdateStrategy 实现 + 在 registered 数组追加一行
// + 发布侧 manifest 增加对应通道段，service / 路由无需改动。

import { fnosFpkStrategy } from "./fnosFpk.js";
import type { UpdateStrategy } from "./types.js";

// 顺序即本地识别的兜底顺序；remoteDeclarable 的通道（未来 desktop-client）不放进本数组
// 参与本地识别，只在请求显式声明时由 declarableStrategy 按 channelId 取出。
const registered: readonly UpdateStrategy[] = [fnosFpkStrategy];

const byId = new Map<string, UpdateStrategy>(registered.map((s) => [s.channelId, s]));

/** 全部本地可识别策略（ChannelDetector 白名单/遍历用）。 */
export function localStrategies(): readonly UpdateStrategy[] {
  return registered;
}

/** 按 channelId 取本地策略；未注册返回 null（unknown 通道由 service 判 update=null）。 */
export function localStrategy(id: string): UpdateStrategy | null {
  return byId.get(id) ?? null;
}

/**
 * 取允许请求方远程声明的策略（remoteDeclarable=true）。
 * 当前注册表没有声明式通道，故对任何 id 都返回 null——status 的 channel query 传值即 400。
 */
export function declarableStrategy(id: string): UpdateStrategy | null {
  const s = byId.get(id);
  return s && s.remoteDeclarable ? s : null;
}
