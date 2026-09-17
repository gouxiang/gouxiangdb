// M5/S12 AC-M5-5 零外网【确定性层】：拦截全局 fetch，跑完整业务链断言零出网。
//
// 三个世界（各自独立 vitest 进程/独立临时库/真迁移/真 JWT）：
//   A. GX_EMBEDDING_MODE=off + GX_M5_SEARCH=on：新检索 + 主写 + 管理状态全程零 fetch；
//   B. GX_M5_SEARCH=off（企业检索面关闭）：v1/search 404 + 主写 + 旧 /api/search + 旧管理 404，
//      全程零 fetch（出厂默认姿态）；
//   C. cloud：经管理员显式配置 + confirmCloud 后，唯一出网方向是配置的 baseURL host，
//      且所有调用都打在 /v1/embeddings 契约上（无第三方遥测/CDN/统计）。
//
// runbook 层（代理抓包）证据见 docs/runbooks/m5-search.md「off 零外网抓包」小节。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupS12, searchOnce, type S12World } from "./m5-s12-harness.js";

describe("AC-M5-5 A：GX_EMBEDDING_MODE=off（m5Search=on）全链零 fetch", () => {
  let w: S12World;
  beforeAll(async () => {
    w = await setupS12({ mode: "off", label: "egress-off", egress: "failClosed" });
    // 灌主库数据（不经网络；off 形态不走向量）。
    await w.seedRecord({ primary: "零外网唯一词EGRESSOFF1" });
    await w.seedDoc("零外网文档词EGRESSDOC1");
  }, 180000);
  afterAll(async () => { await w.cleanup(); });

  it("新检索（auto/fts/vector）+ 主写（record POST、kb PUT content）+ status：零 fetch 且全部成功", async () => {
    for (const q of ["EGRESSOFF1", "EGRESSDOC1"]) {
      for (const mode of ["auto", "fts"] as const) {
        const r = await searchOnce(w, q, `&mode=${mode}`);
        expect(r.status, q).toBe(200);
        expect(r.body.items.length, q).toBeGreaterThan(0);
      }
    }
    // record POST/PATCH
    const t = await w.prisma.table.findFirstOrThrow();
    const post = await w.http(`/api/records?tableId=${t.id}`, {
      method: "POST", headers: await w.auth(),
      body: JSON.stringify({ fields: { [t.primaryFieldId]: "零外网期间主写EGRESSNEW1" } }),
    });
    expect(post.status).toBe(201);
    const newId = (await post.json() as { record: { id: string } }).record.id;
    const patch = await w.http(`/api/records/${newId}`, {
      method: "PATCH", headers: await w.auth(),
      body: JSON.stringify({ fields: { [t.primaryFieldId]: "零外网主写改EGRESSNEW2" } }),
    });
    expect(patch.status).toBe(200);
    // kb PUT content
    const doc = await w.prisma.kbDoc.findFirstOrThrow();
    const put = await w.http(`/api/kb/docs/${doc.id}/content`, {
      method: "PUT", headers: await w.auth(),
      body: JSON.stringify({ content: "# x\n\n零外网正文EGRESSKB1", title: "零外网标题" }),
    });
    expect(put.status).toBe(200);
    // 管理状态（health() 不触网）
    const status = await w.http("/api/v1/admin/search/status", { headers: await w.auth() });
    expect(status.status).toBe(200);
    const sb = await status.json();
    expect(sb.embedding.mode).toBe("off");

    // 铁证：整条链没有发起任何一次 fetch（embedding 一次都没调）。
    expect(w.embeddingCalls).toEqual([]);
  });
});

