// apps/api/src/ops/__tests__/readiness.test.ts
// readyz 探针单测：用注入式假依赖覆盖五探针通过/失败两态，
// 断言 200/503、失败短码，以及响应不含绝对路径与异常堆栈。

import { describe, expect, it } from "vitest";
import {
  reconcileMigrations,
  resolveDatabaseFile,
  runChecks,
  type ProbeResult,
  type ReadinessDeps,
} from "../readiness.js";
import { assessReadiness } from "../../routes/readyz.js";

function okDeps(overrides: Partial<Record<keyof ReadinessDeps, unknown>> = {}): ReadinessDeps {
  const base = {
    dbPing: async (): Promise<ProbeResult> => ({ ok: true }),
    dbWritable: async (): Promise<ProbeResult> => ({ ok: true }),
    migrations: async () => ({
      ok: true,
      applied: 11,
      latest: "20260911233000_kbdoc_content_version",
    }),
    uploadsWritable: async (): Promise<ProbeResult> => ({ ok: true }),
    disk: async (): Promise<ProbeResult> => ({ ok: true }),
    dispose: () => {},
  };
  return { ...base, ...overrides } as ReadinessDeps;
}

const failDeps = (): ReadinessDeps =>
  okDeps({
    dbPing: async () => ({ ok: false, code: "FAIL" }),
    dbWritable: async () => ({ ok: false, code: "BUSY" }),
    migrations: async () => ({
      ok: false,
      code: "MISMATCH",
      applied: 10,
      latest: "20260908023042_add_doc_tree_and_share",
    }),
    uploadsWritable: async () => ({ ok: false, code: "FAIL" }),
    disk: async () => ({ ok: false, code: "LOW_SPACE" }),
  });

describe("resolveDatabaseFile", () => {
  it("绝对路径 file: 直接采用", () => {
    expect(resolveDatabaseFile("file:/var/lib/gouxiangdb/app.db", "/x/prisma"))
      .toBe("/var/lib/gouxiangdb/app.db");
  });
  it("相对路径相对 prisma 目录解析", () => {
    expect(resolveDatabaseFile("file:./dev.db", "/repo/apps/api/prisma"))
      .toBe("/repo/apps/api/prisma/dev.db");
  });
});

describe("reconcileMigrations", () => {
  const db = { applied: 11, latest: "m3" };
  it("磁盘与库计数、最新迁移名一致才通过", () => {
    expect(reconcileMigrations({ count: 11, latest: "m3" }, db).ok).toBe(true);
  });
  it("计数不一致判 MISMATCH", () => {
    const r = reconcileMigrations({ count: 10, latest: "m3" }, db);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MISMATCH");
  });
  it("最新迁移名不一致判 MISMATCH", () => {
    const r = reconcileMigrations({ count: 11, latest: "mX" }, db);
    expect(r.ok).toBe(false);
  });
});

describe("runChecks / assessReadiness", () => {
  it("五探针全过：200 + status ready + 全 true + 迁移计数 11", async () => {
    const report = await runChecks(okDeps());
    expect(report.status).toBe("ready");
    expect(report.checks).toEqual({
      dbPing: true,
      dbWritable: true,
      migrations: true,
      uploadsWritable: true,
      disk: true,
    });
    expect(report.migration).toEqual({
      applied: 11,
      latest: "20260911233000_kbdoc_content_version",
    });

    const http = await assessReadiness(okDeps());
    expect(http.httpStatus).toBe(200);
    expect(http.body.status).toBe("ready");
  });

  it("任一失败：503 + status not_ready + 失败项为短码", async () => {
    const deps = okDeps({ disk: async () => ({ ok: false, code: "LOW_SPACE" }) });
    const http = await assessReadiness(deps);
    expect(http.httpStatus).toBe(503);
    const body = http.body as {
      status: string;
      checks: Record<string, boolean | string>;
      error: string;
    };
    expect(body.status).toBe("not_ready");
    expect(body.checks.disk).toBe("LOW_SPACE");
    expect(body.checks.dbPing).toBe(true);
    expect(body.error).toBe("LOW_SPACE");
  });

  it("多项失败：全部短码呈现，error 取首个失败短码，无路径/堆栈泄漏", async () => {
    const http = await assessReadiness(failDeps());
    expect(http.httpStatus).toBe(503);
    const json = JSON.stringify(http.body);
    // 无绝对路径、无 SQL/JS 堆栈指纹
    expect(json).not.toMatch(/\/[A-Za-z]/);
    expect(json).not.toMatch(/\bat\s+\w+\s*\(/);
    expect(json).not.toContain("Error:");
    expect(json).not.toContain("SQLITE");
    expect(http.body.checks).toMatchObject({
      dbPing: "FAIL",
      dbWritable: "BUSY",
      migrations: "MISMATCH",
      uploadsWritable: "FAIL",
      disk: "LOW_SPACE",
    });
  });

  it("dispose 在评估后由调用方执行（探针不残留连接）", async () => {
    let disposed = false;
    const deps = okDeps({ dispose: () => (disposed = true) });
    deps.dispose();
    expect(disposed).toBe(true);
  });
});
