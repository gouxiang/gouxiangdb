// M6-FE PAT 纯映射单测（node，无 DOM）：scope 中文标签/顺序、默认只读勾选、有效期选项与解析、
// 令牌状态（吊销优先过期）、过期文案、错误码中性文案（429 尊重 Retry-After / 400 直传 / 404 / 403）。
import { describe, it, expect } from "vitest";
import {
  DEFAULT_READ_SCOPES,
  PAT_EXPIRY_OPTIONS,
  PAT_STATE_LABEL,
  canRevoke,
  canSubmitCreate,
  orderScopes,
  parseExpiryValue,
  patErrorText,
  patExpiryLabel,
  patTokenState,
  requiresNeverExpiryConfirm,
  scopeLabel,
} from "./pat-labels";
import type { PatScope } from "../../api/client";

const ALL: PatScope[] = [
  "record:read",
  "record:write",
  "doc:read",
  "doc:write",
  "canvas:read",
  "canvas:write",
];

describe("scope 中文标签", () => {
  it("六位 scope 全部有中文标签，且不回落原文", () => {
    for (const s of ALL) {
      const label = scopeLabel(s);
      expect(label).not.toBe(s);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(scopeLabel("record:read")).toBe("读取数据表");
    expect(scopeLabel("canvas:write")).toBe("写入画布");
  });

  it("未知 scope 原样回落（后端增位不致空白）", () => {
    expect(scopeLabel("future:x")).toBe("future:x");
  });
});

describe("默认勾选与 ordering", () => {
  it("默认仅三个只读档（含 canvas:read），三个写入档不在默认集（C-2 最小权限）", () => {
    expect([...DEFAULT_READ_SCOPES]).toEqual(["record:read", "doc:read", "canvas:read"]);
    expect(DEFAULT_READ_SCOPES).not.toContain("record:write");
    expect(DEFAULT_READ_SCOPES).not.toContain("doc:write");
    expect(DEFAULT_READ_SCOPES).not.toContain("canvas:write");
  });

  it("orderScopes 按固定顺序归一并去重", () => {
    expect(orderScopes(["canvas:write", "record:read", "record:read"])).toEqual([
      "record:read",
      "canvas:write",
    ]);
  });
});

describe("有效期选项（C-3）", () => {
  it("选项为 30/90/365/永不过期，默认 90", () => {
    expect(PAT_EXPIRY_OPTIONS.map((o) => o.days)).toEqual([30, 90, 365, null]);
    expect(parseExpiryValue("90")).toBe(90);
    expect(parseExpiryValue("never")).toBeNull();
    expect(parseExpiryValue("365")).toBe(365);
    // 未知值回落默认 90
    expect(parseExpiryValue("bogus")).toBe(90);
  });

  it("requiresNeverExpiryConfirm：仅 null 需强警示二次确认", () => {
    expect(requiresNeverExpiryConfirm(null)).toBe(true);
    expect(requiresNeverExpiryConfirm(30)).toBe(false);
    expect(requiresNeverExpiryConfirm(90)).toBe(false);
    expect(requiresNeverExpiryConfirm(365)).toBe(false);
  });
});

describe("提交校验", () => {
  it("名称 1–60 且至少一个 scope 才可提交", () => {
    expect(canSubmitCreate("脚本", ["record:read"])).toBe(true);
    expect(canSubmitCreate("   ", ["record:read"])).toBe(false);
    expect(canSubmitCreate("x".repeat(61), ["record:read"])).toBe(false);
    expect(canSubmitCreate("脚本", [])).toBe(false);
  });
});

describe("令牌状态（吊销优先于过期）", () => {
  const now = Date.parse("2026-09-18T00:00:00.000Z");
  it("未吊销未过期=有效；过期=已过期；吊销（即便已过期）=已吊销", () => {
    expect(patTokenState({ revokedAt: null, expiresAt: null }, now)).toBe("active");
    expect(patTokenState({ revokedAt: null, expiresAt: "2026-10-01T00:00:00.000Z" }, now)).toBe("active");
    expect(patTokenState({ revokedAt: null, expiresAt: "2026-09-01T00:00:00.000Z" }, now)).toBe("expired");
    expect(patTokenState({ revokedAt: "2026-09-10T00:00:00.000Z", expiresAt: null }, now)).toBe("revoked");
    expect(
      patTokenState({ revokedAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" }, now),
    ).toBe("revoked");
  });

  it("状态中文标签齐全；已吊销行不可再吊销", () => {
    expect(PAT_STATE_LABEL.active).toBe("有效");
    expect(canRevoke({ revokedAt: null })).toBe(true);
    expect(canRevoke({ revokedAt: "2026-09-10T00:00:00.000Z" })).toBe(false);
  });

  it("patExpiryLabel：永不过期 / 到期时间 / 已过期标注", () => {
    expect(patExpiryLabel(null, now)).toBe("永不过期");
    expect(patExpiryLabel("2026-10-01T00:00:00.000Z", now)).toContain("2026");
    expect(patExpiryLabel("2026-09-01T00:00:00.000Z", now)).toContain("已于");
  });
});

describe("错误码中性文案", () => {
  it("429 尊重 Retry-After 秒数", () => {
    expect(patErrorText({ status: 429, code: "MCP_RATE_LIMITED", message: null, retryAfterSec: 42 })).toContain(
      "42 秒",
    );
    expect(patErrorText({ status: 429, code: null, message: null, retryAfterSec: null })).toContain("过于频繁");
  });

  it("400 直传后端中文校验消息", () => {
    expect(patErrorText({ status: 400, code: "PAT_NAME_INVALID", message: "名称不超过 60 字符" })).toBe(
      "名称不超过 60 字符",
    );
    // 无 message 时给中性兜底
    expect(patErrorText({ status: 400, code: "PAT_SCOPE_INVALID", message: null })).toContain("检查");
  });

  it("404 PAT_NOT_FOUND 中性化，不泄漏存在性", () => {
    expect(patErrorText({ status: 404, code: "PAT_NOT_FOUND", message: null })).toContain("不存在");
    expect(patErrorText({ status: 404, code: null, message: "令牌不存在" })).toBe("令牌不存在");
  });

  it("403 提示环境未开放（MCP 门控 fail-closed）", () => {
    expect(patErrorText({ status: 403, code: null, message: null })).toContain("未开放");
  });
});
