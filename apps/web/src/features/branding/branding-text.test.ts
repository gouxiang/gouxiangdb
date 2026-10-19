// 品牌文本纯函数单测（node 环境，无依赖）：
//   - renderCopyright：空串不渲染、{year} 全部替换、其它花括号原样；
//   - DEFAULT_BRANDING：与后端默认同值，是全站唯一允许的默认产品名字面量。

import { describe, it, expect } from "vitest";
import { DEFAULT_BRANDING, deriveAutoServerBaseUrl, renderCopyright } from "./branding-text";

describe("renderCopyright", () => {
  it("空串 → 空串（调用方据此不渲染版权行）", () => {
    expect(renderCopyright("")).toBe("");
  });

  it("{year} 替换为显式指定年份", () => {
    expect(renderCopyright("© {year} 构想工作台", 2026)).toBe(
      "© 2026 构想工作台",
    );
  });

  it("默认真实年份与 new Date().getFullYear() 一致", () => {
    expect(renderCopyright("{year}")).toBe(String(new Date().getFullYear()));
  });

  it("多个 {year} 占位全部替换", () => {
    expect(renderCopyright("{year}-{year}", 2030)).toBe("2030-2030");
  });

  it("无占位的版权串原样返回", () => {
    expect(renderCopyright("© 某公司 保留所有权利", 2026)).toBe(
      "© 某公司 保留所有权利",
    );
  });

  it("其它花括号写法（{name}/单括号）原样保留，不做模板扩展", () => {
    expect(renderCopyright("© {year} {name} {", 2026)).toBe("© 2026 {name} {");
  });

  it("花括号内含空白不构成 {year} 占位，原样保留", () => {
    expect(renderCopyright("{ year } {Year}", 2026)).toBe("{ year } {Year}");
  });
});

describe("DEFAULT_BRANDING", () => {
  it("与后端缺省回退同值：默认产品名、空版权、null 广告图、注册默认关", () => {
    expect(DEFAULT_BRANDING).toEqual({
      productName: "构想工作台",
      copyright: "",
      heroUrl: null,
      signupOpen: false,
      serverBaseUrl: "",
    });
  });

  it("DEFAULT_BRANDING.signupOpen === false（加载/失败占位 fail-closed）", () => {
    expect(DEFAULT_BRANDING.signupOpen).toBe(false);
  });
});

describe("deriveAutoServerBaseUrl（未手动固定时的当前默认地址）", () => {
  it("根部署：basePath 空 → 仅 origin（去尾斜杠）", () => {
    expect(deriveAutoServerBaseUrl("http://192.168.31.183:5666", "")).toBe(
      "http://192.168.31.183:5666",
    );
    expect(deriveAutoServerBaseUrl("https://gx.example.com/", "/")).toBe(
      "https://gx.example.com",
    );
  });

  it("子路径部署：origin + 去尾斜杠前缀", () => {
    expect(
      deriveAutoServerBaseUrl("https://gx.example.com", "/app/gouxiangdb/"),
    ).toBe("https://gx.example.com/app/gouxiangdb");
  });

  it("桌面壳回环口：base 为 / 时得到 http://127.0.0.1:<port>", () => {
    expect(deriveAutoServerBaseUrl("http://127.0.0.1:49383", "/")).toBe(
      "http://127.0.0.1:49383",
    );
  });

  it("origin 为空（SSR 无 window）→ 空串，调用方据此不渲染自动地址块", () => {
    expect(deriveAutoServerBaseUrl("", "/app/gouxiangdb")).toBe("");
    expect(deriveAutoServerBaseUrl("   ", "")).toBe("");
  });
});