describe("AC-M5-5 B：GX_M5_SEARCH=off（出厂默认）全链零 fetch、不建 search.db", () => {
  let w: S12World;
  beforeAll(async () => {
    w = await setupS12({ mode: "off", label: "egress-gateoff", egress: "failClosed", m5Search: "off" });
  }, 180000);
  afterAll(async () => { await w.cleanup(); });

  it("v1/search 落 404；主写与旧 /api/search 正常；无 search.db；零 fetch", async () => {
    // 主库写一条供旧检索（直接 prisma + nav 同步，不依赖 search.db）。
    const baseId = "egoff_b", tableId = "egoff_t", f0 = "egoff_f0";
    await w.prisma.base.create({ data: { id: baseId, name: "egoff 库", createdBy: "s12-owner" } });
    await w.prisma.member.create({ data: { baseId, userId: "s12-owner", role: "owner" } });
    await w.prisma.table.create({ data: { id: tableId, baseId, name: "egoff 表", primaryFieldId: f0, createdBy: "s12-owner" } });
    await w.prisma.field.create({ data: { id: f0, tableId, name: "主", type: "singleLineText", order: 0 } });
    const post = await w.http(`/api/records?tableId=${tableId}`, {
      method: "POST", headers: await w.auth(),
      body: JSON.stringify({ fields: { [f0]: "门关旧检索词GATEOFF1" } }),
    });
    expect(post.status).toBe(201);

    // 企业检索面不存在：v1/search 404（Hono 404，不触碰 search.db/embedding）。
    const v1 = await w.http(`/api/v1/search?q=GATEOFF1`, { headers: await w.auth() });
    expect(v1.status).toBe(404);
    // 旧 /api/search 仍是 S0 字节链路（off 不摘除）。
    const legacy = await w.http(`/api/search?q=${encodeURIComponent("GATEOFF1")}`, { headers: await w.auth() });
    expect(legacy.status).toBe(200);
    // 主写 + 旧检索后仍未建 search.db（懒初始化门）。
    // 注：prisma 主库 dev.db 与 search.db 不同路径；这里只断言 search.db 缺席。
    const fs = await import("node:fs");
    expect(fs.existsSync(w.searchPath)).toBe(false);

    expect(w.embeddingCalls).toEqual([]);
  });
});

describe("AC-M5-5 C：cloud 显式配置+二次确认后，出网仅朝 baseURL host 的 /v1/embeddings", () => {
  let w: S12World;
  const baseURL = "http://embeddings.s12.internal.test/v1";
  beforeAll(async () => {
    // 出厂姿态：m5Search=on 但 embedding=off（env 不 seed cloud）。可控 fetch 仍是 stub，
    // 一旦切 cloud 只接受 /v1/embeddings，任何非契约方向调用直接抛错（等价出网失败）。
    w = await setupS12({ mode: "off", label: "egress-cloud" });
  }, 180000);
  afterAll(async () => { await w.cleanup(); });

  it("出厂 off 零出网；无确认不切 cloud（409，零出网）；确认后检索出网只打 baseURL host", async () => {
    await w.seedRecord({ primary: "云端出网方向词EGRESSCLOUD1" });
    // 出厂 off 检索：零 fetch。
    const off = await searchOnce(w, "EGRESSCLOUD1");
    expect(off.status).toBe(200);
    expect(w.embeddingCalls).toEqual([]);

    // 第一步：off->cloud 缺 confirmCloud -> 409，配置不生效、不出网。
    const noConfirm = await w.http("/api/v1/admin/embedding/config", {
      method: "PATCH", headers: await w.auth(),
      body: JSON.stringify({ mode: "cloud", baseURL, model: "m1", apiKey: "s12-explicit-key" }),
    });
    expect(noConfirm.status).toBe(409);
    expect(w.embeddingCalls).toEqual([]);

    // 第二步：带 confirmCloud 落库。
    const ok = await w.http("/api/v1/admin/embedding/config", {
      method: "PATCH", headers: await w.auth(),
      body: JSON.stringify({ mode: "cloud", confirmCloud: true, baseURL, model: "m1", apiKey: "s12-explicit-key" }),
    });
    expect(ok.status).toBe(200);
    const mods = await w.modules();
    mods.queryRuntime.resetQueryRuntimeCaches(); // 清 env-off provider 缓存，下查按 db cloud 构造

    // 全量 reindex 让现有实体向量化（stub 仅放行 baseURL 的 /v1/embeddings）。
    const re = await w.http("/api/v1/admin/reindex", { method: "POST", headers: await w.auth(), body: "{}" });
    expect(re.status).toBe(202);
    await mods.reindex.currentReindex();
    expect(w.embeddingCalls.length).toBeGreaterThan(0);

    // 查询出网方向：全部打在 baseURL host 的契约端点，零第三方遥测/CDN。
    w.embeddingCalls.length = 0;
    const r = await searchOnce(w, "EGRESSCLOUD1");
    expect(r.status).toBe(200);
    expect(w.embeddingCalls.length).toBeGreaterThan(0);
    for (const c of w.embeddingCalls) {
      expect(c.host).toBe("embeddings.s12.internal.test");
      expect(c.url).toContain("/v1/embeddings");
      expect(c.url).not.toMatch(/telemetry|analytics|sentry|cdn\./i);
    }
  }, 60000);
});
