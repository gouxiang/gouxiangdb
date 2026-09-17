// M5/S12 AC-M5-1① vec0 扩展加载失败降级（坏 .so：dlopen/dlsym 失败）——独立进程文件。
//
// GX_VEC_EXT_PATH 是进程级环境变量，坏扩展世界与正常 cloud 世界不能同处一个测试文件（会互相
// 污染 vec0 加载态），故本片独占一个 vitest 进程：
//   - 装配时放一个内容错误的 vec0.dylib 并经 GX_VEC_EXT_PATH 指定（H7：文件恒名，不改名）；
//   - loadVec0 可捕获失败 -> vecAvailable=false -> vec_chunks 永不建立，auto 检索标
//     vec_unavailable 并以 fts/like 200 服役；
//   - 主应用写链路全程不受扩展故障影响；进程不 crash（H8）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupS12, searchOnce, type S12World } from "./m5-s12-harness.js";

let w: S12World;

beforeAll(async () => {
  w = await setupS12({ mode: "cloud", label: "degrade-badvec", fakeVecExt: true });
}, 180000);
afterAll(async () => { await w.cleanup(); });

describe("AC-M5-1① vec0 坏扩展：vec_unavailable + fts/like 200 + 主写可用", () => {
  it("坏二进制 vec0：auto 标 vec_unavailable、200 关键词命中、counts.vec=null", async () => {
    const t = await w.seedRecord({ primary: "扩展损坏唯一词BADSO1" });
    expect(w.counts().vec).toBeNull(); // vec_chunks 未建立（只 FTS 派生）

    const r = await searchOnce(w, "BADSO1");
    expect(r.status).toBe(200);
    expect(["fts", "like"]).toContain(r.body.mode);
    expect(r.body.degraded).toContain("vec_unavailable");
    expect(r.body.items.map((i: { entityId: string }) => i.entityId)).toContain(t.recordId);

    // 强制 vector 也回退关键词并标注（不报错、不 500）。
    const rv = await searchOnce(w, "BADSO1", "&mode=vector");
    expect(rv.status).toBe(200);
    expect(rv.body.degraded).toContain("vec_unavailable");
    expect(rv.body.items.map((i: { entityId: string }) => i.entityId)).toContain(t.recordId);

    // 故障期间 embedding 不被调用（vec0 门先于 provider 返回，零外网）。
    expect(w.embeddingCalls).toEqual([]);
  });

  it("扩展故障全程主写不受影响：record POST 201（主库事务+outbox，不碰 vec0），既有检索仍 200", async () => {
    const t = await w.seedRecord({ primary: "坏扩展主写基线词BADSOBASE" });
    const post = await w.http(`/api/records?tableId=${t.tableId}`, {
      method: "POST", headers: await w.auth(),
      body: JSON.stringify({ fields: { [t.primaryField]: "坏扩展期间新主写BADSONEW1" } }),
    });
    expect(post.status).toBe(201);
    const newRec = await w.prisma.record.findFirst({ where: { tableId: t.tableId }, orderBy: { createdAt: "desc" } });
    expect(newRec).toBeTruthy(); // 主写已落库
    // 检索链路不依赖 vec0：既有派生内容仍以 fts/like 服役、200。
    const r = await searchOnce(w, "BADSOBASE");
    expect(r.status).toBe(200);
    expect(["fts", "like"]).toContain(r.body.mode);
    expect(r.body.items.map((i: { entityId: string }) => i.entityId)).toContain(t.recordId);
  });
});
