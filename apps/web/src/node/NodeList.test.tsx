// NodeList SSR 测试（node + react-dom/server）：空态、本地/远端行、活动标记、动作按钮可用性。
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeList } from "./NodeList";
import type { NodeRow } from "./launcherViewModel";

function row(over: Partial<NodeRow> & Pick<NodeRow, "nodeId" | "kind">): NodeRow {
  return {
    // NodeRow.role 必填（3a 副本行模型）：测试工厂默认 local=主库、remote=null；
    // over 显式给 role 时以其为准（...over 在后覆盖）。
    role: over.kind === "local" ? "primary" : null,
    title: over.nodeId,
    label: null,
    subtitle: "",
    baseURL: "",
    active: false,
    connected: false,
    account: null,
    localDesired: null,
    removable: over.kind === "remote",
    canRename: true,
    lastConnectedAt: null,
    ...over,
  };
}

function render(rows: NodeRow[], props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    React.createElement(NodeList, { rows, ...props }),
  );
}

/** 副本行工厂：kind:"local" 但 role:"replica"（与 toRow 真实副本行一致：可删、副标题是远端基址）。 */
function replicaRow(over: Partial<NodeRow> = {}): NodeRow {
  return row({
    kind: "local",
    role: "replica",
    nodeId: "replica-1",
    title: "办公本-副本",
    subtitle: "http://nas:3001",
    removable: true,
    ...over,
  });
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

  it("W2 ready 本地行：运行中 + 进入本机 + 停止", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", runtime: "ready" }),
    ]);
    expect(html).toContain("运行中");
    expect(html).toContain("进入本机");
    expect(html).toContain(">停止<");
    expect(html).not.toContain("使用本机");
  });

  it("W2 stopped 本地行：已停止 + 进入本机 + 启动", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", runtime: "stopped" }),
    ]);
    expect(html).toContain("已停止");
    expect(html).toContain("进入本机");
    expect(html).toContain(">启动<");
  });

  it("W2 absent 本地行：未启用 + 启动按钮", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", runtime: "absent" }),
    ]);
    expect(html).toContain("未启用");
    expect(html).toContain(">启动<");
  });

  it("W2 starting 本地行：启动中…且两按钮 disabled、带 title 原因", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", runtime: "starting" }),
    ]);
    expect(html).toContain("启动中…");
    expect(html).toContain("本机内核正在启动");
    expect(html).toContain("disabled");
  });

  it("W2 busyNodeId=local-start 时本地行按启动中置灰（即便 runtime=stopped）", () => {
    const html = render(
      [row({ kind: "local", nodeId: "local", title: "本机", runtime: "stopped" })],
      { busyNodeId: "local-start" },
    );
    expect(html).toContain("启动中…");
    expect(html).toContain("disabled");
  });

  it("W2 非壳锁：不传 runtime（unknown）仍是单个「使用本机」，无启动/停止", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", localDesired: "running" }),
    ]);
    expect(html).toContain("使用本机");
    expect(html).not.toContain("进入本机");
    expect(html).not.toContain(">启动<");
    expect(html).not.toContain(">停止<");
  });

  it("无会话远端行：进入按钮（纯选路）+ 可删除，副标题含基址与需要登录", () => {
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
    expect(html).toContain(">进入<");
    expect(html).toContain("需要登录");
    expect(html).toContain("删除");
    // 不再有启动器内凭据重连按钮
    expect(html).not.toContain(">连接<");
  });

  it("未选路、无会话的远端行：主动作只有一个「进入」，busyNodeId=null 时可点（无 disabled）", () => {
    const html = render([
      row({
        kind: "remote",
        nodeId: "abc",
        title: "公司库",
        subtitle: "http://nas:3001",
        baseURL: "http://nas:3001",
      }),
    ]);
    // 主路由动作「进入」整行只有一个（次动作「删除」单独算），且按钮不带 disabled 属性
    //（注意：class 里的 Tailwind `disabled:opacity-50` 是伪类样式，不是禁用属性，需排除）。
    const enterButtons = html.match(/<button[^>]*>进入<\/button>/g) ?? [];
    expect(enterButtons).toHaveLength(1);
    expect(enterButtons[0]).not.toMatch(/\sdisabled(?=[=\s>])/);
    expect(enterButtons[0]).not.toContain("aria-busy");
    // 该行非活动态，不出现活动行才有的「请先断开再删除」禁用理由
    expect(html).not.toContain("请先断开再删除");
    // 删除次动作对非活动远端行可点（active=false → disabled={busy||false}=false）
    const deleteBtn = html.match(/<button[^>]*>删除<\/button>/g) ?? [];
    expect(deleteBtn).toHaveLength(1);
    expect(deleteBtn[0]).not.toMatch(/\sdisabled(?=[=\s>])/);
  });

  it("有已存会话的未活动远端：副标题显示账号 + 已记住登录", () => {
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
    expect(html).toContain("已记住登录");
  });

  it("活动本机行（使用中）：进入 + 断开 两个按钮，供已连接后再次进业务壳", () => {
    const html = render([
      row({ kind: "local", nodeId: "local", title: "本机", active: true, runtime: "ready" }),
    ]);
    expect(html).toContain("使用中");
    expect(html).toContain(">进入<");
    expect(html).toContain(">断开<");
    // 活动行不再渲染非活动态的「进入本机/启动/停止」。
    expect(html).not.toContain("进入本机");
    expect(html).not.toContain(">启动<");
    expect(html).not.toContain(">停止<");
  });

  it("活动远端行：使用中标记 + 进入（可再回到该远端）+ 断开按钮，删除被禁用（title 提示先断开）", () => {
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
    // 回归保护：活动远端必须同时有「进入」（onConnectRemote）与「断开」。
    const enterButtons = html.match(/<button[^>]*>进入<\/button>/g) ?? [];
    expect(enterButtons).toHaveLength(1);
    expect(html).toContain(">断开<");
    expect(html).toContain("请先断开再删除");
  });

  it("占位本机行（canRename=false，从未初始化本机）：即便传 onStartRename 也不渲染重命名入口", () => {
    const html = render(
      [row({ kind: "local", nodeId: "local", title: "本机", canRename: false, runtime: "absent" })],
      { onStartRename: () => {} },
    );
    expect(html).toContain("未启用");
    expect(html.match(/aria-label="重命名"/g) ?? []).toHaveLength(0);
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
    expect(html).not.toContain(">进入<");
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

  // ── 切片 3b：副本行（kind:"local" + role:"replica"）全面按 role 判别，不再被当主库 ──

  it("非活动副本：主按钮「进入副本」（重连），无主库启停/使用本机按钮，可删除", () => {
    const html = render([replicaRow()]);
    expect(html).toContain("办公本-副本");
    expect(html).toContain("http://nas:3001");
    expect(html).toContain(">进入副本<");
    expect(html).toContain("未连接");
    expect(html).toContain("删除");
    // 副本无内核实时相位/独立启停，绝不渲染主库专属动作。
    expect(html).not.toContain("使用本机");
    expect(html).not.toContain("进入本机");
    expect(html).not.toContain(">启动<");
    expect(html).not.toContain(">停止<");
    // 非活动态不渲染活动行的「进入」/「断开」。
    expect(html).not.toContain(">进入<");
    expect(html).not.toContain(">断开<");
  });

  it("非活动副本不渲染 RuntimeDot（实时点只属于主库）", () => {
    // RuntimeDot ready 相位带柔和呼吸 class；副本即便误带 runtime 也不应出现实时点。
    const html = render([replicaRow({ runtime: "ready" })]);
    expect(html).not.toContain("gx-launcher-dot-live");
    // 且不出现主库 ready 才有的「运行中」相位文案（副本副标题走 remoteBaseUrl + 未连接）。
    expect(html).not.toContain("运行中");
  });

  it("非活动副本副标题显远端基址 + 未连接状态后缀", () => {
    const html = render([replicaRow()]);
    // 同一段副标题文本内两者都在。
    expect(html).toContain("http://nas:3001 · 未连接");
  });

  it("已通电但非活动副本（connected=true）：副标题显已连通可进入，仍只给进入副本", () => {
    const html = render([replicaRow({ connected: true })]);
    expect(html).toContain("已连通，可进入");
    expect(html).toContain(">进入副本<");
  });

  it("活动副本（使用中）：进入（onEnterReplica）+ 断开，无重连按钮，副标题只显基址不补状态", () => {
    const html = render([replicaRow({ active: true, connected: true })]);
    expect(html).toContain("使用中");
    const enterButtons = html.match(/<button[^>]*>进入<\/button>/g) ?? [];
    expect(enterButtons).toHaveLength(1);
    expect(html).toContain(">断开<");
    expect(html).not.toContain(">进入副本<");
    expect(html).toContain("请先断开再删除");
    // 活动态副标题不再追加「已连通/未连接」后缀（头部已有使用中标记）。
    expect(html).not.toContain("已连通，可进入");
    expect(html).not.toContain("未连接");
  });

  it("副本 busyNodeId 按 nodeId 精确命中：进入副本按钮 loading/禁用", () => {
    const html = render([replicaRow()], { busyNodeId: "replica-1" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
  });

  it("主库 busy id（local-start）不误伤副本行：副本按钮仍可点", () => {
    const html = render([replicaRow()], { busyNodeId: "local-start" });
    const reconnectBtn = html.match(/<button[^>]*>进入副本<\/button>/g) ?? [];
    expect(reconnectBtn).toHaveLength(1);
    expect(reconnectBtn[0]).not.toMatch(/\sdisabled(?=[=\s>])/);
    expect(reconnectBtn[0]).not.toContain("aria-busy");
  });

  it("副本行品牌色为单色描边（BrandMark mono），主库为彩色品牌带（color）", () => {
    // BrandMark SSR：mono→path/line stroke="currentColor" 且无渐变 defs；
    // color→引用 url(#gx-brand-band-…) 的内置渐变。tone 本身是组件 prop，不落 HTML 属性。
    const replicaHtml = render([replicaRow()]);
    expect(replicaHtml).toContain('stroke="currentColor"');
    expect(replicaHtml).not.toContain("gx-brand-band");
    // 主库行仍为彩色品牌带（回归）。
    const primaryHtml = render([
      row({ kind: "local", nodeId: "local", title: "本机", localDesired: "running" }),
    ]);
    expect(primaryHtml).toContain("gx-brand-band");
    expect(primaryHtml).toContain("使用本机");
  });

  it("副本行编辑态清空名称后占位符回落「本机副本」（而非主库的「本机」）", () => {
    const html = render(
      [replicaRow()],
      {
        rename: { nodeId: "replica-1", value: "" },
        onRenameChange: () => {},
        onRenameCommit: () => {},
        onRenameCancel: () => {},
      },
    );
    expect(html).toContain('placeholder="本机副本"');
  });

  it("主库行回归：非活动主库仍是「使用本机」（runtime unknown），未被副本分支污染", () => {
    const html = render([
      row({ kind: "local", role: "primary", nodeId: "local", title: "本机" }),
    ]);
    expect(html).toContain("使用本机");
    expect(html).not.toContain(">进入副本<");
  });
});
