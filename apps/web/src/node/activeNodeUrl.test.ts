// apps/web/src/node/activeNodeUrl.test.ts
// 「服务端网址」自动识别取值：门控关零变化；壳+远端显示远端真实 origin；壳+本机隐藏回环口。
import { describe, it, expect } from "vitest";
import { originOfHttpUrl, resolveBrandingAutoOrigin } from "./activeNodeUrl";

describe("originOfHttpUrl", () => {
  it("取 http(s) 的 scheme://host[:port]，去路径/尾斜杠", () => {
    expect(originOfHttpUrl("http://192.168.31.15:3001/")).toBe("http://192.168.31.15:3001");
    expect(originOfHttpUrl("https://gx.example.com/app/gx/")).toBe("https://gx.example.com");
    expect(originOfHttpUrl("http://nas:3001")).toBe("http://nas:3001");
  });
  it("非法/空/非 http(s) 返回空串", () => {
    expect(originOfHttpUrl("")).toBe("");
    expect(originOfHttpUrl("   ")).toBe("");
    expect(originOfHttpUrl("not a url")).toBe("");
    expect(originOfHttpUrl("ftp://192.168.31.15")).toBe("");
  });
});

describe("resolveBrandingAutoOrigin", () => {
  it("门控关（浏览器/fnOS/服务器）：恒返回 browserOrigin，与历史逐字节一致", () => {
    expect(
      resolveBrandingAutoOrigin({
        enabled: false,
        kind: "local",
        browserOrigin: "http://192.168.31.183:5666",
        routedRemoteOrigin: "",
      }),
    ).toBe("http://192.168.31.183:5666");
  });

  it("壳 + 远端：返回被连远端节点的真实 origin（不是壳回环口）", () => {
    expect(
      resolveBrandingAutoOrigin({
        enabled: true,
        kind: "remote",
        browserOrigin: "http://127.0.0.1:60513",
        routedRemoteOrigin: "http://192.168.31.15:3001",
      }),
    ).toBe("http://192.168.31.15:3001");
  });

  it("壳 + 远端但取不到真实地址：返回空串（面板隐藏自动块，绝不回退显示 127.0.0.1）", () => {
    expect(
      resolveBrandingAutoOrigin({
        enabled: true,
        kind: "remote",
        browserOrigin: "http://127.0.0.1:60513",
        routedRemoteOrigin: "",
      }),
    ).toBe("");
  });

  it("壳 + 本机：返回空串（回环口不能对外，LAN 地址探测未接入前不展示）", () => {
    expect(
      resolveBrandingAutoOrigin({
        enabled: true,
        kind: "local",
        browserOrigin: "http://127.0.0.1:60513",
        routedRemoteOrigin: "",
      }),
    ).toBe("");
  });
});
