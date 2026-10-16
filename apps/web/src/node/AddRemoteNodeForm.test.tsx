// AddRemoteNodeForm View SSR 测试（node + react-dom/server，无 jsdom/无新依赖）。
// 锁：字段与占位文案、§7.3 确定错误文案渲染、busy 禁用/加载文案、成功提示。
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AddRemoteNodeFormView,
  EMPTY_ADD_REMOTE_VALUES,
  type AddRemoteFormValues,
} from "./AddRemoteNodeForm";

function render(values: AddRemoteFormValues = EMPTY_ADD_REMOTE_VALUES, extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    React.createElement(AddRemoteNodeFormView, {
      values,
      onField: vi.fn(),
      onSubmit: vi.fn(),
      ...extra,
    }),
  );
}

describe("AddRemoteNodeFormView", () => {
  it("渲染四个字段及占位提示，含密码掩码输入", () => {
    const html = render();
    expect(html).toContain("节点网址");
    expect(html).toContain("http://192.168.1.5:3001");
    expect(html).toContain("账号（邮箱）");
    expect(html).toContain("密码");
    expect(html).toContain('type="password"');
    expect(html).toContain("名称（可选）");
    expect(html).toContain("添加并连接");
  });

  it("busy：按钮显示连接中、aria-busy", () => {
    const html = render(EMPTY_ADD_REMOTE_VALUES, { busy: true });
    expect(html).toContain("连接中…");
    expect(html).toContain('aria-busy="true"');
    // 输入被禁用（4 个 Input + 提交按钮）
    expect(html).toContain("disabled");
  });

  it("各失败分类渲染 §7.3 确定文案，且错误条带 alert 角色", () => {
    const cases: Array<[{ stage: string; code: string }, string]> = [
      [{ stage: "form", code: "invalid_url" }, "请输入有效的节点网址"],
      [{ stage: "handshake", code: "unreachable" }, "无法连接到该节点"],
      [{ stage: "handshake", code: "version_incompatible" }, "节点版本不受支持"],
      [{ stage: "handshake", code: "not_initialized" }, "尚未完成初始化"],
      [{ stage: "login", code: "invalid_credentials" }, "邮箱或密码错误"],
    ];
    for (const [error, fragment] of cases) {
      const html = render(EMPTY_ADD_REMOTE_VALUES, { error });
      expect(html).toContain('role="alert"');
      expect(html).toContain(fragment);
    }
  });

  it("无错误时不渲染 alert；成功时渲染 status 已连接", () => {
    expect(render()).not.toContain('role="alert"');
    const html = render(EMPTY_ADD_REMOTE_VALUES, { succeeded: true });
    expect(html).toContain('role="status"');
    expect(html).toContain("已连接");
  });

  it("带取消回调时渲染取消按钮", () => {
    const html = render(EMPTY_ADD_REMOTE_VALUES, { onCancel: vi.fn() });
    expect(html).toContain("取消");
  });
});
