// M5/S4 types 纯函数表驱动单测：模式解析、端点归一、错误分类/重试、退避、截断、可用性。

import { describe, expect, it } from "vitest";
import {
  parseEmbeddingMode,
  buildEmbeddingsEndpoint,
  classifyStatus,
  isRetryableKind,
  retryDelayMs,
  clampText,
  cloudConfigUsable,
  MAX_TEXT_CHARS,
} from "../types.js";

describe("parseEmbeddingMode", () => {
  it("仅 cloud（大小写不敏感/去空白）启用 cloud；其余一律回 off", () => {
    expect(parseEmbeddingMode("cloud")).toBe("cloud");
    expect(parseEmbeddingMode("CLOUD")).toBe("cloud");
    expect(parseEmbeddingMode("  Cloud ")).toBe("cloud");
    expect(parseEmbeddingMode(undefined)).toBe("off");
    expect(parseEmbeddingMode("")).toBe("off");
    expect(parseEmbeddingMode("off")).toBe("off");
    expect(parseEmbeddingMode("local")).toBe("off");
    expect(parseEmbeddingMode("xxx")).toBe("off");
  });
});

describe("buildEmbeddingsEndpoint 版本段归一（/v1 保留、/v3 含 /api/plan/v3、无版本兜底 /v1）", () => {
  it.each([
    // 既有 /v1 行为不回归
    ["https://h/v1", "https://h/v1/embeddings"],
    ["https://h/v1/", "https://h/v1/embeddings"],
    ["https://h", "https://h/v1/embeddings"],
    ["https://h/", "https://h/v1/embeddings"],
    ["https://h/v1//", "https://h/v1/embeddings"],
    ["  https://gw/v1/ ", "https://gw/v1/embeddings"],
    // 火山方舟 /api/v3：末段是版本段，原样保留
    [
      "https://ark.cn-beijing.volces.com/api/v3",
      "https://ark.cn-beijing.volces.com/api/v3/embeddings",
    ],
    // /api/plan/v3：只看末段，中间路径不干扰
    [
      "https://ark.cn-beijing.volces.com/api/plan/v3",
      "https://ark.cn-beijing.volces.com/api/plan/v3/embeddings",
    ],
    // /v2 同样识别；非版本段 /api/plan 兜底补 /v1
    ["https://h/api/v2", "https://h/api/v2/embeddings"],
    ["https://h/api/plan", "https://h/api/plan/v1/embeddings"],
    // 尾斜杠 + query/hash 健壮保留
    ["https://ark.cn-beijing.volces.com/api/v3/", "https://ark.cn-beijing.volces.com/api/v3/embeddings"],
    ["https://h/v1?proxy=1", "https://h/v1/embeddings?proxy=1"],
    ["https://h/api/v3#frag", "https://h/api/v3/embeddings#frag"],
  ])("%s -> %s", (base, want) => {
    expect(buildEmbeddingsEndpoint(base)).toBe(want);
  });
});

describe("classifyStatus / isRetryableKind", () => {
  it("401/403=auth 不重试；其余 4xx=client 不重试；5xx=server 可重试", () => {
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(400)).toBe("client");
    expect(classifyStatus(404)).toBe("client");
    expect(classifyStatus(429)).toBe("client");
    expect(classifyStatus(500)).toBe("server");
    expect(classifyStatus(503)).toBe("server");
    expect(isRetryableKind("auth")).toBe(false);
    expect(isRetryableKind("client")).toBe(false);
    expect(isRetryableKind("server")).toBe(true);
    expect(isRetryableKind("timeout")).toBe(true);
    expect(isRetryableKind("network")).toBe(true);
  });
});

describe("retryDelayMs 指数退避（基数 1s，上限钳制）", () => {
  it("第1/2/3 次失败分别 1000/2000/4000，不超 8000 上限", () => {
    expect(retryDelayMs(1, 1000)).toBe(1000);
    expect(retryDelayMs(2, 1000)).toBe(2000);
    expect(retryDelayMs(3, 1000)).toBe(4000);
    expect(retryDelayMs(99, 1000)).toBe(8000);
  });
});

describe("clampText 按码点截断（正确处理多字节）", () => {
  it("短串不变；超长截到 MAX_TEXT_CHARS 码点", () => {
    expect(clampText("abc", 8000)).toBe("abc");
    const long = "项".repeat(MAX_TEXT_CHARS + 100);
    const cut = clampText(long);
    expect(Array.from(cut).length).toBe(MAX_TEXT_CHARS);
    // 代理对不被切半（U+1F600 = 2 个 UTF-16 代理码元，用 fromCodePoint 构造，源码不写 emoji 字面量）。
    const astral = String.fromCodePoint(0x1f600).repeat(MAX_TEXT_CHARS + 5);
    expect(Array.from(clampText(astral)).length).toBe(MAX_TEXT_CHARS);
  });
});

describe("cloudConfigUsable", () => {
  it("三者（baseURL/apiKey/model）齐备才可用", () => {
    expect(cloudConfigUsable({ baseURL: "u", apiKey: "k", model: "m" })).toBe(true);
    expect(cloudConfigUsable({ baseURL: "  ", apiKey: "k", model: "m" })).toBe(false);
    expect(cloudConfigUsable({ baseURL: "u", apiKey: "", model: "m" })).toBe(false);
    expect(cloudConfigUsable({ baseURL: "u", apiKey: "k" })).toBe(false);
    expect(cloudConfigUsable(undefined)).toBe(false);
  });
});
