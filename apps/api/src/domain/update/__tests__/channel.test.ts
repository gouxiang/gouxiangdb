// ChannelDetector 表驱动测试：DESIGN §3.1 六级优先级 + §3.1 飞牛架构映射。
import { describe, expect, it } from "vitest";
import {
  CHANNEL_FNOS_FPK,
  detectChannel,
  mapFnosArch,
  normalizeNodeArch,
} from "../channel.js";

function run(env: NodeJS.ProcessEnv, nodeArch = "x64", nodePlatform = "linux") {
  return detectChannel({ env, nodeArch, nodePlatform });
}

describe("detectChannel 优先级", () => {
  it("P1 GX_UPDATE_CHANNEL 合法值最高优先（覆盖 GX_DEPLOY_CHANNEL）", () => {
    const d = run({
      GX_UPDATE_CHANNEL: "source-bare",
      GX_DEPLOY_CHANNEL: "fnos-fpk",
    });
    expect(d.channelId).toBe("source-bare");
    expect(d.evidence).toEqual(["GX_UPDATE_CHANNEL"]);
    expect(d.warnings).toEqual([]);
  });

  it("P1 非法 GX_UPDATE_CHANNEL：warn 并忽略，落到下一优先级", () => {
    const d = run({
      GX_UPDATE_CHANNEL: "nonsense",
      GX_DEPLOY_CHANNEL: "fnos-fpk",
    });
    expect(d.channelId).toBe(CHANNEL_FNOS_FPK);
    expect(d.evidence).toEqual(["GX_DEPLOY_CHANNEL"]);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain("nonsense");
  });

  it("P1 desktop-client 是远程声明通道，不在本地白名单：显式指定也被忽略", () => {
    const d = run({ GX_UPDATE_CHANNEL: "desktop-client" });
    expect(d.channelId).toBe("unknown");
    expect(d.warnings).toHaveLength(1);
  });

  it("P3 GX_DEPLOY_CHANNEL=fnos-fpk（cmd/main 导出）", () => {
    const d = run({ GX_DEPLOY_CHANNEL: "fnos-fpk" });
    expect(d.channelId).toBe(CHANNEL_FNOS_FPK);
    expect(d.evidence).toEqual(["GX_DEPLOY_CHANNEL"]);
  });

  it("P4 TRIM_APPDEST 含 /appcenter 兜底识别 fpk（老版本包）", () => {
    const d = run({ TRIM_APPDEST: "/vol1/@appcenter/gouxiangdb/app" });
    expect(d.channelId).toBe(CHANNEL_FNOS_FPK);
    expect(d.evidence).toEqual(["TRIM_*"]);
  });

  it("P4 TRIM_APPDEST 含 /@appshare/ 兜底识别 fpk", () => {
    const d = run({ TRIM_DATA_SHARE_PATHS: "/vol1/@appshare/gouxiangdb" });
    expect(d.channelId).toBe(CHANNEL_FNOS_FPK);
  });

  it("P4 真机形态：TRIM_APPDEST=/vol1/@appcenter/<name> 与 data-share 冒号列表均命中", () => {
    expect(
      run({ TRIM_APPDEST: "/vol1/@appcenter/gouxiangdb" }).channelId,
    ).toBe(CHANNEL_FNOS_FPK);
    expect(
      run({
        TRIM_DATA_SHARE_PATHS: "/vol1/@appshare/gouxiangdb:/vol2/@appshare/other",
      }).channelId,
    ).toBe(CHANNEL_FNOS_FPK);
  });

  it("P4 无关 TRIM_* 不算飞牛证据", () => {
    const d = run({ TRIM_APPDEST: "/opt/app", TRIM_DATA_SHARE_PATHS: "/srv/data" });
    expect(d.channelId).toBe("unknown");
    expect(d.evidence).toEqual(["none"]);
  });

  it("P6 空 env → unknown（不是错误，无 warnings）", () => {
    const d = run({});
    expect(d.channelId).toBe("unknown");
    expect(d.evidence).toEqual(["none"]);
    expect(d.warnings).toEqual([]);
  });

  it("输出携带归一化后的 arch/platform", () => {
    const d = run({ GX_DEPLOY_CHANNEL: "fnos-fpk" }, "arm64", "linux");
    expect(d.arch).toBe("arm64");
    expect(d.platform).toBe("linux");
  });
});

describe("飞牛架构词汇映射（不能猜）", () => {
  it.each([
    ["x86", "x64"],
    ["x64", "x64"],
    ["amd64", "x64"],
    ["arm", "arm64"],
    ["arm64", "arm64"],
    ["aarch64", "arm64"],
  ])("mapFnosArch(%s) = %s", (raw, want) => {
    expect(mapFnosArch(raw)).toBe(want);
  });

  it("未知架构返回 null（不猜）", () => {
    expect(mapFnosArch("mips")).toBeNull();
    expect(mapFnosArch(undefined)).toBeNull();
  });

  it("normalizeNodeArch 未知值原样返回", () => {
    expect(normalizeNodeArch("riscv64")).toBe("riscv64");
    expect(normalizeNodeArch("x64")).toBe("x64");
  });
});
