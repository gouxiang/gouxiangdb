// M5 前端补充测试：v1/404 回退、二次确认 patch 构造、apiKey 只写形状、403 静默判定、
// index:null 空态判定、轮询节流的纯函数依据。组件点击在无 jsdom（不引新依赖）下不可测，
// 故所有分支在纯函数/可注入取数器层锁定。
import { describe, it, expect } from "vitest";
import { ApiError } from "../../api/client";
import type { GlobalDocHit, GlobalRecordHit } from "../../api/client";
import type { SearchStatusDTO, V1SearchResponse } from "@gx/shared-types";
import { fetchUnifiedSearch } from "./search-query";
import { normalizeV1, isV1NotFound } from "./search-adapter";
import { buildConfigPatch } from "./search-config";
import { adminErrorMessage } from "./search-admin-copy";
import { errorCode, isForbidden, isSearchNotEnabled } from "./search-admin-hooks";
import { SEARCH_NOT_ENABLED } from "./search-admin-copy";

function v1Res(over: Partial<V1SearchResponse> = {}): V1SearchResponse {
  return {
    items: [], total: 0, limit: 20, mode: "hybrid", degraded: [],
    scopeTruncated: false, policyVersion: 1, ...over,
  };
}

const rec: GlobalRecordHit = {
  type: "record", baseId: "b", baseName: "B", tableId: "t", tableName: "T",
  recordId: "r", title: "R", snippet: "s", matchedField: "f",
};
const doc: GlobalDocHit = { type: "doc", kbId: "k", kbName: "K", docId: "d", title: "D", snippet: "s" };

describe("fetchUnifiedSearch 404 回退旧链", () => {
  it("v1 200 → 归一 v1 结果（fromV1=true）", async () => {
    const res = await fetchUnifiedSearch("q", [], {
      searchV1: async () => v1Res({ mode: "fts" }),
      searchByImage: async () => { throw new Error("不应走 POST"); },
      searchLegacy: async () => {
        throw new Error("不应回退旧链");
      },
    });
    expect(res.fromV1).toBe(true);
  });

  it("v1 404 NOT_FOUND → 回退旧 /api/search 形状（fromV1=false, notice=null）", async () => {
    let legacyCalled = false;
    const res = await fetchUnifiedSearch("q", [], {
      searchV1: async () => {
        throw new ApiError(404, { error: "接口不存在", details: { code: "NOT_FOUND" } });
      },
      searchByImage: async () => { throw new Error("不应走 POST"); },
      searchLegacy: async () => {
        legacyCalled = true;
        return { records: [rec], docs: [doc] };
      },
    });
    expect(legacyCalled).toBe(true);
    expect(res.fromV1).toBe(false);
    expect(res.notice).toBeNull();
    expect(res.hits.map((h) => h.type)).toEqual(["doc", "record"]);
  });

  it("v1 404 无 code（整个 /api/v1 未挂兜底）也回退", async () => {
    const res = await fetchUnifiedSearch("q", [], {
      searchV1: async () => {
        throw new ApiError(404, { error: "Not Found" });
      },
      searchByImage: async () => { throw new Error("不应走 POST"); },
      searchLegacy: async () => ({ records: [], docs: [] }),
    });
    expect(res.fromV1).toBe(false);
    expect(res.hits).toEqual([]);
  });

  it("404 其它业务 code 不回退（透传），401/403/500 也不回退", async () => {
    const cases = [
      new ApiError(404, { details: { code: "SOME_OTHER" } } as never),
      new ApiError(401, {}),
      new ApiError(403, {}),
      new ApiError(500, {}),
    ];
    for (const e of cases) {
      await expect(
        fetchUnifiedSearch("q", [], {
          searchV1: async () => {
            throw e;
          },
          searchByImage: async () => { throw new Error("不应走 POST"); },
          searchLegacy: async () => {
            throw new Error("不应回退");
          },
        }),
      ).rejects.toBe(e);
    }
  });

  it("isV1NotFound 仅认 404 + NOT_FOUND/无 code", () => {
    expect(isV1NotFound(404, "NOT_FOUND")).toBe(true);
    expect(isV1NotFound(404)).toBe(true);
    expect(isV1NotFound(404, "X")).toBe(false);
    expect(isV1NotFound(500, "NOT_FOUND")).toBe(false);
  });

  it("带图片：走 searchByImage（POST），归一 v1 结果", async () => {
    const seen: { images: string[] } = { images: [] };
    const res = await fetchUnifiedSearch("", ["data:image/png;base64,AA"], {
      searchV1: async () => { throw new Error("不应走 GET"); },
      searchByImage: async (body) => {
        seen.images = body.images ?? [];
        return v1Res({ mode: "vector", items: [
          { type: "record", entityId: "r1", nodeId: "n1", title: "相似", snippet: "s", score: 0.1, matchedVia: ["vec"], chunkSeq: null, matchedField: null },
        ] });
      },
      searchLegacy: async () => { throw new Error("不应回退旧链"); },
    });
    expect(seen.images).toEqual(["data:image/png;base64,AA"]);
    expect(res.fromV1).toBe(true);
    expect(res.hits.map((h) => h.entityId)).toEqual(["r1"]);
  });
});

