// 注册表双 map 防回归（v0.3.1）：本地通道与声明通道严格隔离——
// localStrategy 永不返回 desktop-client，declarableStrategy 永不返回 fnos-fpk，
// localStrategies() 只含本地数组。
import { describe, expect, it } from "vitest";
import { CHANNEL_DESKTOP_CLIENT, CHANNEL_FNOS_FPK } from "../../channel.js";
import {
  declarableStrategy,
  localStrategies,
  localStrategy,
} from "../registry.js";

describe("registry 本地表 / 声明表隔离", () => {
  it("localStrategy：fnos-fpk 命中；desktop-client 与未知 id 返回 null", () => {
    expect(localStrategy(CHANNEL_FNOS_FPK)?.channelId).toBe("fnos-fpk");
    expect(localStrategy(CHANNEL_DESKTOP_CLIENT)).toBeNull();
    expect(localStrategy("nope")).toBeNull();
  });

  it("declarableStrategy：desktop-client 命中；fnos-fpk 与未知 id 返回 null", () => {
    expect(declarableStrategy(CHANNEL_DESKTOP_CLIENT)?.channelId).toBe("desktop-client");
    expect(declarableStrategy(CHANNEL_DESKTOP_CLIENT)?.remoteDeclarable).toBe(true);
    expect(declarableStrategy(CHANNEL_FNOS_FPK)).toBeNull();
    expect(declarableStrategy("nope")).toBeNull();
  });

  it("localStrategies() 只含本地通道，不含 desktop-client", () => {
    const ids = localStrategies().map((s) => s.channelId);
    expect(ids).toContain("fnos-fpk");
    expect(ids).not.toContain("desktop-client");
  });

  it("两表取出的是同一策略单例（与策略文件导出一致）", () => {
    expect(declarableStrategy("desktop-client")?.installGuideKind).toBe("desktop-installer");
    expect(localStrategy("fnos-fpk")?.installGuideKind).toBe("fnos-upload");
  });
});
