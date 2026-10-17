// shellProbe.ts 单测（纯 node）：成品壳「添加/连接远端」的 probe 短期显式目标转发装配。
// 锁：begin_probe→同源 /__gx/probe/<id> 执行业务→finally end_probe 的顺序与清理纪律；
// 握手/登录命中 probe 相对路径；非法基址/怪 probeId fail-closed；缺凭据中文错。
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  withProbeSession,
  probePerformHandshake,
  probeLoginRemote,
} from "./shellProbe";
import {
  __setShellBridgeForTest,
  __resetShellBridgeForTest,
  CMD,
} from "./shellBridge";
import { PROBE_PATH_PREFIX } from "./shellRouting";
import { HandshakeError } from "./handshake";
import type { StoredNodeEntry } from "./registry";

function remoteEntry(baseURL: string): StoredNodeEntry {
  return { kind: "remote", nodeId: "n1", baseURL, label: null, lastConnectedAt: null };
}

describe("withProbeSession", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let calls: { cmd: string; args?: Record<string, unknown> }[];

  beforeEach(() => {
    calls = [];
    invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === CMD.beginProbe) return { probeId: "pr0be1" };
      if (cmd === CMD.endProbe) return { ok: true };
      return { ok: true };
    });
    __setShellBridgeForTest({ invoke, shellPresent: true });
  });
  afterEach(() => __resetShellBridgeForTest());

  it("成功路径：规范化基址→begin_probe→以同源 probe 基址执行→finally end_probe", async () => {
    const run = vi.fn(async (probeBase: string) => `ran:${probeBase}`);
    const out = await withProbeSession("http://nas:3001/", run);

    expect(out).toBe(`ran:${PROBE_PATH_PREFIX}/pr0be1`);
    // begin_probe 收到去尾斜杠的规范化绝对基址（target 给壳转发用）。
    expect(invoke).toHaveBeenNthCalledWith(1, CMD.beginProbe, {
      baseURL: "http://nas:3001",
    });
    // run 收到的是同源相对 probe 基址（绝不包含真实远端 origin）。
    expect(run).toHaveBeenCalledWith(`${PROBE_PATH_PREFIX}/pr0be1`);
    // 结束立即注销同一 probeId。
    expect(invoke).toHaveBeenLastCalledWith(CMD.endProbe, { probeId: "pr0be1" });
    expect(calls.map((c) => c.cmd)).toEqual([CMD.beginProbe, CMD.endProbe]);
  });

  it("业务函数抛错时仍 end_probe（清理不跳），错误原样透传", async () => {
    const boom = new HandshakeError("unreachable");
    await expect(
      withProbeSession("http://nas:3001", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(invoke).toHaveBeenCalledWith(CMD.endProbe, { probeId: "pr0be1" });
  });

  it("end_probe 失败被吞掉，不掩盖业务成功结果", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === CMD.beginProbe) return { probeId: "pr0be1" };
      if (cmd === CMD.endProbe) throw new Error("rust gone");
      return null;
    });
    const out = await withProbeSession("http://nas:3001", async (b) => b);
    expect(out).toBe(`${PROBE_PATH_PREFIX}/pr0be1`);
  });

  it("Rust 返回含路径穿越字符的 probeId：fail-closed 抛中文错且不把怪 id 交给业务，仍尝试注销", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === CMD.beginProbe) return { probeId: "../evil" };
      if (cmd === CMD.endProbe) return { ok: true };
      return null;
    });
    const run = vi.fn();
    await expect(withProbeSession("http://nas:3001", run)).rejects.toThrow(
      "无效的节点探测会话标识",
    );
    expect(run).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(CMD.endProbe, { probeId: "../evil" });
  });

  it("非法 baseURL（空白/无 host）：不调用任何壳命令，抛确定中文错", async () => {
    const run = vi.fn();
    await expect(withProbeSession("   ", run)).rejects.toThrow("节点网址不正确");
    expect(invoke).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("probePerformHandshake（添加节点三探针经 probe）", () => {
  afterEach(() => {
    __resetShellBridgeForTest();
    vi.unstubAllGlobals();
  });

  it("health/bootstrap/meta 全部命中同源 probe 路径，begin/end 配对，返回节点画像", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === CMD.beginProbe) return { probeId: "abc123" };
      return { ok: true };
    });
    __setShellBridgeForTest({ invoke, shellPresent: true });

    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ version: "0.2.5" }), { status: 200 });
      }
      if (url.endsWith("/api/auth/bootstrap-status")) {
        return new Response(JSON.stringify({ initialized: true, signupOpen: false }), {
          status: 200,
        });
      }
      return new Response("nope", { status: 404 }); // /api/v1/meta 匿名 404 按能力未知放行
    });
    vi.stubGlobal("fetch", fetchImpl);

    const hs = await probePerformHandshake("0.2.0")("http://nas:3001");
    expect(hs.version).toBe("0.2.5");
    expect(hs.initialized).toBe(true);
    // 每一探都是壳口同源 probe 相对路径，无任何绝对远端地址。
    expect(seen.every((u) => u.startsWith(`${PROBE_PATH_PREFIX}/abc123/`))).toBe(true);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([CMD.beginProbe, CMD.endProbe]);
  });

  it("远端未初始化：握手抛 not_initialized，probe 仍注销", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === CMD.beginProbe) return { probeId: "p2" };
      return { ok: true };
    });
    __setShellBridgeForTest({ invoke, shellPresent: true });
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ version: "0.2.5" }), { status: 200 });
      }
      return new Response(JSON.stringify({ initialized: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(probePerformHandshake()("http://nas:3001")).rejects.toBeInstanceOf(
      HandshakeError,
    );
    expect(invoke).toHaveBeenLastCalledWith(CMD.endProbe, { probeId: "p2" });
  });
});

describe("probeLoginRemote（连接/重连登录换 JWT 经 probe）", () => {
  afterEach(() => {
    __resetShellBridgeForTest();
    vi.unstubAllGlobals();
  });

  it("缺凭据：抛与浏览器版同一中文错，且不开 probe", async () => {
    const invoke = vi.fn(async () => ({ probeId: "x" }));
    __setShellBridgeForTest({ invoke, shellPresent: true });
    await expect(probeLoginRemote(remoteEntry("http://nas:3001"), undefined)).rejects.toThrow(
      "连接该远端节点需要账号密码",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("有凭据：POST 同源 probe 登录路径，返回远端 JWT；begin/end 配对", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === CMD.beginProbe) return { probeId: "login1" };
      return { ok: true };
    });
    __setShellBridgeForTest({ invoke, shellPresent: true });

    let postedTo = "";
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      postedTo = String(input);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ token: "remote-jwt", user: { id: 7 } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const r = await probeLoginRemote(remoteEntry("http://nas:3001"), {
      email: "a@b.c",
      password: "pw",
    });
    expect(r.token).toBe("remote-jwt");
    expect(postedTo).toBe(`${PROBE_PATH_PREFIX}/login1/api/auth/login`);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([CMD.beginProbe, CMD.endProbe]);
  });
});