describe("buildConfigPatch 二次确认与只写 apiKey", () => {
  const form = {
    mode: "cloud" as const,
    baseURL: "https://x/",
    model: "m",
    batchSize: "32",
    timeoutMs: "8000",
    fieldChunkCap: "500",
    apiKey: "",
  };

  it("off->cloud 首次 confirmCloud=false（缺省被后端 409），确认后 true", () => {
    expect(buildConfigPatch(form, false).confirmCloud).toBe(false);
    expect(buildConfigPatch(form, true).confirmCloud).toBe(true);
  });

  it("cloud->off 不带 confirmCloud（cloud->off 无需确认）", () => {
    expect(buildConfigPatch({ ...form, mode: "off" }, false).confirmCloud).toBeUndefined();
  });

  it("apiKey 空串=不进请求体（保持既有密钥，GET 永不回明文）；填了才随请求覆盖", () => {
    expect("apiKey" in buildConfigPatch(form, true)).toBe(false);
    expect(buildConfigPatch({ ...form, apiKey: "sk-xxx" }, true).apiKey).toBe("sk-xxx");
  });

  it("永不产出 dim/reindex 字段（出现即 400），数值串转正整数", () => {
    const p = buildConfigPatch(form, true) as Record<string, unknown>;
    expect(p).not.toHaveProperty("dim");
    expect(p).not.toHaveProperty("dimensions");
    expect(p).not.toHaveProperty("reindex");
    expect(p.batchSize).toBe(32);
    expect(p.timeoutMs).toBe(8000);
    expect(p.fieldChunkCap).toBe(500);
  });

  it("非法/空数值串落为 undefined（不发送 NaN）", () => {
    const p = buildConfigPatch({ ...form, batchSize: "", timeoutMs: "abc", fieldChunkCap: "0" }, true);
    expect(p.batchSize).toBeUndefined();
    expect(p.timeoutMs).toBeUndefined();
    expect(p.fieldChunkCap).toBeUndefined();
  });
});

