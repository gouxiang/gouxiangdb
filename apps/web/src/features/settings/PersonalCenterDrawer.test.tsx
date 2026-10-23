// #1056 个人中心抽屉会话来源回归（node：react-dom/server + vi.mock，无 jsdom）。
//
// 旧实现 PersonalCenterDrawer 直读 useAuthStore(s=>s.user)，远端登录不写本地 gx-auth →
// user=null → `if (!open || !user) return null`，抽屉在远端场景零 DOM，右上角点击无反应。
// 修复后 user 取 useActiveSession()。本文件锁：
//   ① open + 远端会话 user：抽屉正常渲染（标题/邮箱/退出登录/各 Tab），即便本地 gx-auth 为空；
//   ② open=true 但活动会话无 user（未登录异常态）：仍返回 null（不渲半残抽屉）；
//   ③ open=false：不渲染。
//
// 退出/资料更新的「分槽动作」属交互逻辑（SSR 无事件），由 node/activeAuth.test.ts 与
// api/__tests__/active-user-sync.test.ts 在纯链路上覆盖。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { UserDTO } from "@gx/shared-types";

let sessionUser: UserDTO | null = null;
const deauthenticateSpy = vi.fn((_u?: unknown) => false);
const refreshSpy = vi.fn((_u?: unknown) => ({ handled: false, token: null }));

vi.mock("../../node/activeSession", () => ({
  useActiveSession: () => ({
    enabled: true,
    kind: "remote",
    nodeId: "node-abc",
    token: sessionUser ? "jwt" : null,
    user: sessionUser,
    authenticated: !!sessionUser,
  }),
}));

vi.mock("../../node/activeAuth", () => ({
  deauthenticateActiveSource: () => deauthenticateSpy(),
  refreshActiveSourceUser: (u: UserDTO) => refreshSpy(u),
}));

// 本地 gx-auth 恒空：证明抽屉内容只可能来自活动会话。
vi.mock("../../store/auth", () => {
  const state = { user: null, token: null as string | null };
  return {
    useAuthStore: Object.assign(
      (sel: (s: unknown) => unknown) => sel(state),
      { getState: () => state },
    ),
  };
});

vi.mock("../../api/hooks", () => ({
  useUpdateMe: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useChangePassword: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteMe: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveAvatar: () => ({ mutateAsync: vi.fn(async () => ({ user: sessionUser })), isPending: false }),
}));

vi.mock("../../api/client", () => ({
  withBase: (p: string) => p,
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super("err");
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("../../node/datasource", () => ({
  dataSourceResolver: {
    baseFor: (p: string) => p,
    headers: () => ({ "X-GX-Token": "jwt" }),
  },
}));

import { PersonalCenterDrawer } from "./PersonalCenterDrawer";

const remoteUser = (): UserDTO =>
  ({
    id: "u-remote",
    email: "far@remote.cn",
    displayName: "远端小王",
    username: "remote_wang",
    phone: null,
    bio: null,
    avatarUrl: null,
  }) as UserDTO;

function renderDrawer(open: boolean) {
  return render(
    <StaticRouter location="/base/b1">
      <PersonalCenterDrawer open={open} onClose={() => undefined} />
    </StaticRouter>,
  );
}

beforeEach(() => {
  sessionUser = remoteUser();
  deauthenticateSpy.mockClear();
  refreshSpy.mockClear();
});

describe("PersonalCenterDrawer 身份取活动会话（#1056）", () => {
  it("open + 远端会话 user（本地 gx-auth 为空）：抽屉正常渲染，含标题/远端邮箱/退出登录", () => {
    const html = renderDrawer(true);
    expect(html).toContain("个人中心");
    expect(html).toContain("far@remote.cn");
    expect(html).toContain("退出登录");
    // 四个 Tab 都在
    expect(html).toContain("个人信息");
    expect(html).toContain("账号设置");
    expect(html).toContain("密码修改");
    expect(html).toContain("注销账号");
  });

  it("open=true 但活动会话无 user：返回 null（旧 bug 的远端空态，不渲半残抽屉）", () => {
    sessionUser = null;
    expect(renderDrawer(true)).toBe("");
  });

  it("open=false：不渲染", () => {
    expect(renderDrawer(false)).toBe("");
  });
});
