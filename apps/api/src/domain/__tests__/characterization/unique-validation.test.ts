// M1/S0 Characterization：assertUnique 归一行为
//
// 锁 routes/records.ts 的 assertUnique 现状（records.ts:242-269），供 M1 S6 unique 改走
// sidecar 索引后逐格对拍。关键现状（含反直觉项，一律钉死不修正）：
//   - 命中重复抛 HttpError(409)，中文文案含字段名；
//   - 比较是【严格相等】：数字 123 与字符串 "123" 不视为重复；
//   - undefined/null/"" 全部跳过（多个空值不冲突）；
//   - 只检查 findMany(deletedAt:null) 返回的活记录（软删行天然不参与）；
//   - excludeRecordId（PATCH 排除自身）/ excludeRecordIds（批量排除批内）；
//   - 计算字段/系统字段即使 unique=true 也不参与；
//   - 按 fields 数组顺序报告第一个冲突字段。

import { describe, it, expect } from "vitest";
import { assertUnique } from "../../../routes/records.js";
import type { DbTx } from "../../../db.js";
import type { FieldMeta } from "../../types.js";

function field(partial: Partial<FieldMeta> & Pick<FieldMeta, "id" | "name" | "type">): FieldMeta {
  return {
    tableId: "T1",
    order: 0,
    description: "",
    required: false,
    unique: false,
    options: null,
    precision: null,
    maxLength: null,
    defaultNow: false,
    recordFilter: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...partial,
  } as FieldMeta;
}

interface LiveRow {
  id: string;
  // 物理 fields 对象；fake 会 JSON.stringify 落库（真实 prisma 存 JSON 字符串）
  fields: Record<string, unknown>;
}

function fakeDb(rows: LiveRow[]) {
  const calls: unknown[] = [];
  const db = {
    record: {
      findMany: async (args: unknown) => {
        calls.push(args);
        // 镜像 Prisma：返回的 fields 是 JSON 字符串
        return rows.map((r) => ({ id: r.id, fields: JSON.stringify(r.fields) }));
      },
    },
  } as unknown as DbTx;
  return { db, calls };
}

const fCode = field({ id: "F_code", name: "编码", type: "singleLineText", unique: true, order: 0 });
const fNum = field({ id: "F_num", name: "数量", type: "number", unique: true, order: 1 });

