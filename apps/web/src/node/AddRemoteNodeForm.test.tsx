// AddRemoteNodeForm View SSR 测试（node + react-dom/server，无 jsdom/无新依赖）。
// 「连接＝只选路」后表单只问网址 + 可选名称（账号密码由进入后的远端节点自己登录页收集）。
// 锁：字段与占位文案、§7.3 确定错误文案渲染、busy 禁用/加载文案、成功提示、无密码输入。
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
  it("只渲染网址与名称两个字段及占位提示，不收集账号密码", () => {
    const html = render();
    expect(html).toContain("节点网址");
    expect(html).toContain("http://192.168.1.5:3001");
    expect(html).toContain("名称（可选）");
    expect(html).toContain("例如：家里的库");
    expect(html).toContain("添加并进入");
    // 纯选路：不再出现账号/密码字段或密码掩码输入
    expect(html).not.toContain("账号（邮箱）");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("autoComplete=\"username\"");
  });

  it("busy：按钮显示正在添加、aria-busy，输入禁用", () => {
    const html = render(EMPTY_ADD_REMOTE_VALUES, { busy: true });
    expect(html).toContain("正在添加…");
    expect(html).toContain('aria-busy="true"');
    // 输入被禁用（2 个 Input + 提交按钮 + 取消）
    expect(html).toContain("disabled");
  });

  it("各失败分类渲染 §7.3 确定文案，且错误条带 alert 角色", () => {
    const cases: Array<[{ stage: string; code: string }, string]> = [
      [{ stage: "form", code: "invalid_url" }, "请输入有效的节点网址"],
      [{ stage: "form", code: "duplicate" }, "已在列表中"],
      [{ stage: "handshake", code: "unreachable" }, "无法连接到该节点"],
      [{ stage: "handshake", code: "version_incompatible" }, "节点版本不受支持"],
      [{ stage: "handshake", code: "not_initialized" }, "尚未完成初始化"],
    ];
    for (const [error, fragment] of cases) {
      const html = render(EMPTY_ADD_REMOTE_VALUES, { error });
      expect(html).toContain('role="alert"');
      expect(html).toContain(fragment);
    }
  });

  it("无错误时不渲染 alert；成功时渲染 status 已添加", () => {
    expect(render()).not.toContain('role="alert"');
    const html = render(EMPTY_ADD_REMOTE_VALUES, { succeeded: true });
    expect(html).toContain('role="status"');
    expect(html).toContain("已添加，正在进入");
  });

  it("带取消回调时渲染取消按钮", () => {
    const html = render(EMPTY_ADD_REMOTE_VALUES, { onCancel: vi.fn() });
    expect(html).toContain("取消");
  });
});
