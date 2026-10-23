// #1056 顶栏身份来源回归（node：react-dom/server + vi.mock，无 jsdom）。
//
// 远端连接场景：登录态只落该远端节点会话分键、不写本地 gx-auth。顶栏必须从「当前活动会话」
// 取 user——旧实现直读 useAuthStore 会拿到 null，头像退化成 "?" 且点击打不开个人中心。
// 本文件锁：
//   ① 远端活动会话：顶栏渲染远端 user 的昵称与首字母头像，不依赖本地 gx-auth；
//   ② 本地会话（门控关，gx-auth 有用户）：同样正常渲染，现网零变化；
//   ③ 个人中心触发器（.gx-who / aria-label）始终在，点击态由抽屉自身测试覆盖。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { UserDTO } from "@gx/shared-types";

let sessionUser: UserDTO | null = null;
let sessionKind: "local" | "remote" = "remote";

vi.mock("../../node/activeSession", () => ({
  useActiveSession: () => ({
    enabled: sessionKind === "remote",
    kind: sessionKind,
    nodeId: sessionKind === "remote" ? "node-abc" : "local",
    token: sessionUser ? "jwt" : null,
    user: sessionUser,
    authenticated: !!sessionUser,
  }),
}));

// 本地 gx-auth 恒为空：证明远端头像/昵称只可能来自活动会话，而非本地 store。
vi.mock("../../store/auth", () => {
  const state = { user: null, token: null as string | null };
  return {
    useAuthStore: Object.assign(
      (sel: (s: unknown) => unknown) => sel(state),
      { getState: () => state },
    ),
  };
});

vi.mock("../../components/LibrarySwitcher", () => ({ LibrarySwitcher: () => null }));
vi.mock("../settings/PersonalCenterDrawer", () => ({ PersonalCenterDrawer: () => null }));
vi.mock("../../api/hooks", () => ({
  useTables: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../kb/kb-hooks", () => ({
  useKbDocs: () => ({ data: [], isLoading: false, isError: false }),
}));
// 同步中心仅「壳 + 副本启用」才渲染，测试恒关，避免引入 sync store 副作用。
vi.mock("../../store/sync", () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ enabled: false, report: {}, phase: "idle", openCenter: () => {} }),
}));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

const remoteUser = (): UserDTO =>
  ({ id: "u-remote", email: "far@remote.cn", displayName: "远端小王" }) as UserDTO;

function renderBar() {
  return render(
    <StaticRouter location="/base/b1">
      <WorkspaceTopBar onOpenSearch={() => undefined} />
    </StaticRouter>,
  );
}

beforeEach(() => {
  sessionKind = "remote";
  sessionUser = remoteUser();
});

describe("WorkspaceTopBar 身份取活动会话（#1056）", () => {
  it("远端会话：本地 gx-auth 为空，仍渲染远端 user 的昵称与首字母头像", () => {
    const html = renderBar();
    expect(html).toContain("远端小王");
    // 头像圆圈内为首字母（昵称「远」的 toUpperCase 不改变中文，取第一个字符）
    expect(html).toContain("远");
    // 不应退化成未登录占位 "?"
    expect(html).not.toContain(">?<");
  });

  it("个人中心触发器在（.gx-who + 可访问名称）", () => {
    const html = renderBar();
    expect(html).toContain("gx-who");
    expect(html).toContain('aria-label="打开个人中心"');
  });

  it("本地会话（门控关）：取本地 gx-auth 形态的用户也正常渲染，现网零变化", () => {
    sessionKind = "local";
    sessionUser = { id: "u-local", email: "me@local.cn", displayName: "本机管理员" } as UserDTO;
    const html = renderBar();
    expect(html).toContain("本机管理员");
    expect(html).toContain("gx-who");
  });
});
