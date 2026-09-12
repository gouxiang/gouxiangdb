// apps/api/src/db/__tests__/writeQueue.test.ts
// M1/S1：写串行队列单元测试。
// 验证：并发度恒 1、FIFO 顺序、异常原样透传不打断后续、disabled 旁路、统计计数、开关解析。

import { describe, it, expect } from "vitest";
import { createWriteQueue, resolveWriteQueueEnabled } from "../writeQueue.js";

/** 一个可被外部 resolve 的 deferred，用于精确控制任务并发时机 */
function gate() {
  let resolve!: () => void;
  const p = new Promise<void>((res) => {
    resolve = res;
  });
  return { p, resolve };
}

describe("createWriteQueue（enabled）", () => {
  it("并发度恒 1：先入队的任务未结束时，后续任务不得开始", async () => {
    const q = createWriteQueue(true);
    const a = gate();
    let aStarted = false;
    let bStarted = false;
    let active = 0;
    let maxActive = 0;

    const runA = q.run("a", async () => {
      aStarted = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await a.p;
      active -= 1;
      return "A";
    });
    const runB = q.run("b", async () => {
      bStarted = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return "B";
    });

    // 等一个微任务轮次让 b 进入排队
    await Promise.resolve();
    await Promise.resolve();
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(false);
    expect(q.pending()).toBeGreaterThanOrEqual(1);

    a.resolve();
    const [ra, rb] = await Promise.all([runA, runB]);
    expect(ra).toBe("A");
    expect(rb).toBe("B");
    expect(bStarted).toBe(true);
    expect(maxActive).toBe(1);
  });

  it("FIFO：20 个并发入队按入队顺序执行", async () => {
    const q = createWriteQueue(true);
    const order: number[] = [];
    const tasks = Array.from({ length: 20 }, (_, i) =>
      q.run(`t${i}`, async () => {
        order.push(i);
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("异常原样透传（HttpError 语义不变），且不打断后续任务", async () => {
    const q = createWriteQueue(true);
    class HttpError extends Error {
      constructor(public status: number, message: string) {
        super(message);
      }
    }
    const boom = new HttpError(409, "字段「编码」要求唯一，该值已存在");

    const r1 = q.run("fail", async () => {
      throw boom;
    });
    // 失败之后再入队一个，必须仍能执行
    const r2 = q.run("ok", async () => "after");

    await expect(r1).rejects.toBe(boom); // 同一错误对象引用（未包装/未改 message）
    expect(await r2).toBe("after");
    const s = q.stats();
    expect(s.failed).toBe(1);
    expect(s.settled).toBe(2);
    expect(s.enqueued).toBe(2);
  });

  it("统计：byLabel 计数与等待/执行样本", async () => {
    const q = createWriteQueue(true);
    await q.run("record.create", async () => 1);
    await q.run("record.create", async () => 2);
    await q.run("record.update", async () => 3);
    const s = q.stats();
    expect(s.byLabel).toEqual({ "record.create": 2, "record.update": 1 });
    expect(s.runMsSamples).toHaveLength(3);
    expect(s.waitMsSamples).toHaveLength(3);
  });
});

describe("createWriteQueue（disabled 旁路）", () => {
  it("run 直接执行任务，不串行（旧行为回退）", async () => {
    const q = createWriteQueue(false);
    expect(q.enabled).toBe(false);
    const a = gate();
    let bRan = false;
    const runA = q.run("a", async () => {
      await a.p;
    });
    const runB = q.run("b", async () => {
      bRan = true;
    });
    await Promise.resolve();
    // 旁路后 b 不等待 a
    await runB;
    expect(bRan).toBe(true);
    a.resolve();
    await runA;
    // 旁路模式不统计
    expect(q.stats().enqueued).toBe(0);
  });
});

describe("resolveWriteQueueEnabled", () => {
  it("显式 on/off 优先", () => {
    expect(resolveWriteQueueEnabled({ GX_M1_WRITE_QUEUE: "on" })).toBe(true);
    expect(resolveWriteQueueEnabled({ GX_M1_WRITE_QUEUE: "off" })).toBe(false);
    // off 即使在生产也旁路
    expect(resolveWriteQueueEnabled({ GX_M1_WRITE_QUEUE: "off", NODE_ENV: "production" })).toBe(false);
  });

  it("未设置：test 默认 off，production/development 默认 on", () => {
    expect(resolveWriteQueueEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(resolveWriteQueueEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(resolveWriteQueueEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(resolveWriteQueueEnabled({})).toBe(true);
  });
});
