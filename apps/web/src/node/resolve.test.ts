// resolve.ts 纯函数测试（纯 node、无 jsdom、无新依赖）。
// 锁定 DESIGN §7.1：协议补全 / trim / 去尾斜杠 / 子路径保留 / 非法 host 拒绝 /
// 大小写与尾斜杠等价 / matchSameNode / toWsOrigin / 可注入哈希的确定性 nodeId。

import { describe, it, expect } from "vitest";
import {
  LOCAL_NODE_ID,
  normalizeNodeUrl,
  nodeIdFromBaseURL,
  nodeIdFromBaseURLWith,
  subtleSha256,
  matchSameNode,
  toWsOrigin,
  localWsOrigin,
  wsHostOriginFor,
  type StringHasher,
} from "./resolve";

describe("LOCAL_NODE_ID 常量", () => {
  it('恒为 "local"（本地 nodeId 前缀的单一真源）', () => {
    expect(LOCAL_NODE_ID).toBe("local");
  });
});

describe("normalizeNodeUrl 协议补全", () => {
  it("裸 host:port 默认补 http://", () => {
    expect(normalizeNodeUrl("192.168.1.5:3001")).toEqual({
      origin: "http://192.168.1.5:3001",
      basePath: "",
      baseURL: "http://192.168.1.5:3001",
    });
  });

  it("裸域名补 http://", () => {
    const r = normalizeNodeUrl("node.example.com");
    expect(r?.origin).toBe("http://node.example.com");
    expect(r?.basePath).toBe("");
    expect(r?.baseURL).toBe("http://node.example.com");
  });

  it("显式 https 保留 https", () => {
    const r = normalizeNodeUrl("https://node.example.com:8443");
    expect(r?.origin).toBe("https://node.example.com:8443");
  });
});

describe("normalizeNodeUrl trim / 尾斜杠 / 子路径", () => {
  it("trim 两端空白", () => {
    expect(normalizeNodeUrl("  http://host:3001/  ")).toEqual(normalizeNodeUrl("http://host:3001"));
  });

  it("去掉单个尾斜杠", () => {
    const r = normalizeNodeUrl("http://host:3001/");
    expect(r?.baseURL).toBe("http://host:3001");
    expect(r?.basePath).toBe("");
  });

  it("去掉多个尾斜杠", () => {
    const r = normalizeNodeUrl("http://host:3001/a/b///");
    expect(r?.basePath).toBe("/a/b");
    expect(r?.baseURL).toBe("http://host:3001/a/b");
  });

  it("保留子路径 basePath（DESIGN：网关前缀原样保留）", () => {
    const r = normalizeNodeUrl("https://host/app/gouxiangdb/");
    expect(r).toEqual({
      origin: "https://host",
      basePath: "/app/gouxiangdb",
      baseURL: "https://host/app/gouxiangdb",
    });
  });

  it("子路径保留原大小写（路径可能大小写敏感）", () => {
    const r = normalizeNodeUrl("http://host/App/GouXiangDB");
    expect(r?.basePath).toBe("/App/GouXiangDB");
  });
});

describe("normalizeNodeUrl host 归一", () => {
  it("host 小写（权威部分大小写不敏感），路径不受影响", () => {
    const r = normalizeNodeUrl("http://NODE.Example.COM:3001/x");
    expect(r?.origin).toBe("http://node.example.com:3001");
    expect(r?.basePath).toBe("/x");
  });
});

describe("normalizeNodeUrl 非法输入 fail-closed → null", () => {
  it.each([
    ["空串", ""],
    ["纯空白", "   "],
    ["含空格的 host", "http://host :3001"],
    ["中间带空格", "host 3001"],
    ["无有效 host（协议后为空）", "http://"],
    ["纯标点 host", "http://.../"],
    ["非 http(s) 协议", "file:///etc/passwd"],
    ["javascript 协议", "javascript:alert(1)"],
    ["非字符串 null", null as unknown as string],
  ])("%s → null", (_label, input) => {
    expect(normalizeNodeUrl(input)).toBeNull();
  });
});

describe("matchSameNode 规范化后等价", () => {
  it("大小写 + 尾斜杠 + 协议缺省 视为同一节点", () => {
    expect(matchSameNode("http://HOST:3001/", "host:3001")).toBe(true);
  });

  it("相同 origin+basePath 的不同写法等价", () => {
    expect(matchSameNode("https://host/app/gouxiangdb/", "HTTPS://host/app/gouxiangdb")).toBe(
      true,
    );
  });

  it("子路径不同 → 不是同一节点", () => {
    expect(matchSameNode("http://host/a", "http://host/b")).toBe(false);
  });

  it("端口不同 → 不是同一节点", () => {
    expect(matchSameNode("http://host:3001", "http://host:3002")).toBe(false);
  });

  it("任一输入非法 → false", () => {
    expect(matchSameNode("", "http://host")).toBe(false);
    expect(matchSameNode("http://host", "   ")).toBe(false);
  });
});

