// 记录变更历史的**真旁路**验收：开关开启、但历史写库抛错时，业务写必须照常成功。
//
// 为什么单独成文件：本用例要把 record_changes 表临时改名来制造「日志侧必抛」的故障，
// 与常规用例共用同一个临时库的话，一旦中途失败就会把库留在瘸腿状态、污染同文件的兄弟用例。
// 独占一个临时库，故障注入的爆炸半径就只有自己。
//
// 这条是「日志不得拖死业务写」这条硬约束的核心验收点——历史是观测通道，
// 绝不允许出现「日志侧出错 → 保存记录 500」。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OWNER_ID, setupRecordChangesHarness, type RecordChangesHarness } from "./_recordChangesHarness.js";

const currentUserId: string | null = OWNER_ID;
vi.mock("../../auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../auth.js");
  return { ...actual, getUserId: () => Promise.resolve(currentUserId) };
});

let h: RecordChangesHarness;

beforeAll(async () => {
  process.env.GX_RECORD_CHANGES = "on";
  h = await setupRecordChangesHarness();
}, 120_000);

afterAll(async () => {
  await h.teardown();
});

describe("历史写入失败时的旁路语义", () => {
  it("历史表不可写 → 创建/更新仍 201/200 且字段确实落库，异常只告警一次后吞掉", async () => {
    const t = await h.makeTableWithFields();
    // 改名而不是 DROP：可完整还原，不动任何数据，也不需要重建索引。
    await h.prisma.$executeRawUnsafe("ALTER TABLE record_changes RENAME TO record_changes_hidden");
    let id = "";
    try {
      // 创建：必须 201（不是 500），且 fields 真落库
      id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
      const created = await h.prisma.record.findUnique({ where: { id } });
      expect(JSON.parse(created!.fields)[t.fName]).toBe("甲");
      // 更新：必须 200，且新值真落库
      await h.patchRecord(id, { [t.fName]: "乙" });
      const updated = await h.prisma.record.findUnique({ where: { id } });
      expect(JSON.parse(updated!.fields)[t.fName]).toBe("乙");
    } finally {
      await h.prisma.$executeRawUnsafe("ALTER TABLE record_changes_hidden RENAME TO record_changes");
    }
    // 故障窗口内两次主写都成功，但一条历史也没落下（表不在，无处可写）
    expect(await h.prisma.recordChange.count({ where: { recordId: id } })).toBe(0);

    // 还原后历史照常落库：证明改名是可逆的临时故障注入，没有留下后遗症
    const id2 = await h.createRecord(t.tableId, { [t.fName]: "丙" });
    expect(await h.prisma.recordChange.count({ where: { recordId: id2 } })).toBe(1);
  });

  it("物理删记录时清理历史失败 → 物理删照常完成（不阻断清回收站）", async () => {
    const t = await h.makeTableWithFields();
    const id = await h.createRecord(t.tableId, { [t.fName]: "甲" });
    await h.request("DELETE", `/records/${id}`);
    await h.prisma.$executeRawUnsafe("ALTER TABLE record_changes RENAME TO record_changes_hidden");
    try {
      const purge = await h.request("DELETE", `/records/trash/${id}?kind=record`);
      expect(purge.status).toBe(200);
    } finally {
      await h.prisma.$executeRawUnsafe("ALTER TABLE record_changes_hidden RENAME TO record_changes");
    }
    // 记录本体确实被物理删掉了（清理历史失败没有拖住它）
    expect(await h.prisma.record.findUnique({ where: { id } })).toBeNull();
  });
});
