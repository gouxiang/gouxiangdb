// apps/api/src/routes/__tests__/healthz.test.ts
// healthz 路由级契约：恒 200，不查库不鉴权，字段固定。

import { describe, expect, it } from "vitest";
import { healthz } from "../healthz.js";

describe("GET /healthz", () => {
  it("恒返回 200 与固定存活契约", async () => {
    const res = await healthz.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      version: string;
      time: string;
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("gouxiangdb-api");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});
