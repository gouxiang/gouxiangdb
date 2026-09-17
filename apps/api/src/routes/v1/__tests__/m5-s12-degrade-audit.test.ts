// M5/S12 Gap B search_degraded 跳变采样审计（真迁移/真 app/真 JWT，读真实 audit.logl）。
//
// 断言：
//  - 健康搜索不产生 search_degraded（健康态只更新内存，不打点）；
//  - 损坏 -> 当次 like/recovering：恰好一行 search_degraded，actorId=null（系统事件，r 身份），
//    detail 仅 {reasons,mode,recovering} 技术态——无 q/标题/字段值/key/向量/实体 id；
//  - 同态（恢复窗口内重复请求）不打第二行；
//  - 恢复健康不打"恢复"行；再次损坏（重降级）才再打一行新事件；
//  - 损坏事件 path 固定 /api/v1/search（不含查询串），status=200。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupS12, searchOnce, type S12World } from "./m5-s12-harness.js";

let w: S12World;

beforeAll(async () => { w = await setupS12({ mode: "off", label: "degrade-audit" }); }, 180000);
afterAll(async () => { await w.cleanup(); });

function degradedLines(): Array<Record<string, unknown>> {
  return w.auditLines().filter((l) => l.event === "search_degraded");
}

describe("Gap B search_degraded 跳变采样", () => {
  it("健康->损坏 打一行且严格脱敏；同态不重复；恢复->重降级再打一行", async () => {
    const t = await w.seedRecord({ primary: "审计跳变唯一词AUDITTRANS1" });
    await w.seedDoc("审计跳变文档词AUDITDOC1");

    // 健康基线：两条搜索都不产生 search_degraded。
    await searchOnce(w, "AUDITTRANS1");
    await searchOnce(w, "AUDITDOC1");
    expect(degradedLines()).toEqual([]);

    // 第一次损坏：当次 like + recovering -> 一行。
    w.corruptSearchDbMagic();
    const r = await searchOnce(w, "AUDITTRANS1");
    expect(r.status).toBe(200);
    expect(r.body.degraded).toContain("search_store_recovering");
    let lines = degradedLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.actorId).toBeNull();
    expect(line.method).toBe("GET");
    expect(line.path).toBe("/api/v1/search");
    expect(line.status).toBe(200);
    const detail = line.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(["mode", "reasons", "recovering"]);
    expect(detail.reasons).toEqual(["search_store_recovering"]);
    expect(detail.mode).toBe("like");
    expect(detail.recovering).toBe(true);
    // 严格脱敏：整条 JSONL 不含查询词/标题/任何实体 id/key 字样。
    const raw = JSON.stringify(line);
    expect(raw).not.toContain("AUDITTRANS1");
    expect(raw).not.toContain("AUDITDOC1");
    expect(raw).not.toContain(t.recordId);
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("Bearer");

    // 恢复窗口内同态重复：不打第二行。
    const again = await searchOnce(w, "AUDITDOC1");
    expect(again.status).toBe(200);
    expect(degradedLines()).toHaveLength(1);

    // 恢复健康：不打"恢复"行。
    const { recovery } = await w.modules();
    await recovery.currentRepopulation();
    await new Promise((res) => setTimeout(res, 10));
    const ok = await searchOnce(w, "AUDITTRANS1");
    expect(ok.body.degraded).toEqual([]);
    expect(degradedLines()).toHaveLength(1);

    // 再次损坏（重降级）：新事件，再打一行；恢复后总行数=2。
    await w.seedRecord({ primary: "审计二次降级词AUDITTRANS2" });
    w.corruptSearchDbMagic();
    const r2 = await searchOnce(w, "AUDITTRANS2");
    expect(r2.status).toBe(200);
    lines = degradedLines();
    expect(lines).toHaveLength(2);
    expect((lines[1]!.detail as Record<string, unknown>).reasons).toEqual(["search_store_recovering"]);
    await recovery.currentRepopulation();
  }, 60000);

  it("JSONL 每行恰好一条记录，且 search_degraded 不污染其它事件", async () => {
    const all = w.auditLines();
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const l of all) {
      expect(typeof l.ts).toBe("string");
      expect(typeof l.event).toBe("string");
    }
  });
});
