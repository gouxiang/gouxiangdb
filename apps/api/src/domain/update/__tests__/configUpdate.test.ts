// apps/api/src/domain/update/__tests__/configUpdate.test.ts
// configUpdate 纯函数解析测试（DESIGN §5.3）：精确小写纪律、正整数回退、URL/Repo 结构校验、
// 最重要的——任何 warning / 返回值都不得泄漏 token。
import { describe, expect, it } from "vitest";
import {
  parseAllowPrerelease,
  parseGiteaBaseUrl,
  parsePositiveIntMs,
  parseRepo,
  parseUpdateConfig,
  parseUpdateEnabled,
  parseUpdateSource,
  UPDATE_DEFAULTS,
} from "../../../configUpdate.js";

describe("parseUpdateEnabled", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["on", true],
    ["OFF", true], // 大写不识别 → 默认 on（精确小写纪律）
    ["  off  ", false],
    ["off", false],
  ])("%j -> %s", (raw, want) => {
    expect(parseUpdateEnabled(raw)).toBe(want);
  });
});

describe("parseUpdateSource", () => {
  it.each([
    [undefined, "gitea"],
    ["gitea", "gitea"],
    ["static", "static"],
    ["github", "github"],
    ["  github  ", "github"],
    ["GITHUB", "gitea"], // 大写不识别 -> 精确小写纪律回默认
    ["STATIC", "gitea"],
    ["mirror", "gitea"],
  ])("%j -> %s", (raw, want) => {
    expect(parseUpdateSource(raw)).toBe(want);
  });
});

describe("parseAllowPrerelease", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["on", true],
    ["ON", false],
    ["  on  ", true],
    ["off", false],
  ])("%j -> %s", (raw, want) => {
    expect(parseAllowPrerelease(raw)).toBe(want);
  });
});

describe("parsePositiveIntMs", () => {
  it("未设回退且不算非法", () => {
    expect(parsePositiveIntMs(undefined, 8000)).toEqual({ value: 8000, fellBack: false });
    expect(parsePositiveIntMs("", 8000)).toEqual({ value: 8000, fellBack: false });
  });
  it("合法正整数", () => {
    expect(parsePositiveIntMs("1200", 8000)).toEqual({ value: 1200, fellBack: false });
  });
  it.each([["0"], ["-5"], ["abc"], ["1.5"], ["0x10"]])("%j 非法回退", (raw) => {
    expect(parsePositiveIntMs(raw, 8000)).toEqual({ value: 8000, fellBack: true });
  });
});

describe("parseGiteaBaseUrl", () => {
  it("未设用默认且无 warning", () => {
    expect(parseGiteaBaseUrl(undefined)).toEqual({
      value: UPDATE_DEFAULTS.giteaBaseUrl,
      warning: null,
    });
  });
  it("去尾斜杠", () => {
    expect(parseGiteaBaseUrl("https://gitea.example.com///")).toEqual({
      value: "https://gitea.example.com",
      warning: null,
    });
  });
  it("允许 http（内网镜像）", () => {
    expect(parseGiteaBaseUrl("http://10.0.0.1:3000/")).toEqual({
      value: "http://10.0.0.1:3000",
      warning: null,
    });
  });
  it.each([["not a url"], ["ftp://gitea.example.com"], ["://no-proto"]])("%j 非法回退默认并 warn", (raw) => {
    const r = parseGiteaBaseUrl(raw);
    expect(r.value).toBe(UPDATE_DEFAULTS.giteaBaseUrl);
    expect(r.warning).toContain("GX_UPDATE_GITEA_BASE_URL");
  });
});

describe("parseRepo", () => {
  it("未设用默认", () => {
    expect(parseRepo(undefined)).toEqual({ value: "GouXiang/gouxiangdb", warning: null });
  });
  it.each([["org/repo"], ["a-b/c_d.ext"], ["Org/Repo"]])("%j 合法", (raw) => {
    expect(parseRepo(raw).warning).toBeNull();
  });
  it.each([["noslash"], ["a/b/c"], ["/leading"], ["trail/ing/"], ["a b/c"], ["a/"]])("%j 非法回退并 warn", (raw) => {
    const r = parseRepo(raw);
    expect(r.value).toBe(UPDATE_DEFAULTS.repo);
    expect(r.warning).toContain("GX_UPDATE_REPO");
  });
});

