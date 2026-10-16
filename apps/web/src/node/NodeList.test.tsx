// NodeList SSR 测试（node + react-dom/server）：空态、本地/远端行、活动标记、动作按钮可用性。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeList } from "./NodeList";
import type { NodeRow } from "./launcherViewModel";

function row(over: Partial<NodeRow> & Pick<NodeRow, "nodeId" | "kind">): NodeRow {
  return {
    title: over.nodeId,
    label: null,
    subtitle: "",
    baseURL: "",
    active: false,
    connected: false,
    account: null,
    localDesired: null,
    removable: over.kind === "remote",
    lastConnectedAt: null,
    ...over,
  };
}

function render(rows: NodeRow[], props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    React.createElement(NodeList, { rows, ...props }),
  );
}

describe("NodeList", () => {
  it("空列表显示引导空态", () => {
    expect(render([])).toContain("还没有节点，先添加一个节点开始");
  });

  it("本地行：标题 + 使用本机按钮、不可删（无删除按钮）", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", localDesired: "running" }),
    ]);
    expect(html).toContain("本机");
    expect(html).toContain("使用本机");
    expect(html).not.toContain("删除");
  });

  it("本地 stopped 行副标题显示已停止", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", localDesired: "stopped" }),
    ]);
    expect(html).toContain("已停止");
  });

  it("未连接远端行：连接按钮 + 可删除，副标题含基址与未连接", () => {
    const html = render([
      row({
        kind: "remote",
        nodeId: "abc",
        title: "公司库",
        subtitle: "http://nas:3001",
        baseURL: "http://nas:3001",
      }),
    ]);
    expect(html).toContain("公司库");
    expect(html).toContain("http://nas:3001");
    expect(html).toContain(">连接<");
    expect(html).toContain("删除");
  });

  it("有已存会话的未活动远端：副标题显示账号 + 可免密重连", () => {
    const html = render([
      row({
        kind: "remote",
        nodeId: "abc",
        title: "公司库",
        subtitle: "http://nas:3001",
        baseURL: "http://nas:3001",
        connected: true,
        account: "a@b.com",
      }),
    ]);
    expect(html).toContain("a@b.com");
    expect(html).toContain("可免密重连");
  });

  it("活动远端行：使用中标记 + 断开按钮，删除被禁用（title 提示先断开）", () => {
    const html = render([
      row({
        kind: "remote",
        nodeId: "abc",
        title: "公司库",
        subtitle: "http://nas:3001",
        baseURL: "http://nas:3001",
        active: true,
        connected: true,
      }),
    ]);
    expect(html).toContain("使用中");
    expect(html).toContain(">断开<");
    expect(html).toContain("请先断开再删除");
  });

  it("busyNodeId 命中行时动作按钮 loading/禁用", () => {
    const html = render(
      [row({ kind: "remote", nodeId: "abc", title: "公司库", subtitle: "x", baseURL: "x" })],
      { busyNodeId: "abc" },
    );
    expect(html).toContain('aria-busy="true"');
  });

  it("未传 onStartRename 时不渲染重命名入口（保持纯展示可选）", () => {
    const html = render([
      row({ kind: "remote", nodeId: "abc", title: "公司库", subtitle: "x", baseURL: "x" }),
    ]);
    expect(html).not.toContain("重命名");
  });

  it("传入 onStartRename 后每行出现重命名按钮", () => {
    const html = render(
      [
        row({ kind: "local", nodeId: "local", title: "本机", localDesired: "running" }),
        row({
          kind: "remote",
          nodeId: "abc",
          title: "公司库",
          subtitle: "http://nas:3001",
          baseURL: "http://nas:3001",
        }),
      ],
      { onStartRename: () => {} },
    );
    // 两行各一枚重命名按钮。
    expect(html.match(/aria-label="重命名"/g)?.length).toBe(2);
  });

  it("远端行进入编辑态：输入框预填草稿+占位默认 host，出保存/取消，隐藏连接与删除", () => {
    const html = render(
      [
        row({
          kind: "remote",
          nodeId: "abc",
          title: "公司库",
          subtitle: "http://nas:3001",
          baseURL: "http://nas:3001",
        }),
      ],
      {
        rename: { nodeId: "abc", value: "新名字" },
        onRenameChange: () => {},
        onRenameCommit: () => {},
        onRenameCancel: () => {},
      },
    );
    expect(html).toContain('aria-label="节点名称"');
    expect(html).toContain('value="新名字"');
    expect(html).toContain('placeholder="nas:3001"');
    expect(html).toContain('aria-label="保存名称"');
    expect(html).toContain('aria-label="取消"');
    expect(html).not.toContain(">连接<");
    expect(html).not.toContain(">删除<");
    expect(html).not.toContain("重命名");
  });

  it("本地行编辑态占位符回落本机", () => {
    const html = render(
      [row({ kind: "local", nodeId: "local", title: "本机", localDesired: "running" })],
      {
        rename: { nodeId: "local", value: "" },
        onRenameChange: () => {},
        onRenameCommit: () => {},
        onRenameCancel: () => {},
      },
    );
    expect(html).toContain('placeholder="本机"');
  });
});
