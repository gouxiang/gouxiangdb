// 部署 base 归一与 URL 拼接纯函数单测（无子路径 / 飞牛网关子路径双形态）。
import { describe, it, expect } from "vitest";
import { resolveApiBase, withBase } from "./base";

describe("resolveApiBase", () => {
  it("显式 VITE_API_URL 非空时优先使用并去掉末尾斜杠（绝对来源能力保留）", () => {
    expect(resolveApiBase("https://api.example.com/", "/")).toBe("https://api.example.com");
    expect(resolveApiBase("https://api.example.com", "/app/gouxiangdb/")).toBe(
      "https://api.example.com",
    );
    expect(resolveApiBase("https://api.example.com///", "/")).toBe("https://api.example.com");
  });

  it("显式 VITE_API_URL 为空白字符串时视为未设置", () => {
    expect(resolveApiBase("   ", "/")).toBe("");
    expect(resolveApiBase("   ", "/app/gouxiangdb/")).toBe("/app/gouxiangdb");
  });

  it("未设 VITE_API_URL + 根 base '/' 时归一为 ''（请求仍是 /api/...）", () => {
    expect(resolveApiBase(undefined, "/")).toBe("");
    expect(resolveApiBase("", "/")).toBe("");
  });

  it("未设 VITE_API_URL + 子路径 base '/app/gouxiangdb/' 时归一为 '/app/gouxiangdb'", () => {
    expect(resolveApiBase(undefined, "/app/gouxiangdb/")).toBe("/app/gouxiangdb");
    expect(resolveApiBase("", "/app/gouxiangdb/")).toBe("/app/gouxiangdb");
    // 无尾斜杠形态也应稳定
    expect(resolveApiBase(undefined, "/app/gouxiangdb")).toBe("/app/gouxiangdb");
  });

  it("viteBase 缺省（undefined）时按根部署处理", () => {
    expect(resolveApiBase(undefined, undefined)).toBe("");
  });
});

describe("withBase", () => {
  it("根部署 base='' 时原样返回路径", () => {
    expect(withBase("", "/login")).toBe("/login");
    expect(withBase("", "/api/records")).toBe("/api/records");
  });

  it("子路径部署时为绝对路径补前缀", () => {
    expect(withBase("/app/gouxiangdb", "/login")).toBe("/app/gouxiangdb/login");
    expect(withBase("/app/gouxiangdb", "/uploads/avatars/x.png")).toBe(
      "/app/gouxiangdb/uploads/avatars/x.png",
    );
  });

  it("相对路径补斜杠分隔，不产生双斜杠", () => {
    expect(withBase("/app/gouxiangdb", "favicon.svg")).toBe("/app/gouxiangdb/favicon.svg");
  });

  it("已是绝对 URL / data / blob / 协议相对地址时原样返回（保护内联与外链资源）", () => {
    expect(withBase("/app/gouxiangdb", "data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(withBase("/app/gouxiangdb", "blob:https://h/uuid")).toBe("blob:https://h/uuid");
    expect(withBase("/app/gouxiangdb", "https://cdn.example.com/a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(withBase("/app/gouxiangdb", "//cdn.example.com/a.png")).toBe("//cdn.example.com/a.png");
  });
});
