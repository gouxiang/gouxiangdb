// M1/S10 T0 对账器单测（无 DB）：hono logger `<--`/`-->` FIFO 配对、三流分桶、
// ANSI 颜色状态码、尾挂（进入未响应）识别、readyz/login 排除。真实日志回归见 baseline
// （5000-c8-on-fixed home 501/501/0、view 3250/3250/0；修复前 view 8 尾挂 L1232-1241）。

import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";

const modUrl = pathToFileURL(
  path.resolve(__dirname, "../audit-server-log.mjs"),
).href;

async function parse(text: string) {
  const mod = await import(modUrl);
  return mod.parseServerLog(text) as Map<string, {
    in: number; out: number; trailing: unknown[]; status: Record<string, number>;
  }>;
}

const T = "tbl1";
const rec = (qs: string, status = 200) =>
  `<-- GET /api/records?tableId=${T}${qs}\n--> GET /api/records?tableId=${T}${qs} \u001b[32m${status}\u001b[0m 12ms`;

describe("audit-server-log FIFO 对账", () => {
  it("三流分桶：无 viewId=home，带 viewId/search=view-search，POST=write；readyz/login 排除", async () => {
    const text = [
      "<-- GET /readyz", "--> GET /readyz 200 3ms",
      "<-- POST /api/auth/login", "--> POST /api/auth/login 200 40ms",
      rec("&limit=100"),
      rec("&limit=100&viewId=v1"),
      rec("&limit=100&search=%E9%A1%B9"),
      "<-- POST /api/records?tableId=" + T,
      `--> POST /api/records?tableId=${T} 201 80ms`,
    ].join("\n");
    const f = await parse(text);
    expect(f.get("home")!.in).toBe(1);
    expect(f.get("view-search")!.in).toBe(2);
    expect(f.get("write")!.in).toBe(1);
    expect(f.size).toBe(3);
  });

  it("全配对时各流 in==out、无尾挂；ANSI 颜色状态码正确解析", async () => {
    const text = [rec("&limit=100"), rec("&limit=100"), rec("&viewId=v9", 400)].join("\n");
    const f = await parse(text);
    expect(f.get("home")!).toMatchObject({ in: 2, out: 2 });
    expect(f.get("home")!.trailing).toHaveLength(0);
    const view = f.get("view-search")!;
    expect(view.out).toBe(1);
    expect(view.status).toEqual({ "400": 1 });
    expect(view.trailing).toHaveLength(0);
  });

  it("深页窗口 400 计入 home 状态码但不算尾挂/失败流（非 5xx）", async () => {
    const text = rec("&offset=600", 400);
    const f = await parse(text);
    expect(f.get("home")!.status).toEqual({ "400": 1 });
    expect(f.get("home")!.trailing).toHaveLength(0);
  });

  it("进入未响应（客户端放弃/连接死）记为尾挂 request-without-response", async () => {
    // 两个进入、仅一个响应：FIFO 配对后剩 1 个进入项成尾挂。
    const text =
      `<-- GET /api/records?tableId=${T}&limit=100&viewId=v1\n` +
      `<-- GET /api/records?tableId=${T}&limit=100&viewId=v1\n` +
      `--> GET /api/records?tableId=${T}&limit=100&viewId=v1 200 2s`;
    const f = await parse(text);
    const view = f.get("view-search")!;
    expect(view.in).toBe(2);
    expect(view.out).toBe(1);
    expect(view.trailing).toHaveLength(1);
    expect(view.trailing[0]).toMatchObject({ kind: "request-without-response" });
  });

  it("尾挂按连接内 FIFO 配对（交错完成只弹同 key 最早进入项）", async () => {
    const text =
      `<-- GET /api/records?tableId=${T}&limit=100\n` +
      `<-- GET /api/records?tableId=${T}&limit=100&viewId=v1\n` +
      `--> GET /api/records?tableId=${T}&limit=100 200 10ms\n` +
      `--> GET /api/records?tableId=${T}&limit=100&viewId=v1 200 20ms`;
    const f = await parse(text);
    expect(f.get("home")!.trailing).toHaveLength(0);
    expect(f.get("view-search")!.trailing).toHaveLength(0);
  });
});
