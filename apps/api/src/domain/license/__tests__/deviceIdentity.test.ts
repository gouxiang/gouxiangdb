/**
 * 设备身份探测纯函数 + 本机卷 UUID 读取（仅 macOS 断言格式，其余平台断言 no-vol 不崩）。
 */
import { describe, it, expect } from "vitest";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import {
  detectPlatform,
  detectPackageType,
  detectArch,
  readMacRootVolumeUuid,
  detectLanIp,
  isValidIpv4,
  isPrivateIpv4,
} from "../deviceIdentity.js";

type Nets = ReturnType<typeof networkInterfaces>;

/** 构造一个最小可用的 IPv4 网卡地址项。 */
function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null };
}
function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    family: "IPv6",
    internal: false,
    netmask: "ffff::",
    mac: "00:00:00:00:00:00",
    cidr: null,
    scopeid: 0,
  };
}
function fakeNets(obj: Record<string, NetworkInterfaceInfo[] | undefined>): () => Nets {
  return (() => obj) as unknown as () => Nets;
}

describe("detectPlatform", () => {
  it("显式覆盖优先", () => {
    expect(detectPlatform("docker", { GX_PACKAGE_TYPE: "fpk" })).toBe("docker");
    expect(detectPlatform("desktop", { FNOS_APP_CENTER: "1" })).toBe("desktop");
  });
  it("env 信号识别 fnos/docker", () => {
    expect(detectPlatform(null, { FNOS_APP_CENTER: "1" })).toBe("fnos");
    expect(detectPlatform(null, { GX_PACKAGE_TYPE: "fpk" })).toBe("fnos");
    expect(detectPlatform(null, { GX_LICENSE_PLATFORM: "fnos" })).toBe("fnos");
    expect(detectPlatform(null, { DOCKER_CONTAINER: "1" })).toBe("docker");
  });
  it("无信号归 desktop", () => {
    expect(detectPlatform(null, {})).toBe("desktop");
  });
});

describe("detectPackageType", () => {
  it("按平台给默认", () => {
    expect(detectPackageType("fnos", {})).toBe("fpk");
    expect(detectPackageType("docker", {})).toBe("docker");
  });
  it("desktop 在 macOS 给 dmg，显式覆盖优先", () => {
    const t = detectPackageType("desktop", {});
    expect(["dmg", "unknown"]).toContain(t);
    expect(detectPackageType("desktop", { GX_LICENSE_PACKAGE_TYPE: "pkg" })).toBe("pkg");
    expect(detectPackageType("desktop", { GX_LICENSE_PACKAGE_TYPE: "exe" })).toBe("exe");
  });
  it("非法覆盖回落默认", () => {
    expect(detectPackageType("fnos", { GX_LICENSE_PACKAGE_TYPE: "deb" })).toBe("fpk");
    expect(detectPackageType("docker", { GX_LICENSE_PACKAGE_TYPE: "rpm" })).toBe("docker");
  });
});

describe("detectArch", () => {
  it("返回归一架构串", () => {
    expect(["x86", "aarch64"]).toContain(detectArch());
  });
});

describe("readMacRootVolumeUuid", () => {
  it("不抛错；macOS 返回 UUID 或 no-vol，非 macOS 恒 no-vol", async () => {
    const v = await readMacRootVolumeUuid();
    if (process.platform === "darwin") {
      expect(v === "no-vol" || /^[A-Fa-f0-9-]+$/.test(v)).toBe(true);
    } else {
      expect(v).toBe("no-vol");
    }
  });
});

describe("isValidIpv4 / isPrivateIpv4", () => {
  it("isValidIpv4 仅接受四段 0-255", () => {
    expect(isValidIpv4("192.168.1.1")).toBe(true);
    expect(isValidIpv4("8.8.8.8")).toBe(true);
    expect(isValidIpv4("0.0.0.0")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
    expect(isValidIpv4("256.1.1.1")).toBe(false);
    expect(isValidIpv4("1.2.3")).toBe(false);
    expect(isValidIpv4("a.b.c.d")).toBe(false);
    expect(isValidIpv4("1.2.3.4.5")).toBe(false);
  });
  it("isPrivateIpv4 识别三大私网段，排除环回/link-local/公网", () => {
    expect(isPrivateIpv4("10.0.0.5")).toBe(true);
    expect(isPrivateIpv4("192.168.10.20")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.255.255")).toBe(true);
    expect(isPrivateIpv4("172.15.0.1")).toBe(false);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateIpv4("127.0.0.1")).toBe(false);
    expect(isPrivateIpv4("169.254.1.1")).toBe(false);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });
});

describe("detectLanIp", () => {
  it("物理口私网 IPv4 优先", () => {
    const nets = fakeNets({
      bridge100: [v4("10.99.0.1")],
      en0: [v4("192.168.1.23")],
    });
    expect(detectLanIp(nets)).toBe("192.168.1.23");
  });

  it("跳过 internal（环回）与 IPv6 与 link-local", () => {
    const nets = fakeNets({
      lo0: [v4("127.0.0.1", true)],
      awdl0: [v6("fe80::1"), v4("169.254.10.10")],
      eth0: [v6("fe80::abcd"), v4("10.20.30.40")],
    });
    expect(detectLanIp(nets)).toBe("10.20.30.40");
  });

  it("公网 IPv4 不作为局域网地址", () => {
    const nets = fakeNets({ en0: [v4("203.0.113.7")] });
    expect(detectLanIp(nets)).toBeNull();
  });

  it("仅虚拟口有候选时取虚拟口（物理口缺失不致 null）", () => {
    const nets = fakeNets({
      docker0: [v4("172.17.0.1")],
      utun0: [v4("10.8.0.2")],
    });
    // 同档（虚拟 rank=2）按口名字典序：docker0 < utun0
    expect(detectLanIp(nets)).toBe("172.17.0.1");
  });

  it("无任何候选返回 null；网卡枚举抛错也安全返回 null", () => {
    expect(detectLanIp(fakeNets({ lo0: [v4("127.0.0.1", true)] }))).toBeNull();
    expect(detectLanIp(fakeNets({}))).toBeNull();
    expect(detectLanIp(() => {
      throw new Error("boom");
    })).toBeNull();
  });

  it("同优先级多候选结果确定（按口名+地址稳定排序）", () => {
    const a = fakeNets({ eth1: [v4("10.0.0.2")], eth0: [v4("10.0.0.1")] });
    const b = fakeNets({ eth0: [v4("10.0.0.1")], eth1: [v4("10.0.0.2")] });
    expect(detectLanIp(a)).toBe("10.0.0.1");
    expect(detectLanIp(b)).toBe("10.0.0.1");
  });

  it("不传注入参数时在真实机器上不抛错（返回 null 或私网 IPv4）", () => {
    const ip = detectLanIp();
    if (ip !== null) expect(isPrivateIpv4(ip)).toBe(true);
  });
});
