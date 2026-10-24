// shellRouting.ts 纯函数单测（node 环境，无 jsdom/无新依赖）。
//
// 锁定 W1 验收（IMPL-0.2.5-beta.md §4 W1）：
//   1. 壳同源化：local/remote 的 ActiveDataSource.baseURL 恒为 ""，wsOrigin 回落页面 origin（=壳口）；
//   2. nodeId / kind / token 三身份字段逐字节保留；
//   3. probe 路径 /__gx/probe/<id>/<apiPath> 拼接正确，probeId/baseURL 非法 fail-closed 抛中文错；
//   4. 非壳回落 browserActiveDataSource 与现状 deriveActiveDataSource 逐字节等价（非壳零变化的锁）；
//   5. 经 shellBridge 测试 seam 的 hasShell() true/false 两分支（装配层据此二选一）。

import { describe, it, expect, afterEach } from "vitest";
import {
  deriveShellActiveDataSource,
  browserActiveDataSource,
  normalizeProbeBaseURL,
  makeProbeBase,
  makeProbePath,
  PROBE_PATH_PREFIX,
} from "./shellRouting";
import { deriveActiveDataSource } from "./launcher";
import {
  hasShell,
  invokeGx,
  getShellInfo,
  localStatus,
  startLocal,
  stopLocal,
  setActiveUpstream,
  beginProbe,
  endProbe,
  CMD,
  __setShellBridgeForTest,
  __resetShellBridgeForTest,
} from "./shellBridge";
import { LOCAL_NODE_ID } from "./resolve";
import type { StoredNodeEntry } from "./registry";

const PAGE_ORIGIN_HTTP = "http://127.0.0.1:5809";
const PAGE_ORIGIN_HTTPS = "https://shell.example";

const localEntry: StoredNodeEntry = {
  kind: "local",
  nodeId: LOCAL_NODE_ID,
  baseURL: "",
  label: "本机",
  lastConnectedAt: null,
};
const remoteEntry = (baseURL = "http://nas:3001"): StoredNodeEntry => ({
  kind: "remote",
  nodeId: "aaaa1111bbbb",
  baseURL,
  label: "公司库",
  lastConnectedAt: null,
});
// 离线副本：kind 仍 local、baseURL 空，但 nodeId 是副本名 + role:replica。
const replicaEntry = (nodeId = "office-1"): StoredNodeEntry => ({
  kind: "local",
  role: "replica",
  nodeId,
  baseURL: "",
  label: "办公室副本",
  lastConnectedAt: null,
  replica: { remoteBaseUrl: "http://nas:3001", clientId: null, syncIntervalMs: null },
});

afterEach(() => {
  __resetShellBridgeForTest();
});

