/**
 * 软指纹纯函数（移植自 simulator/fingerprint.ts，与 03-FINGERPRINT.md 对齐）：
 * - desktop：系统卷 UUID + 本机名 + deploymentId
 * - fnos/docker：持久化数据目录的 deploymentId + hostname（卷 UUID 重建即变，不能用）
 * 输出 sha256 hex。IO（取卷 UUID/hostname/持久化 deploymentId）在 deviceIdentity.ts，本文件零 IO。
 */
import { createHash, randomUUID } from "node:crypto";
import type { LicensePlatform } from "./configLicense.js";

export type Platform = LicensePlatform; // "desktop" | "fnos" | "docker"

export interface DeviceIdentity {
  platform: Platform;
  deploymentId: string;
  hostname: string;
  volumeUuid?: string; // 仅 desktop 使用
}

export function newDeploymentId(): string {
  return randomUUID();
}

export function computeFingerprint(d: DeviceIdentity): string {
  const basis =
    d.platform === "desktop"
      ? `desktop|${d.volumeUuid ?? "no-vol"}|${d.hostname}|${d.deploymentId}`
      : `${d.platform}|persist|${d.hostname}|${d.deploymentId}`;
  return createHash("sha256").update(basis, "utf-8").digest("hex");
}

/** 模拟桌面换机：卷 UUID + 主机名全变，deploymentId 默认也变（新机安装）。测试辅助。 */
export function simulateNewMachine(d: DeviceIdentity, platform: Platform = d.platform): DeviceIdentity {
  return {
    platform,
    deploymentId: newDeploymentId(),
    hostname: `host-${Math.random().toString(36).slice(2, 8)}`,
    ...(platform === "desktop" ? { volumeUuid: randomUUID() } : {}),
  };
}

/** 模拟 fpk 升级/容器重建：卷信息消失，但 deploymentId 从持久化目录保留。测试辅助。 */
export function simulateFnosRebuild(d: DeviceIdentity): DeviceIdentity {
  return { platform: "fnos", deploymentId: d.deploymentId, hostname: d.hostname };
}