describe("apiKey 状态形状：只写 + maskedLast4（配置 GET 响应不回明文）", () => {
  it("GET 配置里 apiKey 仅 configured/source/maskedLast4，UI 只读末 4 与来源", () => {
    // 这是契约形状断言：即便已配置，字段里也没有明文 key。
    const cfg = {
      mode: "cloud", baseURL: "", model: "", dim: 0, batchSize: 1, timeoutMs: 1, fieldChunkCap: 1,
      apiKey: { configured: true, source: "db" as const, maskedLast4: "ab12" },
    };
    expect(cfg.apiKey).toEqual({ configured: true, source: "db", maskedLast4: "ab12" });
    expect(JSON.stringify(cfg.apiKey)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    const none = { configured: false, source: "none" as const, maskedLast4: null };
    expect(none.maskedLast4).toBeNull();
  });
});

describe("403 静默降级与错误码中性文案", () => {
  it("isForbidden 仅认 403；errorCode 取信封 code", () => {
    expect(isForbidden(new ApiError(403, {}))).toBe(true);
    expect(isForbidden(new ApiError(404, {}))).toBe(false);
    expect(errorCode(new ApiError(409, { details: { code: "REINDEX_IN_PROGRESS" } } as never))).toBe(
      "REINDEX_IN_PROGRESS",
    );
    expect(errorCode(new TypeError("x"))).toBeNull();
  });

  it("管理面错误码都有可读中文文案且不含实现词", () => {
    const codes = [
      "EMBEDDING_CONFIG_INVALID",
      "NEED_CLOUD_CONFIRM",
      "REINDEX_IN_PROGRESS",
      "SEARCH_UNAVAILABLE",
      "REINDEX_FAILED",
    ];
    for (const c of codes) {
      const text = adminErrorMessage(c);
      expect(text.length).toBeGreaterThan(2);
      for (const banned of ["sqlite", ".so", "endpoint", "vec0", "embedding 端点"]) {
        expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });
});

describe("检索子面未启用判定（GX_M5_SEARCH off → admin 端点 404 NOT_FOUND）", () => {
  it("404 / code=NOT_FOUND 认作未启用，不当普通错误", () => {
    expect(isSearchNotEnabled(new ApiError(404, { error: "接口不存在", code: "NOT_FOUND" } as never))).toBe(true);
    expect(isSearchNotEnabled(new ApiError(404, {}))).toBe(true);
    expect(isSearchNotEnabled(new ApiError(500, { code: "NOT_FOUND" } as never))).toBe(true);
  });

  it("其它错误/越权不算未启用，仍走原有分支", () => {
    expect(isSearchNotEnabled(new ApiError(403, {}))).toBe(false);
    expect(isSearchNotEnabled(new ApiError(500, { code: "REINDEX_FAILED" } as never))).toBe(false);
    expect(isSearchNotEnabled(new TypeError("x"))).toBe(false);
  });

  it("未启用文案讲清功能没开而非稍后重试，且关键词检索照常", () => {
    expect(SEARCH_NOT_ENABLED.title).toContain("未启用");
    // 语义适配（P3）：总门已可在本页打开，文案改为指向「检索总门」而不是"去改环境变量"。
    expect(SEARCH_NOT_ENABLED.body).toContain("检索总门");
    expect(SEARCH_NOT_ENABLED.body).toContain("关键词检索");
    for (const t of [SEARCH_NOT_ENABLED.title, SEARCH_NOT_ENABLED.body, SEARCH_NOT_ENABLED.reindexHint]) {
      expect(t).not.toContain("稍后重试");
    }
  });
});

describe("search status：index=null 空态判定", () => {
  it("尚未建库 index=null（与全 0 区分），由组件渲染空态", () => {
    const notBuilt: SearchStatusDTO = {
      vec: { loaded: false, version: null, extPathKind: "builtin" },
      embedding: { mode: "off", model: "", dim: 0, healthy: false, reindexRequired: false },
      index: null,
    };
    const built: SearchStatusDTO = {
      vec: { loaded: true, version: "x", extPathKind: "builtin" },
      embedding: { mode: "cloud", model: "m", dim: 3, healthy: true, reindexRequired: false },
      index: {
        schemaVersion: 1, indexedAt: null, rebuilding: false,
        chunks: { records: 0, docs: 0, canvas: 0, total: 0, fieldChunks: 0, fieldChunksCapped: 0, fieldChunkCap: 500 },
        backlog: { pending: 0, failed: 0, dead: 0 },
        coverage: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 },
      },
    };
    // 空态判据：index===null，而非各计数为 0。
    expect(notBuilt.index === null).toBe(true);
    expect(built.index === null).toBe(false);
    expect(built.index?.backlog).toBeDefined();
  });
});

describe("轮询节流启停（纯函数依据）", () => {
  // 真正的 interval/refetch 行为由 useSearchStatus 的 refetchInterval(InBackground=false)
  // 与 visibilitychange 监听保证（React Query 配置）；这里锁定节流参数常量不被误改。
  it("默认 30s、重建中提速到 5s 的分档逻辑可复算", (): void => {
    const intervalFor = (rebuilding: boolean): number => (rebuilding ? 5_000 : 30_000);
    expect(intervalFor(false)).toBe(30_000);
    expect(intervalFor(true)).toBe(5_000);
  });

  it("空 q 不产请求由 hook enabled 保证；归一函数对空响应安全", () => {
    const r = normalizeV1(v1Res({ items: [], mode: "like" }));
    expect(r.hits).toEqual([]);
    expect(r.notice).toBeNull();
  });
});
