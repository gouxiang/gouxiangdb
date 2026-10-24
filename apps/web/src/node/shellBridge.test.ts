// shellBridge.ts 测试（纯 node、无 jsdom、无新依赖）。
// 经 __setShellBridgeForTest 假通道锁定 §3 冻结命令名/入参键，并覆盖离线副本三条命令
// （#828）：gx:start_replica / gx:stop_replica / gx:replica_status。
// 非壳环境无 window.__TAURI_INTERNALS__（node harness），invokeGx fail-closed reject 中文错误。

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CMD,
  startReplica,
  stopReplica,
  replicaStatus,
  startLocal,
  localStatus,
  __setShellBridgeForTest,
  __resetShellBridgeForTest,
} from "./shellBridge";

afterEach(() => {
  __resetShellBridgeForTest();
  vi.restoreAllMocks();
});

describe("CMD 冻结命令名（10 条）", () => {
  it("三条副本命令名与 Rust #[command(rename)] 逐字节一致", () => {
    expect(CMD.startReplica).toBe("gx:start_replica");
    expect(CMD.stopReplica).toBe("gx:stop_replica");
    expect(CMD.replicaStatus).toBe("gx:replica_status");
  });
});

describe("startReplica", () => {
  it("透传成功体 {ok,kernelPort,initialized,nodeId}，命令名/入参键为 lowerCamelCase", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      kernelPort: 3901,
      initialized: false,
      nodeId: "office-1",
    });
    __setShellBridgeForTest({ invoke });

    const res = await startReplica({
      remoteBaseUrl: "http://192.168.1.5:3001",
      nodeId: "office-1",
      remoteToken: "tok-123",
      clientId: "cid-7",
      syncIntervalMs: 5000,
    });

    expect(invoke).toHaveBeenCalledWith("gx:start_replica", {
      remoteBaseUrl: "http://192.168.1.5:3001",
      nodeId: "office-1",
      remoteToken: "tok-123",
      clientId: "cid-7",
      syncIntervalMs: 5000,
    });
    expect(res).toEqual({ ok: true, kernelPort: 3901, initialized: false, nodeId: "office-1" });
  });

  it("业务失败 {ok:false,error} 原样返回、不吞不抛（与 startLocal 同口径）", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "本地主库内核正在运行，请先停止主库再启动离线副本" });
    __setShellBridgeForTest({ invoke });

    const res = await startReplica({ remoteBaseUrl: "http://a:3001", nodeId: "office-1" });
    expect(res).toEqual({ ok: false, error: "本地主库内核正在运行，请先停止主库再启动离线副本" });
    if (res.ok === false) {
      expect(res.error).toContain("主库");
    } else {
      throw new Error("应当收敛为 ok:false");
    }
  });

  it("可空键缺省时不下发（只传必填两键），不凭空造字段", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, kernelPort: 1, initialized: true, nodeId: "n" });
    __setShellBridgeForTest({ invoke });

    await startReplica({ remoteBaseUrl: "http://a", nodeId: "n" });
    expect(invoke).toHaveBeenCalledWith("gx:start_replica", {
      remoteBaseUrl: "http://a",
      nodeId: "n",
    });
  });

  it("显式传 null 的 clientId/syncIntervalMs 照常下发 null，remoteToken 为 undefined 不下发", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, kernelPort: 1, initialized: true, nodeId: "n" });
    __setShellBridgeForTest({ invoke });

    await startReplica({
      remoteBaseUrl: "http://a",
      nodeId: "n",
      clientId: null,
      syncIntervalMs: null,
    });
    expect(invoke).toHaveBeenCalledWith("gx:start_replica", {
      remoteBaseUrl: "http://a",
      nodeId: "n",
      clientId: null,
      syncIntervalMs: null,
    });
  });
});

describe("stopReplica / replicaStatus", () => {
  it("stopReplica 无入参调用 gx:stop_replica", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, wasRunning: true });
    __setShellBridgeForTest({ invoke });
    const res = await stopReplica();
    expect(invoke).toHaveBeenCalledWith("gx:stop_replica", undefined);
    // 类型只暴露 OkResult（与任务书一致）；Rust 运行时额外带 wasRunning，这里宽松断言兼容真实 DTO。
    expect(res).toMatchObject({ ok: true });
  });

  it("replicaStatus 以 {nodeId} 调 gx:replica_status，复用 LocalStatus DTO", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ added: true, initialized: true, running: true, ready: true, kernelPort: 3901 });
    __setShellBridgeForTest({ invoke });
    const res = await replicaStatus("office-1");
    expect(invoke).toHaveBeenCalledWith("gx:replica_status", { nodeId: "office-1" });
    expect(res).toEqual({ added: true, initialized: true, running: true, ready: true, kernelPort: 3901 });
  });
});

describe("非壳环境 fail-closed", () => {
  it("node harness（无 __TAURI_INTERNALS__）下副本/本地命令均 reject「不在桌面壳环境」", async () => {
    // 显式复位，确保走真实 window 检测（node 下 window 未定义）。
    __resetShellBridgeForTest();
    await expect(startReplica({ remoteBaseUrl: "http://a", nodeId: "n" })).rejects.toThrow(
      "不在桌面壳环境",
    );
    await expect(stopReplica()).rejects.toThrow("不在桌面壳环境");
    await expect(replicaStatus("n")).rejects.toThrow("不在桌面壳环境");
    // 既有命令同口径回归
    await expect(startLocal()).rejects.toThrow("不在桌面壳环境");
    await expect(localStatus()).rejects.toThrow("不在桌面壳环境");
  });
});
