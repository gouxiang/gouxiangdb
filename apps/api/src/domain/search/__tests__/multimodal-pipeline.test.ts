// #563 多模态管线串联：附件字段 dataURL -> extractEntity -> applyUpsert ->
// provider.embedMultimodal 收到图片，且向量写入 vec_chunks。真临时主库 + 真临时 search.db，
// 只 mock provider（记录入参 images，不触外网）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MultimodalEmbedItem } from "@gx/shared-types";
import type { EmbeddingHealth } from "../embedding/types.js";
import {
  makeIndexerHarness,
  seedTable,
  seedRecord,
  enqueue,
  type IndexerHarness,
} from "./indexerHarness.js";
import { extractEntity } from "../entityExtract.js";
import { applyUpsert } from "../indexerDerive.js";

let h: IndexerHarness;
let tableId = "";

const PNG = "data:image/png;base64,AA";
const JPG = "data:image/jpeg;base64,BB";

/** 记录多模态入参的 mock provider。 */
function mockProvider() {
  const received: MultimodalEmbedItem[] = [];
  return {
    received,
    provider: {
      mode: "cloud" as const,
      model: "doubao-embedding-vision",
      dim: 0,
      batchSize: 64,
      embed: async (texts: readonly string[]) =>
        texts.map(() => new Float32Array(3)),
      embedMultimodal: async (items: readonly MultimodalEmbedItem[]) => {
        received.push(...items);
        return items.map(() => new Float32Array(3));
      },
      health: async (): Promise<EmbeddingHealth> => ({ ok: true }),
      dispose: async () => undefined,
    },
  };
}

beforeAll(async () => {
  h = await makeIndexerHarness("gx-563-pipe-");
  const seeded = await seedTable(h, "mp", [
    { id: "f_name", name: "名称", type: "singleLineText", order: 0 },
    { id: "f_pic", name: "图片", type: "attachment", order: 1 },
  ]);
  tableId = seeded.tableId;
  await h.prisma.table.update({
    where: { id: tableId },
    data: { primaryFieldId: "f_name" },
  });
  await seedRecord(h, tableId, "r1", {
    f_name: "带图记录",
    f_pic: [
      { url: PNG, name: "a.png" },
      { url: JPG, name: "b.jpg" },
    ],
  });
  await enqueue(h, { entityType: "record", entityId: "r1", op: "upsert", version: 1n });
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("附件图片流入多模态向量化", () => {
  it("provider.embedMultimodal 收到附件图片，向量落 vec_chunks", async () => {
    const store = h.openStore("mm");
    const mp = mockProvider();

    const ev = await h.prisma.changeEvent.findFirstOrThrow({
      where: { entityId: "r1" },
    });
    const entity = await extractEntity(h.prisma, ev, 50);
    expect(entity.present).toBe(true);

    const summary = await applyUpsert(store, entity, {
      workspaceId: "ws_default",
      mode: "cloud",
      provider: mp.provider,
    });

    // 图片 chunk（附件字段）被多模态向量化：收到的 item 里有图片。
    const imageItems = mp.received.filter((it) => it.images.length > 0);
    expect(imageItems).toHaveLength(1);
    expect(imageItems[0]!.images).toEqual([PNG, JPG]);
    // identity + 名称字段 + 图片字段共 3 个向量写入（图片项仍只有 1）。
    expect(summary.vecWritten).toBe(3);
    expect(summary.vecDebt).toBe(0);
  });
});
