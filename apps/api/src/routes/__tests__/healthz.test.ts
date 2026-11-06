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
    // version 原样透传版本单源（根 package.json）。0.3.0 起根版本带 semver 构建短串
    //（如 0.3.0+b863f29），healthz 不得剥离——否则会与 fpk manifest / 关于页产生版本漂移；
    // 存活契约只要求「规范版本、非游离硬编码」，故允许 -prerelease / +build，
    // 字符集与 src/__tests__/version.test.ts、packages/shared-types/src/update.ts VERSION_RE 对齐。
    expect(body.version).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    );
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});
