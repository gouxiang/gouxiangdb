// 定时离线副本同步引擎配置解析纯函数测试（无 db/Hono/定时器，表驱动）。
// 设计权威：DESIGN-OFFLINE-SYNC（beta.2 B2）——默认关 fail-closed：
//   引擎启动必须同时满足 GX_OFFLINE_REPLICA 精确开 与 GX_REPLICA_REMOTE_URL 非空。

import { describe, expect, it } from "vitest";
import {
  REPLICA_DEFAULT_INTERVAL_MS,
  REPLICA_MIN_INTERVAL_MS,
  parseReplicaRemoteUrl,
  parseReplicaRemoteToken,
  parseReplicaIntervalMs,
  replicaSyncConfig,
} from "../configReplica.js";

describe("parseReplicaRemoteUrl", () => {
  it("undefined/空串/纯空白 -> null（引擎不启动）", () => {
    expect(parseReplicaRemoteUrl(undefined)).toBeNull();
    expect(parseReplicaRemoteUrl("")).toBeNull();
    expect(parseReplicaRemoteUrl("   ")).toBeNull();
  });
  it("trim 后返回，保留 http(s) 原样（不在 parser 臆测前缀）", () => {
    expect(parseReplicaRemoteUrl("  http://x/ ")).toBe("http://x/");
    expect(parseReplicaRemoteUrl("https://h:3001")).toBe("https://h:3001");
  });
});

describe("parseReplicaRemoteToken", () => {
  it("undefined -> 空串；其余 trim", () => {
    expect(parseReplicaRemoteToken(undefined)).toBe("");
    expect(parseReplicaRemoteToken("  t  ")).toBe("t");
  });
});

describe("parseReplicaIntervalMs", () => {
  it("缺省/空 -> 30000", () => {
    expect(parseReplicaIntervalMs(undefined)).toBe(REPLICA_DEFAULT_INTERVAL_MS);
    expect(parseReplicaIntervalMs("")).toBe(REPLICA_DEFAULT_INTERVAL_MS);
    expect(parseReplicaIntervalMs("   ")).toBe(REPLICA_DEFAULT_INTERVAL_MS);
  });
  it("合法正整数照用", () => {
    expect(parseReplicaIntervalMs("15000")).toBe(15000);
  });
  it("小于 5000 夹到下限", () => {
    expect(parseReplicaIntervalMs("1")).toBe(REPLICA_MIN_INTERVAL_MS);
    expect(parseReplicaIntervalMs("4999")).toBe(REPLICA_MIN_INTERVAL_MS);
  });
  it("非法值（小数/科学计数/杂字符/0/负）-> 缺省 30000", () => {
    for (const v of ["1.5", "1e3", "abc", "10s", "0", "-5", "NaN", "Infinity"]) {
      expect(parseReplicaIntervalMs(v)).toBe(REPLICA_DEFAULT_INTERVAL_MS);
    }
  });
});

describe("replicaSyncConfig（启动判定唯一真源）", () => {
  it("默认（flag 未开 + 无 URL）-> null", () => {
    expect(replicaSyncConfig({})).toBeNull();
  });
  it("flag 开但无 URL -> null（fail-closed）", () => {
    expect(replicaSyncConfig({ GX_OFFLINE_REPLICA: "on" })).toBeNull();
    expect(replicaSyncConfig({ GX_OFFLINE_REPLICA: "on", GX_REPLICA_REMOTE_URL: "  " })).toBeNull();
  });
  it("有 URL 但 flag 未开 -> null（once 内核守门同源）", () => {
    expect(replicaSyncConfig({ GX_REPLICA_REMOTE_URL: "http://x" })).toBeNull();
  });
  it("flag 非精确开（ON/yes/0）即便有 URL -> null", () => {
    for (const f of ["ON", "yes", "0", "off", "true "]) {
      expect(replicaSyncConfig({ GX_OFFLINE_REPLICA: f, GX_REPLICA_REMOTE_URL: "http://x" })).toBeNull();
    }
  });
  it("flag 精确 on/true/1 + 非空 URL -> 规整配置（token/interval 缺省）", () => {
    for (const f of ["on", "true", "1"]) {
      const cfg = replicaSyncConfig({ GX_OFFLINE_REPLICA: f, GX_REPLICA_REMOTE_URL: " http://h:1 " });
      expect(cfg).not.toBeNull();
      expect(cfg!.remoteUrl).toBe("http://h:1");
      expect(cfg!.remoteToken).toBe("");
      expect(cfg!.intervalMs).toBe(REPLICA_DEFAULT_INTERVAL_MS);
    }
  });
  it("token trim + interval 透传", () => {
    const cfg = replicaSyncConfig({
      GX_OFFLINE_REPLICA: "on",
      GX_REPLICA_REMOTE_URL: "http://h",
      GX_REPLICA_REMOTE_TOKEN: " tok ",
      GX_OFFLINE_SYNC_INTERVAL_MS: "7000",
    });
    expect(cfg!.remoteToken).toBe("tok");
    expect(cfg!.intervalMs).toBe(7000);
  });
  it("requireReplicaFlag=false 时仅以 URL 判定（测试/特例通道）", () => {
    expect(replicaSyncConfig({ GX_REPLICA_REMOTE_URL: "http://h" }, false)).not.toBeNull();
    expect(replicaSyncConfig({}, false)).toBeNull();
  });
});
