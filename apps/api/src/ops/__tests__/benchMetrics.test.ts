// apps/api/src/ops/__tests__/benchMetrics.test.ts
// M1/S9-2 埋点门控与计数口径单测：默认 off 零副作用；bench 时 ALS 计数 + 中间件三头 +
// instrumentDatabase 对 better-sqlite3 物理执行计数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  benchEnabled,
  benchMetricsMiddleware,
  instrumentDatabase,
  notePhysicalSql,
  notePrismaCall,
} from "../benchMetrics.js";

describe("benchEnabled 门控", () => {
  const old = process.env.GX_BENCH;
  afterEach(() => {
    if (old === undefined) delete process.env.GX_BENCH;
    else process.env.GX_BENCH = old;
  });

  it("默认（未设置）关闭", () => {
    delete process.env.GX_BENCH;
    expect(benchEnabled()).toBe(false);
  });

  it("仅 GX_BENCH=on 开启，其它值关闭", () => {
    process.env.GX_BENCH = "on";
    expect(benchEnabled()).toBe(true);
    for (const v of ["off", "ON", "1", "true", ""]) {
      process.env.GX_BENCH = v;
      expect(benchEnabled()).toBe(false);
    }
  });
});

describe("bench 计数（ALS 上下文）", () => {
  const old = process.env.GX_BENCH;
  beforeEach(() => {
    process.env.GX_BENCH = "on";
  });
  afterEach(() => {
    if (old === undefined) delete process.env.GX_BENCH;
    else process.env.GX_BENCH = old;
  });

  // 通过中间件建立真实 ALS 上下文，读取它写出的响应头断言计数。
  async function runWithHeaders(fn: () => void): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    const c = {
      header: (k: string, v: string) => {
        headers[k] = v;
      },
    };
    await benchMetricsMiddleware(c as never, (async () => fn()) as never);
    return headers;
  }

  it("notePrismaCall / notePhysicalSql 在请求上下文内累加", async () => {
    const h = await runWithHeaders(() => {
      notePrismaCall();
      notePrismaCall();
      notePhysicalSql();
    });
    expect(h["x-gx-prisma-calls"]).toBe("2");
    expect(h["x-gx-physical-sql"]).toBe("1");
    expect(Number(h["x-gx-serve-ms"])).toBeGreaterThanOrEqual(0);
  });

  it("上下文外计数为 no-op（非 bench 后台路径零副作用）", async () => {
    // 不在 als.run 内调用：不抛错即可（无 store）。
    expect(() => {
      notePrismaCall();
      notePhysicalSql();
    }).not.toThrow();
  });

  it("非 bench 时中间件直通，不挂任何 x-gx 头", async () => {
    process.env.GX_BENCH = "off";
    const headers: Record<string, string> = {};
    const c = { header: vi.fn((k: string, v: string) => void (headers[k] = v)) };
    const next = vi.fn(async () => {
      notePrismaCall();
      notePhysicalSql();
    });
    await benchMetricsMiddleware(c as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(c.header).not.toHaveBeenCalled();
    expect(headers).toEqual({});
  });
});

describe("instrumentDatabase", () => {
  it("每次 statement 执行计一次物理 SQL，结果与原连接一致", () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    raw.exec("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')");
    const db = instrumentDatabase(raw);

    // 在 bench ALS 上下文外执行：不计数但结果一致（Proxy 不改变行为）。
    const before = db.prepare("SELECT count(*) AS n FROM t").get() as { n: number };
    expect(Number(before.n)).toBe(3);

    // 复用计数中间件的 ALS：通过动态方式难以直接拿 store，改为断言 Proxy 透传 all/get。
    const rows = db.prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[];
    expect(rows.map((r) => r.v)).toEqual(["a", "b", "c"]);
    const one = db.prepare("SELECT v FROM t WHERE id = ?").get(2) as { v: string };
    expect(one.v).toBe("b");
    raw.close();
  });

  it("在 bench 请求上下文内，all/get/run 各计一次", async () => {
    process.env.GX_BENCH = "on";
    const headers: Record<string, string> = {};
    const c = { header: (k: string, v: string) => void (headers[k] = v) };
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const db = instrumentDatabase(raw);
    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    await benchMetricsMiddleware(c as never, (async () => {
      ins.run("x");
      ins.run("y");
      db.prepare("SELECT count(*) AS n FROM t").get();
      db.prepare("SELECT v FROM t").all();
    }) as never);
    expect(headers["x-gx-physical-sql"]).toBe("4"); // 2 run + 1 get + 1 all
    expect(Number((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n)).toBe(2);
    raw.close();
    delete process.env.GX_BENCH;
  });
});
