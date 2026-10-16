// 品牌/基础信息契约纯函数单测（0.2.5）：normalizeServerBaseUrl 是前后端共用的
// 「服务器对外访问网址」规范化唯一真源（apps/api 路由 PATCH 与 apps/web 设置面板同源引用）。
import { describe, expect, it } from "vitest";
import { BRANDING_LIMITS, normalizeServerBaseUrl } from "../branding.js";

describe("normalizeServerBaseUrl", () => {
  it("空串/纯空白 -> 空串（语义=未设置/恢复自动，是合法的清空值）", () => {
    expect(normalizeServerBaseUrl("")).toBe("");
    expect(normalizeServerBaseUrl("   ")).toBe("");
    expect(normalizeServerBaseUrl("\t\n")).toBe("");
  });

  it("https 域名：去尾斜杠（可多个），路径保留", () => {
    expect(normalizeServerBaseUrl("https://gx.example.com/")).toBe("https://gx.example.com");
    expect(normalizeServerBaseUrl("https://gx.example.com///")).toBe("https://gx.example.com");
    expect(normalizeServerBaseUrl("https://gx.example.com/app/gx/")).toBe(
      "https://gx.example.com/app/gx",
    );
  });

  it("无协议裸输入补 http://；保留端口；host 小写、路径保留原大小写", () => {
    expect(normalizeServerBaseUrl("192.168.31.183:5666")).toBe("http://192.168.31.183:5666");
    expect(normalizeServerBaseUrl("NAS.Example.COM:5666/cgi/x/")).toBe(
      "http://nas.example.com:5666/cgi/x",
    );
  });

  it("已是 http/https 时保留协议大小写归一（HTTPS->https）", () => {
    expect(normalizeServerBaseUrl("HTTPS://GX.COM")).toBe("https://gx.com");
    expect(normalizeServerBaseUrl("http://gx.com")).toBe("http://gx.com");
  });

  it("拒绝：非 http(s) 协议", () => {
    expect(normalizeServerBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeServerBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeServerBaseUrl("ftp://gx.com")).toBeNull();
  });

  it("拒绝：含空白 / 路径含双斜杠", () => {
    expect(normalizeServerBaseUrl("https://a b.com")).toBeNull();
    expect(normalizeServerBaseUrl("http://gx.com/a//b")).toBeNull();
  });

  it("WHATWG 标准：https:///x 会被规范成 host=x（合法，照实接受而非误判）", () => {
    expect(normalizeServerBaseUrl("https:///x")).toBe("https://x");
  });

  it("拒绝：带 userinfo（可能泄漏凭据）、query、hash", () => {
    expect(normalizeServerBaseUrl("https://user:pass@gx.com")).toBeNull();
    expect(normalizeServerBaseUrl("https://gx.com?a=1")).toBeNull();
    expect(normalizeServerBaseUrl("https://gx.com#frag")).toBeNull();
  });

  it("长度上限常量就位（>0，足以容纳 host:port/子路径）", () => {
    expect(BRANDING_LIMITS.serverBaseUrlMax).toBeGreaterThanOrEqual(200);
  });
});
