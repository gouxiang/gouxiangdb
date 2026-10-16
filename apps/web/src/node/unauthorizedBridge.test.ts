// unauthorizedBridge.ts 纯逻辑测试（node 环境）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerRemoteUnauthorizedHandler,
  notifyRemoteUnauthorized,
  __resetUnauthorizedBridgeForTest,
} from "./unauthorizedBridge";

beforeEach(() => {
  __resetUnauthorizedBridgeForTest();
});

describe("unauthorizedBridge：远端 401 分流槽", () => {
  it("未注册处理器时 notify no-op、不抛错", () => {
    expect(() => notifyRemoteUnauthorized("abc")).not.toThrow();
  });

  it("注册后 notify 以 nodeId 调用处理器", () => {
    const h = vi.fn();
    registerRemoteUnauthorizedHandler(h);
    notifyRemoteUnauthorized("node-xyz");
    expect(h).toHaveBeenCalledOnce();
    expect(h).toHaveBeenCalledWith("node-xyz");
  });

  it("传 null 注销后不再调用旧处理器", () => {
    const h = vi.fn();
    registerRemoteUnauthorizedHandler(h);
    registerRemoteUnauthorizedHandler(null);
    notifyRemoteUnauthorized("node-xyz");
    expect(h).not.toHaveBeenCalled();
  });
});
