// installLauncher.ts 生产装配单测（node 环境）：门控开关 + 远端 401 → disconnect 接线 + cleanup。
import { describe, it, expect, vi, afterEach } from "vitest";
import { installLauncher } from "./installLauncher";
import {
  notifyRemoteUnauthorized,
  __resetUnauthorizedBridgeForTest,
} from "./unauthorizedBridge";
import type { LauncherStore } from "./launcherStore";

function fakeStore() {
  const disconnect = vi.fn();
  const store = { disconnect } as unknown as LauncherStore;
  return { disconnect, store };
}

afterEach(() => {
  __resetUnauthorizedBridgeForTest();
});

describe("installLauncher", () => {
  it("门控关闭 → no-op：不装配，远端 401 通知无任何效果", () => {
    const { disconnect, store } = fakeStore();
    const r = installLauncher({ enabled: false, store });
    expect(r.installed).toBe(false);
    expect(r.store).toBeNull();
    notifyRemoteUnauthorized("abc123"); // 未注册处理器 → no-op，不抛
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("门控开启 → 注册处理器：活动远端 401 时断开该节点（清会话/活动指针回落）", () => {
    const { disconnect, store } = fakeStore();
    const r = installLauncher({ enabled: true, store });
    expect(r.installed).toBe(true);
    expect(r.store).toBe(store);

    notifyRemoteUnauthorized("abc123");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith("abc123");

    // 幂等：再次装配替换而非叠加处理器。
    const disconnect2 = vi.fn();
    const store2 = { disconnect: disconnect2 } as unknown as LauncherStore;
    installLauncher({ enabled: true, store: store2 });
    notifyRemoteUnauthorized("def456");
    expect(disconnect).toHaveBeenCalledTimes(1); // 旧处理器不再被调
    expect(disconnect2).toHaveBeenCalledWith("def456");
    r.cleanup();
  });

  it("cleanup 注销处理器：之后 401 通知 no-op", () => {
    const { disconnect, store } = fakeStore();
    const r = installLauncher({ enabled: true, store });
    r.cleanup();
    notifyRemoteUnauthorized("abc123");
    expect(disconnect).not.toHaveBeenCalled();
  });
});