describe("parseUpdateConfig 集成与缺省", () => {
  it("全空 env：默认 on/gitea/默认地址，token 空，零 warning", () => {
    const { config, warnings } = parseUpdateConfig({});
    expect(config.enabled).toBe(true);
    expect(config.source).toBe("gitea");
    expect(config.giteaBaseUrl).toBe("https://gitea0.hn.takin.cc");
    expect(config.repo).toBe("GouXiang/gouxiangdb");
    expect(config.manifestUrl).toBe("");
    expect(config.token).toBe("");
    expect(config.channelOverride).toBe("");
    expect(config.allowPrerelease).toBe(false);
    expect(config.timeoutMs).toBe(8000);
    expect(config.downloadIdleTimeoutMs).toBe(30000);
    expect(config.cacheTtlMs).toBe(300000);
    expect(config.ticketTtlMs).toBe(120000);
    // 方案 A 预缓存：默认 on；空闲超时默认 60000；纯函数层目录留空（dataDir 兜底在 config.ts）。
    expect(config.prefetchEnabled).toBe(true);
    expect(config.prefetchIdleTimeoutMs).toBe(60000);
    expect(config.prefetchDir).toBe("");
    expect(warnings).toEqual([]);
  });

  it("精确小写 off 关闭", () => {
    expect(parseUpdateConfig({ GX_UPDATE_ENABLED: "off" }).config.enabled).toBe(false);
  });

  it("预缓存：精确小写 off 关、默认 on、大写不识别按 on", () => {
    expect(parseUpdateConfig({ GX_UPDATE_PREFETCH_ENABLED: "off" }).config.prefetchEnabled).toBe(false);
    expect(parseUpdateConfig({ GX_UPDATE_PREFETCH_ENABLED: "  off  " }).config.prefetchEnabled).toBe(false);
    expect(parseUpdateConfig({ GX_UPDATE_PREFETCH_ENABLED: "OFF" }).config.prefetchEnabled).toBe(true);
    expect(parseUpdateConfig({ GX_UPDATE_PREFETCH_ENABLED: "on" }).config.prefetchEnabled).toBe(true);
  });

  it("预缓存：空闲超时只认正整数毫秒，非法回退默认 60000 并 warn", () => {
    const ok = parseUpdateConfig({ GX_UPDATE_PREFETCH_IDLE_TIMEOUT_MS: "12000" });
    expect(ok.config.prefetchIdleTimeoutMs).toBe(12000);
    expect(ok.warnings).toEqual([]);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const r = parseUpdateConfig({ GX_UPDATE_PREFETCH_IDLE_TIMEOUT_MS: bad });
      expect(r.config.prefetchIdleTimeoutMs).toBe(60000);
      expect(r.warnings.join("\n")).toContain("GX_UPDATE_PREFETCH_IDLE_TIMEOUT_MS");
    }
  });

  it("预缓存：目录 env trim 透传；未设为空串（交由 config.ts 兜底）", () => {
    expect(parseUpdateConfig({ GX_UPDATE_PREFETCH_DIR: " /data/cache " }).config.prefetchDir).toBe("/data/cache");
    expect(parseUpdateConfig({ GX_UPDATE_PREFETCH_DIR: "   " }).config.prefetchDir).toBe("");
  });

  it("非法源/URL/repo/数值累积多条 warning，值全部回退默认", () => {
    const { config, warnings } = parseUpdateConfig({
      GX_UPDATE_SOURCE: "mirror",
      GX_UPDATE_GITEA_BASE_URL: "bad-url",
      GX_UPDATE_REPO: "no-slash",
      GX_UPDATE_TIMEOUT_MS: "slow",
      GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS: "0",
      GX_UPDATE_CACHE_TTL_MS: "-1",
      GX_UPDATE_TICKET_TTL_MS: "x",
    });
    expect(config.source).toBe("gitea");
    expect(config.giteaBaseUrl).toBe(UPDATE_DEFAULTS.giteaBaseUrl);
    expect(config.repo).toBe(UPDATE_DEFAULTS.repo);
    expect(config.timeoutMs).toBe(8000);
    expect(config.downloadIdleTimeoutMs).toBe(30000);
    expect(config.cacheTtlMs).toBe(300000);
    expect(config.ticketTtlMs).toBe(120000);
    expect(warnings).toHaveLength(7);
  });

  it("合法完整配置透传（含 trim）", () => {
    const { config, warnings } = parseUpdateConfig({
      GX_UPDATE_SOURCE: "static",
      GX_UPDATE_GITEA_BASE_URL: "https://gitea.corp/",
      GX_UPDATE_REPO: " team/proj ",
      GX_UPDATE_MANIFEST_URL: " https://mirror/m.json ",
      GX_UPDATE_TOKEN: "tok123",
      GX_UPDATE_CHANNEL: "fnos-fpk",
      GX_UPDATE_ALLOW_PRERELEASE: "on",
      GX_UPDATE_TIMEOUT_MS: "5000",
    });
    expect(config.source).toBe("static");
    expect(config.giteaBaseUrl).toBe("https://gitea.corp");
    expect(config.repo).toBe("team/proj");
    expect(config.manifestUrl).toBe("https://mirror/m.json");
    expect(config.token).toBe("tok123");
    expect(config.channelOverride).toBe("fnos-fpk");
    expect(config.allowPrerelease).toBe(true);
    expect(config.timeoutMs).toBe(5000);
    expect(warnings).toEqual([]);
  });

  it("github 源：精确小写解析为 github，repo 复用且无需 token", () => {
    const { config, warnings } = parseUpdateConfig({
      GX_UPDATE_SOURCE: "github",
      GX_UPDATE_REPO: "acme/gouxiangdb-public",
    });
    expect(config.source).toBe("github");
    expect(config.repo).toBe("acme/gouxiangdb-public");
    expect(config.token).toBe("");
    expect(warnings).toEqual([]);
  });

  it("非法源 warning 文案含三种合法值，且回退默认 gitea", () => {
    const { config, warnings } = parseUpdateConfig({ GX_UPDATE_SOURCE: "gitlab" });
    expect(config.source).toBe("gitea");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gitea/static/github");
  });

  it("安全：token 绝不出现在任何 warning 文本中", () => {
    const secret = "SECRET-PAT-9f8e7d";
    const { warnings } = parseUpdateConfig({
      GX_UPDATE_TOKEN: secret,
      GX_UPDATE_GITEA_BASE_URL: "bad",
      GX_UPDATE_REPO: "bad",
      GX_UPDATE_SOURCE: "bad",
      GX_UPDATE_TIMEOUT_MS: "bad",
    });
    const joined = warnings.join("\n");
    expect(joined).not.toContain(secret);
  });
});
