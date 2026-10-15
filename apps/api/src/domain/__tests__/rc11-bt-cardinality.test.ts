// RC-11 多对一（bt）基数约束：正向 links 字段 relationKind=bt 时，一条记录只能关联 1 条目标。
// 旧实现 slice(0,1) 静默丢弃多余目标（调用方以为写了 N 条实际只落 1 条，数据丢失无感知）；
// 现多目标必须明确 400，单目标正常。经公共入口 applyFieldWrites 走真实 writeLinks 分支（不 mock 它）。

import { describe, expect, it } from "vitest";
import { applyFieldWrites } from "../recordWrite.js";
import type { FieldMeta } from "../types.js";
import type { DbTx } from "../../db.js";

function linkField(partial: Partial<FieldMeta>): FieldMeta {
  return {
    id: "f_link",
    tableId: "tblA",
    name: "父项",
    type: "links",
    order: 0,
    required: false,
    unique: false,
    options: null,
    precision: null,
    maxLength: null,
    defaultNow: false,
    linkFieldId: null,
    relatedTableId: "tblB",
    relationKind: "bt",
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    recordFilter: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    description: "",
    ...partial,
  } as FieldMeta;
}

/** 最小内存 DbTx：只实现 writeLinks 正向分支会触达的方法；任何额外调用立即暴露。 */
function fakeDb(opts: { ownedTargetIds: string[]; onCreate?: () => void }): DbTx {
  const calls: string[] = [];
  return {
    record: {
      // 越权校验：返回调用方声明为「属于关联表」的目标
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        calls.push("record.findMany");
        return where.id.in
          .filter((id) => opts.ownedTargetIds.includes(id))
          .map((id) => ({ id }));
      },
    },
    linkRow: {
      deleteMany: async () => {
        calls.push("linkRow.deleteMany");
        return { count: 0 };
      },
      create: async (args: { data: { childRowId: string } }) => {
        calls.push("linkRow.create");
        opts.onCreate?.();
        return args.data as never;
      },
    },
  } as unknown as DbTx;
}

describe("RC-11 bt（多对一）正向字段基数约束", () => {
  it("传 >1 目标 → HttpError 400，文案含「多对一」与「只能关联 1 条」，且不写任何 linkRow", async () => {
    let creates = 0;
    const db = fakeDb({ ownedTargetIds: ["b1", "b2"], onCreate: () => { creates += 1; } });
    const f = linkField({ relationKind: "bt" });

    await expect(
      applyFieldWrites("tblA", "a1", { f_link: ["b1", "b2"] }, [f], db),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      applyFieldWrites("tblA", "a1", { f_link: ["b1", "b2"] }, [f], db),
    ).rejects.toThrow(/多对一/);

    await expect(
      applyFieldWrites("tblA", "a1", { f_link: ["b1", "b2"] }, [f], db),
    ).rejects.toThrow(/只能关联 1 条/);

    expect(creates).toBe(0);
  });

  it("单目标正常：不抛错，清旧链后新建 1 条 linkRow", async () => {
    const created: Array<{ parentRowId: string; childRowId: string }> = [];
    const db = {
      record: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
      },
      linkRow: {
        deleteMany: async () => ({ count: 0 }),
        create: async (args: { data: { parentRowId: string; childRowId: string } }) => {
          created.push(args.data);
          return args.data as never;
        },
      },
    } as unknown as DbTx;

    const f = linkField({ relationKind: "bt" });
    // links 走 linkRow、无物理字段，applyFieldWrites 返回空字段 diff（YN1 起返回 {changes}）。
    await expect(
      applyFieldWrites("tblA", "a1", { f_link: ["b1"] }, [f], db),
    ).resolves.toEqual({ changes: [] });

    expect(created).toHaveLength(1);
    // 正向字段：源记录为 parent，目标为 child
    expect(created[0]).toMatchObject({ parentRowId: "a1", childRowId: "b1" });
  });

  it("对照：mm（多对多）传多目标不报错，逐条落 linkRow", async () => {
    const created: string[] = [];
    const db = {
      record: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
      },
      linkRow: {
        deleteMany: async () => ({ count: 0 }),
        create: async (args: { data: { childRowId: string } }) => {
          created.push(args.data.childRowId);
          return args.data as never;
        },
      },
    } as unknown as DbTx;

    const f = linkField({ relationKind: "mm" });
    await expect(
      applyFieldWrites("tblA", "a1", { f_link: ["b1", "b2", "b3"] }, [f], db),
    ).resolves.toEqual({ changes: [] });
    expect(created).toEqual(["b1", "b2", "b3"]);
  });
});
