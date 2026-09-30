// #563 以图搜图编排级测试（真迁移主库 + 真 vec0 search.db，仅 mock 多模态 provider）。
//
// 覆盖：
//  - 纯图查询（空 q + images）：不被 browse 短路，走 provider.embedMultimodal，mode=vector 且有召回；
//  - 图文查询：embedMultimodal 收到 {text,images}；
//  - provider 无多模态能力但带图：安静退回纯文本 embed（不报错、不标降级）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueryHarness, querySeed, type QueryHarness } from "./queryHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";
import { executeUnifiedSearch } from "../query.js";
import { buildQueryRuntime } from "../queryRuntime.js";
import { deterministicCloudProvider } from "./queryHarness.js";
import type { SearchStore } from "../searchStore.js";
import type { EmbeddingProvider } from "../embedding/types.js";
import type { QueryRuntimeDeps } from "../queryTypes.js";

let h: QueryHarness;
let store: SearchStore;
const U = "u_img";
const B = "img_base";
const T = "img_table";
const N = `nav_table_${T}`;
const NB = `nav_base_${B}`;
const PNG = "data:image/png;base64,AA";

beforeAll(async () => {
  h = await makeQueryHarness("gx-563-img-");
  store = h.openStore("img", true);
  await h.prisma.user.create({
    data: { id: U, email: "img@x.com", displayName: "r", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" },
  });
  await h.prisma.base.create({ data: { id: B, name: "图片库", createdBy: "owner" } });
  await h.prisma.table.create({ data: { id: T, baseId: B, name: "图片表", primaryFieldId: "img_f0", createdBy: "owner" } });
  await h.prisma.field.create({ data: { id: "img_f0", tableId: T, name: "名称", type: "singleLineText", order: 0 } });
  await h.prisma.field.create({ data: { id: "img_f1", tableId: T, name: "图片", type: "attachment", order: 1 } });
  await querySeed.createNavNodes(h.prisma, [
    { id: NB, kind: "base", resourceType: "base", resourceId: B, parentId: null },
    { id: N, kind: "table", resourceType: "table", resourceId: T, parentId: NB },
  ]);
  await querySeed.createPolicies(h.prisma, [
    { id: "img_p", nodeId: N, subjectType: "user", subjectId: U, actions: "r" },
  ]);

  // 带图记录入索引（多模态 provider）。
  const provider = deterministicCloudProvider({ dim: 3, multimodal: true }) as unknown as EmbeddingProvider;
  await h.prisma.record.create({
    data: { id: "img_r1", tableId: T, createdBy: "owner", updatedBy: "owner", fields: JSON.stringify({
      img_f0: "样品记录", img_f1: [{ url: PNG, name: "a.png" }],
    }) },
  });
  const entity = await extractEntity(h.prisma, { entityType: "record", entityId: "img_r1", version: 1n }, 50);
  await applyUpsert(store, entity, { workspaceId: "ws_default", mode: "cloud", provider });
}, 120000);

afterAll(async () => {
  store?.close();
  await h.cleanup();
});

async function depsWith(provider: EmbeddingProvider): Promise<QueryRuntimeDeps> {
  const { deps } = await buildQueryRuntime(U, "all", {
    prisma: h.prisma, env: process.env, dataDir: h.tmpDir, appDir: process.cwd(),
    jwtSecret: "x", store, provider,
  });
  return deps;
}

describe("以图搜图", () => {
  it("纯图查询：mode=vector，embedMultimodal 被调用，召回带图记录", async () => {
    const mp = deterministicCloudProvider({ dim: 3, multimodal: true });
    const res = await executeUnifiedSearch(
      await depsWith(mp as unknown as EmbeddingProvider),
      { q: "", images: [PNG], type: "all", mode: "auto" },
    );
    expect(res.mode).toBe("vector");
    expect(mp.mmCalls).toHaveLength(1);
    expect(mp.mmCalls[0]!.images).toEqual([PNG]);
    expect(res.items.map((i) => i.entityId)).toContain("img_r1");
  });

  it("图文查询：embedMultimodal 收到文本与图片", async () => {
    const mp = deterministicCloudProvider({ dim: 3, multimodal: true });
    const res = await executeUnifiedSearch(
      await depsWith(mp as unknown as EmbeddingProvider),
      { q: "样品", images: [PNG], type: "all", mode: "auto" },
    );
    expect(mp.mmCalls[0]!.text).toBe("样品");
    expect(mp.mmCalls[0]!.images).toEqual([PNG]);
    expect(res.items.length).toBeGreaterThan(0);
  });

  it("带图但 provider 无多模态能力：退回纯文本 embed，不报错", async () => {
    const tp = deterministicCloudProvider({ dim: 3 }); // 无 embedMultimodal
    const res = await executeUnifiedSearch(
      await depsWith(tp as unknown as EmbeddingProvider),
      { q: "样品", images: [PNG], type: "all", mode: "auto" },
    );
    expect(tp.calls.length).toBeGreaterThan(0); // 走了纯文本
    expect((tp as unknown as { embedMultimodal?: unknown }).embedMultimodal).toBeUndefined();
    expect(tp.mmCalls).toEqual([]);
    expect(res.items.length).toBeGreaterThan(0);
  });
});
