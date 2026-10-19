// installLauncher.ts 生产装配单测（node 环境）：门控开关 + 远端 401 → deauthenticateRemote 接线 + cleanup。
// 401 语义（2026-10「连接＝只选路」）：去认证但**保持选路态**——清该远端会话、活动仍指该远端，
// 守卫把用户送回该远端自己的登录页；绝不再 disconnect（不 regDisconnect、不 set_upstream(none)）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { installLauncher } from "./installLauncher";
import {
  notifyRemoteUnauthorized,
  __resetUnauthorizedBridgeForTest,
} from "./unauthorizedBridge";
import type { LauncherStore } from "./launcherStore";

function fakeStore() {
  const disconnect = vi.fn();
  const deauthenticateRemote = vi.fn();
  const store = { disconnect, deauthenticateRemote } as unknown as LauncherStore;
  return { disconnect, deauthenticateRemote, store };
}

afterEach(() => {
  __resetUnauthorizedBridgeForTest();
});

describe("installLauncher", () => {
  it("门控关闭 → no-op：不装配，远端 401 通知无任何效果", () => {
    const { deauthenticateRemote, store } = fakeStore();
    const r = installLauncher({ enabled: false, store });
    expect(r.installed).toBe(false);
    expect(r.store).toBeNull();
    notifyRemoteUnauthorized("abc123"); // 未注册处理器 → no-op，不抛
    expect(deauthenticateRemote).not.toHaveBeenCalled();
  });

  it("门控开启 → 注册处理器：活动远端 401 时去认证（清会话但保持选路），且不调 disconnect", () => {
    const { disconnect, deauthenticateRemote, store } = fakeStore();
    const r = installLauncher({ enabled: true, store });
    expect(r.installed).toBe(true);
    expect(r.store).toBe(store);

    notifyRemoteUnauthorized("abc123");
    expect(deauthenticateRemote).toHaveBeenCalledTimes(1);
    expect(deauthenticateRemote).toHaveBeenCalledWith("abc123");
    // 关键：只去认证不 disconnect，壳上游/活动指针仍指该远端（守卫送回远端登录页）。
    expect(disconnect).not.toHaveBeenCalled();

    // 幂等：再次装配替换而非叠加处理器。
    const f2 = fakeStore();
    installLauncher({ enabled: true, store: f2.store });
    notifyRemoteUnauthorized("def456");
    expect(deauthenticateRemote).toHaveBeenCalledTimes(1); // 旧处理器不再被调
    expect(f2.deauthenticateRemote).toHaveBeenCalledWith("def456");
    r.cleanup();
  });

  it("cleanup 注销处理器：之后 401 通知 no-op", () => {
    const { deauthenticateRemote, store } = fakeStore();
    const r = installLauncher({ enabled: true, store });
    r.cleanup();
    notifyRemoteUnauthorized("abc123");
    expect(deauthenticateRemote).not.toHaveBeenCalled();
  });
});
