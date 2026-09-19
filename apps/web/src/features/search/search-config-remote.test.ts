// 远端配置项的表单纯函数测试：非法值必须被显式拦下（不能静默丢字段），
// dim 必须按服务形态分档发出（cloud 档发出会被后端 400）。无 jsdom 依赖，纯函数层锁定。
import { describe, expect, it } from "vitest";
import { buildConfigPatch, validateConfigForm, type ConfigForm } from "./search-config";
import { providerAllowsManualDim } from "@gx/shared-types";

const base: ConfigForm = {
  mode: "cloud",
  provider: "cloud",
  baseURL: "https://x/v1",
  model: "m",
  batchSize: "32",
  timeoutMs: "8000",
  fieldChunkCap: "500",
  concurrency: "4",
  retryMaxAttempts: "3",
  retryBaseMs: "1000",
  apiKey: "",
};

describe("provider 与 dim 分档", () => {
  it("dimEditable 只认自建与 OpenAI 兼容档；cloud 档不可手填", () => {
    expect(providerAllowsManualDim("cloud")).toBe(false);
    expect(providerAllowsManualDim("openai-compatible")).toBe(true);
    expect(providerAllowsManualDim("self-hosted")).toBe(true);
  });

  it("cloud 档不发 dim（后端会 400）；自建/兼容档发合法 dim", () => {
    const cloud = buildConfigPatch({ ...base, dim: "768" }, true) as Record<string, unknown>;
    expect(cloud).not.toHaveProperty("dim");
    const self = buildConfigPatch({ ...base, provider: "self-hosted", dim: "768" }, true) as Record<string, unknown>;
    expect(self.dim).toBe(768);
    expect(self.provider).toBe("self-hosted");
  });

  it("缺省 provider 按 cloud 处理（老配置兼容）", () => {
    const p = buildConfigPatch({ ...base, provider: undefined }, true) as Record<string, unknown>;
    expect(p.provider).toBe("cloud");
  });
});

describe("validateConfigForm：非法值明确报错，不静默接受", () => {
  it("全合法 -> null", () => {
    expect(validateConfigForm(base)).toBeNull();
    expect(validateConfigForm({ ...base, provider: "self-hosted", dim: "1024" })).toBeNull();
  });

  it("维度填 0 / 负数 / 超界 / 非整数 -> 报「向量维度」", () => {
    for (const dim of ["0", "-1", "4097", "1.5", "abc"]) {
      const msg = validateConfigForm({ ...base, provider: "self-hosted", dim });
      expect(msg, `dim=${dim}`).toContain("向量维度");
    }
    // cloud 档不校验 dim（该档维度由模型决定，输入框也不渲染）。
    expect(validateConfigForm({ ...base, dim: "0" })).toBeNull();
  });

  it("并发填 0 / 负数 / 超界 -> 报「并发数」", () => {
    for (const concurrency of ["0", "-2", "65"]) {
      expect(validateConfigForm({ ...base, concurrency }), `c=${concurrency}`).toContain("并发数");
    }
  });

  it("重试次数与退避基数越界分别点名", () => {
    expect(validateConfigForm({ ...base, retryMaxAttempts: "0" })).toContain("重试次数");
    expect(validateConfigForm({ ...base, retryMaxAttempts: "11" })).toContain("重试次数");
    expect(validateConfigForm({ ...base, retryBaseMs: "0" })).toContain("退避基数");
  });

  it("空串视为「不改」而非非法；空 dim 也放行", () => {
    expect(validateConfigForm({ ...base, concurrency: "", dim: "" })).toBeNull();
  });

  it("其它既有数值字段非法同样点名（批量/超时/字段上限）", () => {
    expect(validateConfigForm({ ...base, batchSize: "0" })).toContain("批量大小");
    expect(validateConfigForm({ ...base, timeoutMs: "abc" })).toContain("超时");
    expect(validateConfigForm({ ...base, fieldChunkCap: "1001" })).toContain("字段索引上限");
  });
});

describe("buildConfigPatch 并发/重试与总门覆盖", () => {
  it("并发与重试进请求体；非法串落为 undefined（由 validate 拦在提交前）", () => {
    const p = buildConfigPatch(base, true);
    expect(p.concurrency).toBe(4);
    expect(p.retryMaxAttempts).toBe(3);
    expect(p.retryBaseMs).toBe(1000);
    const bad = buildConfigPatch({ ...base, concurrency: "0" }, true);
    expect(bad.concurrency).toBeUndefined();
  });

  it("searchEnabled 透传；未设置时不发（保持既有覆盖值）", () => {
    expect(buildConfigPatch({ ...base, searchEnabled: "off" }, true).searchEnabled).toBe("off");
    expect(buildConfigPatch(base, true).searchEnabled).toBeUndefined();
  });

  it("永不产出 reindex 字段（出现即 400）", () => {
    expect(buildConfigPatch(base, true) as Record<string, unknown>).not.toHaveProperty("reindex");
  });
});
