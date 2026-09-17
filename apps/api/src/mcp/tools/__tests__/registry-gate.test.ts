// M6/S3 闸门一（注册期）单测：PAT scope 粗筛 + 族可见集非空 + 引擎故障不冒泡。
// 用最小 server 替身收集「实际注册了哪些工具」（测试替身仅限 __tests__；生产接真 M4）。

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
  it("scope 粗筛：无 record:read -> table.list_bases 不注册（只剩连接性 ping_echo）", async () => {
    const { server, names } = collector();
    await registerTools(server, SUBJ(["doc:read"]), { port: fakePort({ table: { byKind: { base: ["b1"] }, truncated: false } }) });
    expect(names()).toEqual(["ping_echo"]);
  });

  it("族可见集为空 -> 该族工具不注册", async () => {
    const { server, names } = collector();
    await registerTools(server, SUBJ(["record:read"]), { port: fakePort({}) });
    expect(names()).toEqual(["ping_echo"]);
  });

  it("scope 通过且族非空 -> 注册该族全部可用工具（含 S4 读工具）", async () => {
    const { server, names } = collector();
    await registerTools(server, SUBJ(["record:read"]), { port: fakePort({ table: { byKind: { base: ["b1"] }, truncated: false } }) });
    // M5 off（测试环境默认）-> record.search 不注册（运行期可用性门）
    expect(names()).toEqual(["ping_echo", "record.list_records", "record.query_records", "table.get_schema", "table.list_bases"]);
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
