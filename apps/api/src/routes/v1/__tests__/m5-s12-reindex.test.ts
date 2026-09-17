// M5/S12 AC-M5-1b 重建窗口检索持续可用：全量 reindex 双库切换期间，HTTP /api/v1/search 始终 200。
//
// 确定性控制：startReindex 注入 onProgress 闸门（灌完第 1 个实体即挂起，保持 inflight 与临时
// rebuild 库在飞），此刻从 HTTP 检索——现役库仍是切换前的完整库，必须正常 200 命中；
// 放行后等待完成，再搜仍 200、内容一致。全程真迁移/真 app/真 JWT/off 形态（不依赖 vec0）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupS12, searchOnce, type S12World } from "./m5-s12-harness.js";

let w: S12World;
let gate: { release: () => void; reached: Promise<void> };

beforeAll(async () => {
  w = await setupS12({ mode: "off", label: "reindex-avail" });
  await w.seedRecord({ primary: "重建窗口可用词REIDX1" });
  await w.seedRecord({ primary: "重建窗口可用词REIDX2" });
  await w.seedDoc("重建窗口文档词REIDXDOC1");
}, 180000);
afterAll(async () => { gate?.release(); await w.cleanup(); });

describe("AC-M5-1b 全量 reindex 灌库中 HTTP 检索持续 200", () => {
  it("inflight 期间搜索旧库：200 命中且不报 409/500；完成后 200 一致", async () => {
    const { reindex } = await w.modules();
    let resolveReached: () => void = () => undefined;
    let releasePump: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { resolveReached = resolve; });
    let pumpGate: Promise<void> | null = null;
    gate = {
      release: () => releasePump(),
      reached,
    };
    let opened = false;
    const task = reindex.startReindex({
      prisma: w.prisma, env: process.env, dataDir: w.tmpDir, appDir: process.cwd(), jwtSecret: "m5-s12-selfheal-secret-atleast-16",
      searchPath: w.searchPath,
      onProgress: (done: number, total: number) => {
        if (!opened && done >= 1 && total >= 2) {
          opened = true;
          pumpGate = new Promise<void>((resolve) => { releasePump = resolve; });
          resolveReached();
          return pumpGate; // 灌库真实挂起：rebuild 在飞、现役库未切换
        }
        return undefined;
      },
    });
    await reached;
    expect(reindex.isReindexing()).toBe(true);

    // 灌库窗口内连续检索：旧库完整服役，全部 200 且命中既有内容。
    for (let i = 0; i < 3; i += 1) {
      const r = await searchOnce(w, "REIDX1");
      expect(r.status).toBe(200);
      expect(["fts", "like"]).toContain(r.body.mode);
      expect(r.body.items.length).toBeGreaterThan(0);
    }
    const doc = await searchOnce(w, "REIDXDOC1");
    expect(doc.status).toBe(200);
    expect(doc.body.items.length).toBeGreaterThan(0);

    gate.release();
    const result = await task;
    expect(result.swapped).toBe(true);
    expect(reindex.isReindexing()).toBe(false);

    // 切换后检索仍 200、新库内容一致。
    const after = await searchOnce(w, "REIDX2");
    expect(after.status).toBe(200);
    expect(after.body.items.length).toBeGreaterThan(0);
    const c = w.counts();
    expect(c.chunks).toBeGreaterThan(0);
  }, 60000);
});
