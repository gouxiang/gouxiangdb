// LauncherErrorBar SSR 测试（node + react-dom/server）：有 message 含告警语义与关闭按钮，null 输出空。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LauncherErrorBar } from "./LauncherErrorBar";

function render(message: string | null) {
  return renderToStaticMarkup(
    React.createElement(LauncherErrorBar, { message, onClose: () => {} }),
  );
}

describe("LauncherErrorBar", () => {
  it("message 为 null 时输出空字符串", () => {
    expect(render(null)).toBe("");
  });

  it("有 message 时渲染正文、role=alert 与关闭按钮（aria-label）", () => {
    const html = render("启动本机失败：端口被占用");
    expect(html).toContain("启动本机失败：端口被占用");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-label="关闭错误提示"');
  });
});