describe("toWsOrigin 协议换算（与 collab toWsOrigin 同口径）", () => {
  it("http → ws，host/端口原样", () => {
    expect(toWsOrigin("http://host:3001")).toBe("ws://host:3001");
  });

  it("https → wss", () => {
    expect(toWsOrigin("https://host")).toBe("wss://host");
  });

  it("子路径原样保留", () => {
    expect(toWsOrigin("https://host/app/gouxiangdb")).toBe("wss://host/app/gouxiangdb");
  });

  it("已是 ws/wss 或非标形态原样透传", () => {
    expect(toWsOrigin("ws://host:3001")).toBe("ws://host:3001");
    expect(toWsOrigin("/app/gouxiangdb")).toBe("/app/gouxiangdb");
  });
});

describe("localWsOrigin 本地同源槽换算", () => {
  it("根部署：toWsOrigin(origin) 拼空前缀", () => {
    expect(localWsOrigin("", "http://localhost:5173")).toBe("ws://localhost:5173");
  });

  it("子路径部署：ws origin + 网关前缀（与 collab defaultOrigin 口径对齐）", () => {
    expect(localWsOrigin("/app/gouxiangdb", "https://gateway.example")).toBe(
      "wss://gateway.example/app/gouxiangdb",
    );
  });
});

describe("nodeId 哈希（可注入，确定性 + 前 12 位）", () => {
  // 确定性假哈希：不依赖 webcrypto。用两个不同种子的 djb2 拼出 16 位 hex「摘要」，
  // 使前 12 位对整段输入敏感，从而验证「取摘要前 12 位」的纯截断逻辑。
  const djb2 = (s: string, seed: number): string => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const fakeHasher: StringHasher = async (input: string) =>
    `${djb2(input, 5381)}${djb2(input, 0x9e3779b9)}`;

  it("取摘要前 12 位且确定", async () => {
    const full = await fakeHasher("http://host:3001");
    const id = await nodeIdFromBaseURLWith("http://host:3001", fakeHasher);
    expect(id).toBe(full.slice(0, 12));
    expect(id).toHaveLength(12);
  });

  it("同一 baseURL 两次结果一致", async () => {
    const a = await nodeIdFromBaseURLWith("https://host/x", fakeHasher);
    const b = await nodeIdFromBaseURLWith("https://host/x", fakeHasher);
    expect(a).toBe(b);
  });

  it("不同 baseURL 派生出不同 id（假哈希对输入敏感）", async () => {
    const a = await nodeIdFromBaseURLWith("http://host:3001", fakeHasher);
    const b = await nodeIdFromBaseURLWith("http://host:3002", fakeHasher);
    expect(a).not.toBe(b);
  });

  it("生产默认哈希（SubtleCrypto SHA-256）可用且产 12 位 hex", async () => {
    const id = await nodeIdFromBaseURL("http://host:3001");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("subtleSha256 返回 64 位小写 hex 且确定", async () => {
    const h1 = await subtleSha256("abc");
    const h2 = await subtleSha256("abc");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    // sha256("abc") 已知向量
    expect(h1).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("wsHostOriginFor：协同 WS 纯 host origin（双前缀防护）", () => {
  const PAGE_HTTP = "http://localhost:5173";
  const PAGE_HTTPS = "https://nas.local";

  it("相对本地槽（根部署 base=''）→ 页面 origin 换 ws（golden：== toWsOrigin(pageOrigin)）", () => {
    expect(wsHostOriginFor("", PAGE_HTTP)).toBe("ws://localhost:5173");
  });

  it("相对本地槽（飞牛子路径 base='/app/gouxiangdb'）→ 仍只取页面 host，绝不拼 basePath", () => {
    // 双前缀陷阱：wsPath 已自带 /app/gouxiangdb，origin 端再拼就变成 .../app/gx/app/gx/ws
    expect(wsHostOriginFor("/app/gouxiangdb", PAGE_HTTPS)).toBe("wss://nas.local");
  });

  it("绝对远端 http baseURL（根部署）→ 反解其 host 换 ws，丢弃 pathname", () => {
    expect(wsHostOriginFor("http://192.168.1.5:3001", PAGE_HTTP)).toBe(
      "ws://192.168.1.5:3001",
    );
  });

  it("绝对远端 https + 子路径 baseURL → 只取 host（basePath 由票据 wsPath 承担）", () => {
    expect(wsHostOriginFor("https://nas.local/app/gouxiangdb", PAGE_HTTPS)).toBe(
      "wss://nas.local",
    );
  });

  it("畸形绝对 URL → fail-safe 回落页面 origin", () => {
    expect(wsHostOriginFor("http://", PAGE_HTTPS)).toBe("wss://nas.local");
  });
});
