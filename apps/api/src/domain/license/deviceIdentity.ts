/**
 * 设备身份装配（纯 Node，零编译、零 Rust 依赖）：
 *  - desktop：系统卷 UUID + hostname + 持久化 deploymentId（指纹四元组，见 fingerprint.ts）；
 *  - fnos/docker：禁用卷 UUID，只取 hostname + deploymentId（fpk/容器重建卷信息会变）。
 *
 * desktop 系统卷 UUID 用一次性 `diskutil info /` 解析（仅 macOS 有该命令，失败回落 "no-vol"），
 * 不在每条心跳里 spawn；结果与指纹都由 deploymentId 持久化锚定。非 macOS 直接 "no-vol"。
 */
import { execFile } from "node:child_process";
import {
  hostname as osHostname,
  arch as osArch,
  platform as osPlatform,
  networkInterfaces as osNetworkInterfaces,
} from "node:os";
import { promisify } from "node:util";
import type { LicenseConfig, LicensePlatform } from "./configLicense.js";
import { newDeploymentId, type DeviceIdentity, type Platform } from "./fingerprint.js";
import type { LicenseStore } from "./store.js";

const pexecFile = promisify(execFile);

export type PackageType = "dmg" | "pkg" | "exe" | "msi" | "fpk" | "docker" | "unknown";

/** 自动探测平台：env 覆盖优先；否则 fnos 有特征目录、docker 有容器信号，其余按内核归 desktop。 */
export function detectPlatform(override: LicensePlatform | null, env: NodeJS.ProcessEnv): Platform {
  if (override) return override;
  if (env.GX_LICENSE_PLATFORM === "fnos" || env.FNOS_APP_CENTER === "1" || env.GX_PACKAGE_TYPE === "fpk") {
    return "fnos";
  }
  if (env.GX_LICENSE_PLATFORM === "docker" || env.GX_PACKAGE_TYPE === "docker" || env.DOCKER_CONTAINER === "1") {
    return "docker";
  }
  return "desktop";
}

/** 安装包渠道：显式覆盖优先，否则按平台给默认（desktop=dmg、fnos=fpk、docker=docker）。 */
export function detectPackageType(platform: Platform, env: NodeJS.ProcessEnv): PackageType {
  const raw = env.GX_LICENSE_PACKAGE_TYPE?.trim() as PackageType | undefined;
  const allowed: PackageType[] = ["dmg", "pkg", "exe", "msi", "fpk", "docker", "unknown"];
  if (raw && allowed.includes(raw)) return raw;
  if (platform === "fnos") return "fpk";
  if (platform === "docker") return "docker";
  return osPlatform() === "darwin" ? "dmg" : "unknown";
}

export function detectArch(): string {
  const a = osArch();
  if (a === "arm64" || a === "aarch64") return "aarch64";
  if (a === "x64") return "x86";
  return a;
}

/** macOS 根卷 UUID（/ 的卷）；非 macOS 或解析失败回落 "no-vol"。一次性调用，短超时。 */
export async function readMacRootVolumeUuid(): Promise<string> {
  if (osPlatform() !== "darwin") return "no-vol";
  try {
    const { stdout } = await pexecFile("diskutil", ["info", "/"], { timeout: 3000 });
    // 形如：Volume UUID:  XXXX-XXXX-....
    const m = /^\s*Volume UUID:\s*([A-Fa-f0-9-]+)\s*$/m.exec(stdout);
    if (m?.[1]) return m[1];
    return "no-vol";
  } catch {
    return "no-vol";
  }
}

/** 物理/常用口名前缀（优先级最高）：macOS en*、Linux eth/ens/enp、无线 wlan/wlp、Windows ethernet。 */
const PHYSICAL_NIC_RE = /^(en|eth|ens|enp|wlan|wlp|ethernet)/;
/** 虚拟口名（排后）：容器/网桥/VPN/隧道/苹果随建虚拟口等。 */
const VIRTUAL_NIC_RE = /docker|veth|br-|bridge|virbr|utun|tap|tailscale|zt|fuse|llw|awdl/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

type NetworkInterfacesResult = ReturnType<typeof osNetworkInterfaces>;

/** 纯函数：是否合法点分四段 IPv4（每段 0-255）。仅做格式校验，不限公/私网。 */
export function isValidIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].map(Number).every((n) => n <= 255);
}

/** 纯函数：是否私网 IPv4（10/8、192.168/16、172.16-31/12）。环回/link-local/公网一律 false。 */
export function isPrivateIpv4(ip: string): boolean {
  if (!isValidIpv4(ip)) return false;
  const [a, b] = ip.trim().split(".").map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 探测本机首选局域网 IPv4（单值）。仅取非 internal 的私网 IPv4；
 * 口名优先级：物理/常用口 > 其他 > 虚拟口，同档按口名+地址稳定排序保证确定性。
 * 拿不到（无网卡/无候选/枚举抛错）返回 null（调用方据此不带 lanIp 键）。
 * networkInterfaces 可注入，便于纯单测。
 */
export function detectLanIp(
  nets: () => NetworkInterfacesResult = osNetworkInterfaces,
): string | null {
  let ifaces: NetworkInterfacesResult;
  try {
    ifaces = nets();
  } catch {
    return null;
  }
  const candidates: Array<{ name: string; address: string; rank: number }> = [];
  for (const [rawName, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const name = rawName.toLowerCase();
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!isPrivateIpv4(a.address)) continue;
      const rank = PHYSICAL_NIC_RE.test(name) ? 0 : VIRTUAL_NIC_RE.test(name) ? 2 : 1;
      candidates.push({ name, address: a.address, rank });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (x, y) => x.rank - y.rank || x.name.localeCompare(y.name) || x.address.localeCompare(y.address),
  );
  return candidates[0].address;
}

export interface ResolvedIdentity {
  identity: DeviceIdentity;
  deploymentId: string;
  hostname: string;
  packageType: PackageType;
  arch: string;
  deviceName: string;
  appVersion: string;
  /** 本机首选局域网 IPv4；探测不到为 null（上报时省略该键）。 */
  lanIp: string | null;
}

/**
 * 组装完整设备身份。deploymentId 首启生成并由 store 持久化（KV+文件镜像）。
 * volumeUuid 允许注入（测试/壳层已知时），否则 desktop 下现取一次。
 */
export async function resolveDeviceIdentity(
  cfg: LicenseConfig,
  store: LicenseStore,
  env: NodeJS.ProcessEnv,
  appVersion: string,
  opts: { volumeUuid?: string; deviceName?: string } = {},
): Promise<ResolvedIdentity> {
  const platform = detectPlatform(cfg.platformOverride, env);
  const deploymentId = await store.ensureDeploymentId();
  const host = (env.GX_LICENSE_DEVICE_NAME?.trim() || osHostname() || "unknown-host").slice(0, 128);
  const volumeUuid =
    platform === "desktop"
      ? opts.volumeUuid ?? (await readMacRootVolumeUuid())
      : undefined;
  const identity: DeviceIdentity = { platform, deploymentId, hostname: host, volumeUuid };
  return {
    identity,
    deploymentId,
    hostname: host,
    packageType: detectPackageType(platform, env),
    arch: detectArch(),
    deviceName: opts.deviceName?.trim() || host,
    appVersion,
    lanIp: detectLanIp(),
  };
}

export { newDeploymentId };