describe("壳模式同源化数据源 deriveShellActiveDataSource", () => {
  it("local：baseURL 恒为 ''，wsOrigin 回落页面 origin（http→ws），身份保留", () => {
    const ds = deriveShellActiveDataSource(localEntry, "local-jwt", () => PAGE_ORIGIN_HTTP);
    expect(ds).toEqual({
      nodeId: LOCAL_NODE_ID,
      kind: "local",
      baseURL: "",
      token: "local-jwt",
      wsOrigin: "ws://127.0.0.1:5809",
    });
  });

  it("remote：baseURL 也恒为 ''（真实绝对 URL 不进数据源），wsOrigin 回落壳口（https→wss）", () => {
    const ds = deriveShellActiveDataSource(
      remoteEntry("https://nas.example/gx"),
      "remote-jwt",
      () => PAGE_ORIGIN_HTTPS,
    );
    expect(ds).toEqual({
      nodeId: "aaaa1111bbbb",
      kind: "remote",
      baseURL: "",
      token: "remote-jwt",
      wsOrigin: "wss://shell.example",
    });
  });

  it("local 未登录 token=null 原样保留（首 boot 初始化页仍需数据源指向壳代理）", () => {
    const ds = deriveShellActiveDataSource(localEntry, null, () => PAGE_ORIGIN_HTTP);
    expect(ds?.token).toBeNull();
    expect(ds?.baseURL).toBe("");
  });

  it("replica：baseURL=''、wsOrigin=壳口，但 nodeId 保留副本名（不坍成 local），kind 仍 local", () => {
    const ds = deriveShellActiveDataSource(replicaEntry("office-1"), "rep-jwt", () => PAGE_ORIGIN_HTTP);
    expect(ds).toEqual({
      nodeId: "office-1",
      kind: "local",
      baseURL: "",
      token: "rep-jwt",
      wsOrigin: "ws://127.0.0.1:5809",
    });
  });

  it("replica 未登录 token=null 也保留副本 nodeId（空令牌侧车登录引导）", () => {
    const ds = deriveShellActiveDataSource(replicaEntry("office-2"), null, () => PAGE_ORIGIN_HTTP);
    expect(ds?.nodeId).toBe("office-2");
    expect(ds?.kind).toBe("local");
    expect(ds?.token).toBeNull();
    expect(ds?.baseURL).toBe("");
  });

  it("无活动节点 → null（与现状推导点一致，resolver 惰性回 buildLocal 兜底）", () => {
    expect(deriveShellActiveDataSource(null, null, () => PAGE_ORIGIN_HTTP)).toBeNull();
  });

  it("local 与 remote 的 baseURL 必须相同（都是壳口同源 ''），不能一个相对一个绝对", () => {
    const local = deriveShellActiveDataSource(localEntry, "t", () => PAGE_ORIGIN_HTTP);
    const remote = deriveShellActiveDataSource(remoteEntry(), "rt", () => PAGE_ORIGIN_HTTP);
    expect(local?.baseURL).toBe("");
    expect(remote?.baseURL).toBe("");
    expect(remote?.baseURL).toBe(local?.baseURL);
  });

  it("resolver.wsHostOrigin 对同源 baseURL='' 的口径与本构建器 wsOrigin 一致（纯壳口 host）", () => {
    // dataSourceResolver.wsHostOrigin() 内部走 wsHostOriginFor("", origin)，结果必须等于这里给的值，
    // 这样 collab（读 resolver.wsHostOrigin）与活动数据源（读 current().wsOrigin）不会分叉。
    const ds = deriveShellActiveDataSource(remoteEntry(), "rt", () => PAGE_ORIGIN_HTTP);
    expect(ds?.wsOrigin).toBe("ws://127.0.0.1:5809");
  });
});

describe("壳同源化 vs 非壳回落：差异只能在地址面", () => {
  it("browserActiveDataSource 与现状 deriveActiveDataSource 逐字节等价（非壳零变化锁）", () => {
    const getLocalBase = () => "/app/gouxiangdb";
    const getOrigin = () => "https://nas.local";
    for (const [entry, token] of [
      [localEntry, "lj"],
      [remoteEntry("https://r.example/gx"), "rj"],
    ] as [StoredNodeEntry, string | null][]) {
      expect(browserActiveDataSource(entry, token, getLocalBase, getOrigin)).toEqual(
        deriveActiveDataSource(entry, token, getLocalBase, getOrigin),
      );
    }
    expect(browserActiveDataSource(null, null, getLocalBase, getOrigin)).toBeNull();
  });

  it("子路径部署：非壳保留 basePath 前缀，壳内一律坍缩为壳口 ''（身份全等、仅地址不同）", () => {
    const entry = remoteEntry("http://nas:3001");
    const browser = browserActiveDataSource(
      entry,
      "rt",
      () => "/app/gouxiangdb",
      () => "https://nas.local",
    );
    const shell = deriveShellActiveDataSource(entry, "rt", () => "http://127.0.0.1:5809");
    // 身份字段全等
    expect(shell && { nodeId: shell.nodeId, kind: shell.kind, token: shell.token }).toEqual({
      nodeId: browser!.nodeId,
      kind: browser!.kind,
      token: browser!.token,
    });
    // 地址面不同：浏览器直连远端绝对 URL；壳内同源相对
    expect(browser?.baseURL).toBe("http://nas:3001");
    expect(browser?.wsOrigin).toBe("ws://nas:3001");
    expect(shell?.baseURL).toBe("");
    expect(shell?.wsOrigin).toBe("ws://127.0.0.1:5809");
  });
});

describe("probe 路径与基址", () => {
  it("makeProbeBase：/__gx/probe/<probeId>（无尾斜杠）", () => {
    expect(makeProbeBase("p1-9f")).toBe(`${PROBE_PATH_PREFIX}/p1-9f`);
  });

  it("makeProbePath：剥前导斜杠、单斜杠拼接，支持多层 apiPath", () => {
    expect(makeProbePath("abc123", "/api/health")).toBe("/__gx/probe/abc123/api/health");
    expect(makeProbePath("abc123", "api/auth/login")).toBe("/__gx/probe/abc123/api/auth/login");
    expect(makeProbePath("id-1_x", "/api/v1/meta")).toBe("/__gx/probe/id-1_x/api/v1/meta");
  });

  it.each(["", "../x", "a/b", "a\\b", "a.b", "a?b", "a#b", " a", "é"])(
    "非法 probeId %p → 抛中文错误（防路径穿越/分段注入）",
    (bad) => {
      expect(() => makeProbePath(bad, "/api/health")).toThrow(/探测会话|节点/);
      expect(() => makeProbeBase(bad)).toThrow();
    },
  );
});