describe("assertUnique 命中与放行", () => {
  it("无 unique 字段：直接放行，且不查库", async () => {
    const { db, calls } = fakeDb([{ id: "r1", fields: { F_x: "a" } }]);
    await expect(
      assertUnique("T1", [field({ id: "F_x", name: "X", type: "singleLineText" })], { F_x: "a" }, undefined, undefined, db),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("字符串重复 → 409，文案含字段名与固定中文", async () => {
    const { db } = fakeDb([{ id: "r1", fields: { F_code: "A-1" } }]);
    await expect(assertUnique("T1", [fCode], { F_code: "A-1" }, undefined, undefined, db)).rejects.toMatchObject({
      status: 409,
      message: "字段「编码」要求唯一，该值已存在",
    });
  });

  it("不同值放行", async () => {
    const { db } = fakeDb([{ id: "r1", fields: { F_code: "A-1" } }]);
    await expect(assertUnique("T1", [fCode], { F_code: "A-2" }, undefined, undefined, db)).resolves.toBeUndefined();
  });

  it("【现状怪癖】严格相等：数字 123 与字符串 '123' 不冲突；仅同类型同值才冲突", async () => {
    // 库存字符串 "123"，传入数字 123 → 不相等（不做类型归一）
    {
      const { db } = fakeDb([{ id: "r1", fields: { F_num: "123" } }]);
      await expect(assertUnique("T1", [fNum], { F_num: 123 }, undefined, undefined, db)).resolves.toBeUndefined();
    }
    // 库存数字 123，传入数字 123 → 冲突
    {
      const { db } = fakeDb([{ id: "r1", fields: { F_num: 123 } }]);
      await expect(assertUnique("T1", [fNum], { F_num: 123 }, undefined, undefined, db)).rejects.toMatchObject({ status: 409 });
    }
  });

  it("空值（undefined/null/''）跳过：多条空值互不冲突", async () => {
    const { db } = fakeDb([
      { id: "r1", fields: { F_code: "" } },
      { id: "r2", fields: { F_code: null } },
    ]);
    await expect(assertUnique("T1", [fCode], { F_code: "" }, undefined, undefined, db)).resolves.toBeUndefined();
    await expect(assertUnique("T1", [fCode], { F_code: undefined }, undefined, undefined, db)).resolves.toBeUndefined();
    await expect(assertUnique("T1", [fCode], { F_code: null }, undefined, undefined, db)).resolves.toBeUndefined();
  });
});

describe("排除自身 / 批内", () => {
  it("excludeRecordId：PATCH 时排除自身行，同值放行", async () => {
    const { db } = fakeDb([{ id: "r1", fields: { F_code: "A-1" } }]);
    await expect(assertUnique("T1", [fCode], { F_code: "A-1" }, "r1", undefined, db)).resolves.toBeUndefined();
  });

  it("excludeRecordIds：批量更新排除批内 id，批内共享值不与存量冲突则放行", async () => {
    const { db } = fakeDb([
      { id: "r1", fields: { F_code: "A-1" } },
      { id: "r2", fields: { F_code: "A-1" } },
    ]);
    // r1/r2 都在本批，被整体排除 → 放行
    await expect(
      assertUnique("T1", [fCode], { F_code: "A-1" }, undefined, ["r1", "r2"], db),
    ).resolves.toBeUndefined();
    // 只排除 r1：r2 仍是活记录且同值 → 冲突
    const db2 = fakeDb([
      { id: "r1", fields: { F_code: "A-1" } },
      { id: "r2", fields: { F_code: "A-1" } }],
    ).db;
    await expect(
      assertUnique("T1", [fCode], { F_code: "A-1" }, undefined, ["r1"], db2),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("批外存在同值：即使批内排除，仍与批外存量冲突", async () => {
    const { db } = fakeDb([
      { id: "r1", fields: { F_code: "A-1" } },
      { id: "r9", fields: { F_code: "A-1" } },
    ]);
    await expect(
      assertUnique("T1", [fCode], { F_code: "A-1" }, undefined, ["r1"], db),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("软删与字段范围", () => {
  it("只查 deletedAt:null 活记录（查询 where 现状钉死）", async () => {
    const { db, calls } = fakeDb([]);
    await assertUnique("T1", [fCode], { F_code: "x" }, undefined, undefined, db);
    expect(calls[0]).toMatchObject({
      where: { tableId: "T1", deletedAt: null },
      select: { id: true, fields: true },
    });
  });

  it("计算字段 / 系统字段即使 unique=true 也不参与校验", async () => {
    const formula = field({ id: "F_f", name: "公式", type: "formula", unique: true });
    const sys = field({ id: "F_ct", name: "创建时间", type: "createdTime", unique: true });
    const { db } = fakeDb([{ id: "r1", fields: { F_f: "v", F_ct: "v" } }]);
    await expect(
      assertUnique("T1", [formula, sys], { F_f: "v", F_ct: "v" }, undefined, undefined, db),
    ).resolves.toBeUndefined();
  });

  it("多个 unique 字段：按 fields 数组顺序，第一个与存量冲突的字段报错", async () => {
    const { db } = fakeDb([{ id: "r1", fields: { F_code: "dup", F_num: 9 } }]);
    // fCode(order0) 先冲突
    await expect(
      assertUnique("T1", [fCode, fNum], { F_code: "dup", F_num: 9 }, undefined, undefined, db),
    ).rejects.toThrow("编码");
  });
});
