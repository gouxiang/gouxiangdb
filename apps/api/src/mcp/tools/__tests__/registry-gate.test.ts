// M6/S3 闸门一（注册期）单测：族可见集非空 + 引擎故障不冒泡 + 令牌 scope 不再参与判定。
// 用最小 server 替身收集「实际注册了哪些工具」（测试替身仅限 __tests__；生产接真 M4）。
//
// P3 语义：**令牌只做认证 + 有效期**，能力按签发者用户实时计算——故本文件不再有"scope 粗筛"用例，
// 注册集的唯一判据是 port.listAccessibleResources（族可见集）与运行期可用性门。

import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessibleResources, McpPermissionPort, ResourceFamily } from "../../permissions/types.js";
import { registerTools } from "../registry.js";

function fakePort(byFamily: Partial<Record<ResourceFamily, AccessibleResources>> | "throw"): McpPermissionPort {
  if (byFamily === "throw") {
    return {
      listAccessibleResources: async () => { throw new Error("engine down"); },
      can: async () => false,
      fieldCapability: async () => ({ visible: false, visibleAll: false, visibleFields: null, writableAll: false }),
      fieldCapabilityOf: async () => ({ visible: false, visibleAll: false, visibleFields: null, writableAll: false }),
      writeFieldCapabilityOf: async () => ({ matched: false, writableAll: false, writableFields: [] }),
    };
  }
  return {
    listAccessibleResources: async (f) => byFamily[f] ?? { byKind: {}, truncated: false },
    can: async () => true,
    fieldCapability: async () => ({ visible: true, visibleAll: true, visibleFields: null, writableAll: false }),
    fieldCapabilityOf: async () => ({ visible: true, visibleAll: true, visibleFields: null, writableAll: false }),
    writeFieldCapabilityOf: async () => ({ matched: false, writableAll: false, writableFields: [] }),
  };
}

function collector(): { server: McpServer; names: () => string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => { names.push(name); return {} as never; },
  } as unknown as McpServer;
  return { server, names: () => names.slice().sort() };
}

const SUBJ = (scopes: string[]) => ({ userId: "u", patId: "p", scopes });

describe("S3 闸门一：注册决策", () => {
  // 语义适配（P3）：原用例断言"无 record:read -> 只剩 ping_echo"，判据是令牌 scope（已下线）。
  // 改为锁定新不变量：scope 不参与注册判定——doc:read 与 record:read 主体的注册集完全一致。
  it("令牌 scope 不参与注册判定：doc:read 与 record:read 主体注册集一致", async () => {
    const a = collector();
    await registerTools(a.server, SUBJ(["doc:read"]), { port: fakePort({ table: { byKind: { base: ["b1"] }, truncated: false } }) });
    const b = collector();
    await registerTools(b.server, SUBJ(["record:read"]), { port: fakePort({ table: { byKind: { base: ["b1"] }, truncated: false } }) });
    expect(a.names()).toEqual(b.names());
    expect(a.names().length).toBeGreaterThan(1); // 族非空 -> 确有工具入册（不是全挡死的假绿）
  });

  it("族可见集为空 -> 该族工具不注册", async () => {
    const { server, names } = collector();
    await registerTools(server, SUBJ(["record:read"]), { port: fakePort({}) });
    expect(names()).toEqual(["ping_echo"]);
  });

  it("族非空 -> 注册该族全部可用工具（写工具同入册：能力按签发者，替身端口对任意动作均可见）", async () => {
    const { server, names } = collector();
    await registerTools(server, SUBJ(["record:read"]), { port: fakePort({ table: { byKind: { base: ["b1"] }, truncated: false } }) });
    // M5 off（测试环境默认）-> record.search 不注册（运行期可用性门）
    expect(names()).toEqual([
      "ping_echo", "record.create_record", "record.delete_record", "record.list_records",
      "record.query_records", "record.update_record", "table.get_schema", "table.list_bases",
    ]);
  });

  it("引擎抛错：不冒泡（不 500）+ 该族工具缺席 + 记 metric", async () => {
    const { server, names } = collector();
    const onMetric = vi.fn();
    await expect(registerTools(server, SUBJ(["record:read"]), { port: fakePort("throw"), onMetric })).resolves.toBeUndefined();
    expect(names()).toEqual(["ping_echo"]); // 连接性工具不受引擎故障影响
    expect(onMetric).toHaveBeenCalledWith(expect.objectContaining({ event: "mcp.gate1.engine_error", family: "table" }));
  });

  it("未接入端口（port=null）：只注册连接性工具，不抛", async () => {
    const { server, names } = collector();
    await registerTools(server, SUBJ(["record:read"]), {});
    expect(names()).toEqual(["ping_echo"]);
  });
});