describe("normalizeProbeBaseURL", () => {
  it("去尾斜杠、保留 basePath、补协议、host 小写", () => {
    expect(normalizeProbeBaseURL("http://nas:3001/")).toBe("http://nas:3001");
    expect(normalizeProbeBaseURL("https://NAS.Example/GX/")).toBe("https://nas.example/GX");
    expect(normalizeProbeBaseURL("nas:3001")).toBe("http://nas:3001");
  });

  it.each(["", "   ", "http://", "ht tp://x:1", "ftp://nas:3001", "!!!"])(
    "非法基址 %p → 抛中文错误（begin_probe 入参 fail-closed）",
    (bad) => {
      expect(() => normalizeProbeBaseURL(bad)).toThrow(/http/);
    },
  );
});

describe("shellBridge：hasShell / invokeGx / 七条命令（经测试 seam）", () => {
  it("vitest(node) 无 window.__TAURI_INTERNALS__ → hasShell()=false，invokeGx reject 中文错", async () => {
    expect(hasShell()).toBe(false);
    await expect(invokeGx("gx:get_shell_info")).rejects.toThrow("不在桌面壳环境");
  });

  it("seam 注入 shellPresent=false 时 hasShell()=false；注入 invoke+present=true 时命令达通道", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    __setShellBridgeForTest({
      shellPresent: false,
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return {};
      },
    });
    expect(hasShell()).toBe(false);
    __resetShellBridgeForTest();

    __setShellBridgeForTest({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { shellVersion: "0.2.5" };
      },
    });
    expect(hasShell()).toBe(true);
    const info = await getShellInfo();
    expect(info.shellVersion).toBe("0.2.5");
    expect(calls.at(-1)).toEqual({ cmd: CMD.getShellInfo, args: undefined });
  });

  it("七条包装的命令名与入参严格对齐 §3 契约表", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    __setShellBridgeForTest({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return null;
      },
    });

    await getShellInfo();
    expect(calls.at(-1)?.cmd).toBe("gx:get_shell_info");
    expect(calls.at(-1)?.args).toBeUndefined();

    await localStatus();
    expect(calls.at(-1)).toEqual({
      cmd: "gx:local_status",
      args: undefined,
    });

    await startLocal();
    expect(calls.at(-1)).toEqual({ cmd: "gx:start_local", args: undefined });

    await stopLocal();
    expect(calls.at(-1)).toEqual({ cmd: "gx:stop_local", args: undefined });

    await setActiveUpstream({ kind: "remote", target: "http://nas:3001" });
    expect(calls.at(-1)).toEqual({
      cmd: "gx:set_active_upstream",
      args: { kind: "remote", target: "http://nas:3001" },
    });
    await setActiveUpstream({ kind: "local" });
    expect(calls.at(-1)?.args).toEqual({ kind: "local" });
    await setActiveUpstream({ kind: "none" });
    expect(calls.at(-1)?.args).toEqual({ kind: "none" });

    await beginProbe("http://nas:3001");
    expect(calls.at(-1)).toEqual({
      cmd: "gx:begin_probe",
      args: { baseURL: "http://nas:3001" },
    });

    await endProbe("probe-1");
    expect(calls.at(-1)).toEqual({
      cmd: "gx:end_probe",
      args: { probeId: "probe-1" },
    });
  });

  it("startLocal 不吞 {ok:false,error}：原样把联合结果返回给编排层收口", async () => {
    __setShellBridgeForTest({
      invoke: async () => ({ ok: false, error: "内核端口被占用" }),
    });
    const r = await startLocal();
    expect(r).toEqual({ ok: false, error: "内核端口被占用" });
  });

  it("beginProbe 返回 probeId 透传", async () => {
    __setShellBridgeForTest({
      invoke: async () => ({ probeId: "pid-42" }),
    });
    await expect(beginProbe("http://x:1")).resolves.toEqual({ probeId: "pid-42" });
  });
});
