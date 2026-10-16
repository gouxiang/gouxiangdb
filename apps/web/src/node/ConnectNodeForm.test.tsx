// ConnectNodeForm View SSR 测试：标题/基址、字段、busy、错误文案、返回按钮。
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectNodeFormView } from "./ConnectNodeForm";

function render(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    React.createElement(ConnectNodeFormView, {
      title: "公司库",
      baseURL: "http://nas:3001",
      email: "",
      password: "",
      onField: vi.fn(),
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    }),
  );
}

describe("ConnectNodeFormView", () => {
  it("展示目标标题/基址 + 账号密码字段 + 连接/返回", () => {
    const html = render();
    expect(html).toContain("连接「公司库」");
    expect(html).toContain("http://nas:3001");
    expect(html).toContain("账号（邮箱）");
    expect(html).toContain('type="password"');
    expect(html).toContain(">连接<");
    expect(html).toContain("返回");
  });

  it("busy 显示连接中并禁用", () => {
    const html = render({ busy: true });
    expect(html).toContain("连接中…");
    expect(html).toContain('aria-busy="true"');
  });

  it("错误分类渲染确定文案与 alert 角色", () => {
    const html = render({ error: { stage: "login", code: "invalid_credentials" } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("邮箱或密码错误");
  });
});
