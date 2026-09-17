// RC-10 字段结构写「交互事务原子性」对抗测试（真迁移临时库，不经 HTTP，直接调 fieldService）。
//
// 覆盖缺陷：createField 建 links/subtable 双向对、updateField 首次补配、deleteField 对称/级联
// 软删，原本是 runWrite（只串行不开事务）+ 模块级裸 prisma 的多步写，中途失败会留下孤立反向
// 占位字段、单向链、半软删。现全部收进单个 withWriteTx，本文件用故障注入证明失败整体回滚。
//
// 故障注入落点：修复版写走 withWriteTx 回调内 tx 委托（与模块级 prisma.<model> 非同一对象）。
// 故同时在内层（包 $transaction 拿 innerTx 委托）与外层（base prisma 委托）布桩、共用一个序号，
// 第 failAt 次命中即 reject、其余走原实现。修复版只触发内层桩；变异回裸 prisma 只触发外层桩——
// 同一用例对两种实现都成立。绝不 mock 被测函数本身。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

type FieldService = typeof import("../fieldService.js");

let tmpDir: string;
let prisma: PrismaClient;
let fieldService: FieldService;
let baseId: string;
let tableA: string;
let tableB: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-rc10-fieldtx-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "p.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  // sidecar flags 默认 off，保持本域测试只验证结构写事务，不引入派生索引噪声。
  process.env.GX_M1_SIDECAR = "off";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  // 动态 import 被测 fieldService：其依赖的 db.ts 会复用上面注入的同一单例。
  fieldService = await import("../fieldService.js");
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.linkRow.deleteMany({});
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.base.deleteMany({});

  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  baseId = base.id;
  const a = await prisma.table.create({
    data: { baseId, name: "A", primaryFieldId: "", createdBy: "u" },
  });
  const btable = await prisma.table.create({
    data: { baseId, name: "B", primaryFieldId: "", createdBy: "u" },
  });
  tableA = a.id;
  tableB = btable.id;
});

const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers) {
    try {
      restore();
    } catch {
      // ignore
    }
  }
  restorers.length = 0;
});

interface ArmOpts {
  model: "field" | "linkRow";
  op: "create" | "update" | "updateMany";
  failAt: number;
}

type AnyFn = (...a: unknown[]) => unknown;

/**
 * 在 innerTx 与 base 两处委托布桩，共享一个序号：第 failAt 次命中该 (model,op) 即 reject，
 * 其余调用走原始实现。
 *
 * 不用 vi.spyOn：Prisma 委托方法是委托自身的自有数据属性（非原型方法），vitest 在
 * mockRestore 时会把它还原成 undefined，污染后续用例（连 happy path 的 base 直写都会报
 * "create is not a function"）。这里改用「保存原函数→手动换属性→finally 显式还原」，
 * 内层 tx 委托每次事务新建、在回调返回前即还原；base 委托登记到 restorers 由 afterEach 还原。
 */
function armFault({ model, op, failAt }: ArmOpts): void {
  let hits = 0;
  const shouldFail = () => {
    hits += 1;
    return hits === failAt;
  };
  const boom = new Error(`INJECTED_${model}_${op}_${failAt}`);

  const wrap = (delegate: Record<string, unknown>): void => {
    const orig = delegate[op] as AnyFn;
    const wrapped: AnyFn = (...args: unknown[]) => {
      if (shouldFail()) return Promise.reject(boom);
      return orig.apply(delegate, args);
    };
    delegate[op] = wrapped;
    restorers.push(() => {
      delegate[op] = orig;
    });
  };

  // 外层：base prisma.<model>.<op>（变异红证：生产改回裸 prisma 时由这里拦截）。
  wrap(prisma[model] as unknown as Record<string, unknown>);

  // 内层：手动包裹 prisma.$transaction，拿到 innerTx 后换其委托方法，回调结束立即还原。
  const client = prisma as unknown as { $transaction: AnyFn };
  const origTransaction = client.$transaction;
  const wrappedTransaction: AnyFn = (arg: unknown, ...rest: unknown[]) => {
    if (typeof arg !== "function") {
      return origTransaction.call(prisma, arg, ...rest);
    }
    return origTransaction.call(
      prisma,
      (async (inner: unknown) => {
        const tx = inner as Prisma.TransactionClient;
        const delegate = tx[model] as unknown as Record<string, unknown>;
        const origInner = delegate[op] as AnyFn;
        const innerWrapped: AnyFn = (...args: unknown[]) => {
          if (shouldFail()) return Promise.reject(boom);
          return origInner.apply(delegate, args);
        };
        delegate[op] = innerWrapped;
        try {
          return await (arg as (t: unknown) => unknown)(inner);
        } finally {
          delegate[op] = origInner;
        }
      }) as never,
    );
  };
  client.$transaction = wrappedTransaction;
  restorers.push(() => {
    client.$transaction = origTransaction;
  });
}

async function fieldCount(tableId: string): Promise<number> {
  return prisma.field.count({ where: { tableId } });
}

// T3/T4 共用：建一对 hm links + A/B 各一条记录 + 一条挂正向字段的 linkRow。
async function makePairWithLink(): Promise<{ forwardId: string; reverseId: string }> {
  const created = await fieldService.createField({
    tableId: tableA, name: "关联B", type: "links", relatedTableId: tableB, relationKind: "hm",
  });
  const forwardId = created.field.id;
  const reverseId = created.reverseField!.id;
  const recA = await prisma.record.create({
    data: { tableId: tableA, fields: "{}", createdBy: "u", updatedBy: "u" },
  });
  const recB = await prisma.record.create({
    data: { tableId: tableB, fields: "{}", createdBy: "u", updatedBy: "u" },
  });
  await prisma.linkRow.create({
    data: { linkFieldId: forwardId, parentRowId: recA.id, childRowId: recB.id, ord: 0 },
  });
  return { forwardId, reverseId };
}

describe("RC-10 createField 建 links 对原子性", () => {
  it("T1 建正向（第 2 次 field.create）失败 → reject，反向占位字段也不存在（无孤立/单向链）", async () => {
    // create 序列：findFirst×2(读) → create(反向占位) → create(正向) → update(互指)
    armFault({ model: "field", op: "create", failAt: 2 });
    await expect(
      fieldService.createField({
        tableId: tableA,
        name: "关联B",
        type: "links",
        relatedTableId: tableB,
        relationKind: "hm",
      }),
    ).rejects.toThrow(/INJECTED/);

    // 三写全部回滚：两张表都不留新字段
    expect(await fieldCount(tableA)).toBe(0);
    expect(await fieldCount(tableB)).toBe(0);
    expect(await prisma.linkRow.count()).toBe(0);
  });

  it("T2 回填互指（第 1 次 field.update）失败 → 正反向两个字段都不存在（全回滚）", async () => {
    armFault({ model: "field", op: "update", failAt: 1 });
    await expect(
      fieldService.createField({
        tableId: tableA,
        name: "关联B",
        type: "links",
        relatedTableId: tableB,
        relationKind: "mm",
      }),
    ).rejects.toThrow(/INJECTED/);

    expect(await fieldCount(tableA)).toBe(0);
    expect(await fieldCount(tableB)).toBe(0);
  });

  it("T4 happy path：双向对正确创建且互指", async () => {    const res = await fieldService.createField({
      tableId: tableA,
      name: "关联B",
      type: "links",
      relatedTableId: tableB,
      relationKind: "hm",
    });
    expect(res.reverseField).toBeTruthy();
    const forward = res.field;
    const reverse = res.reverseField!;

    // 正向：在 A，hm，linkFieldId 指向反向（v1 形态：正向只存 linkFieldId，不落 reverseFieldId）
    expect(forward.tableId).toBe(tableA);
    expect(forward.relationKind).toBe("hm");
    expect(forward.linkFieldId).toBe(reverse.id);
    // 反向：在 B，bt（hm 的反向），isReverse，linkFieldId/reverseFieldId 均互指正向
    expect(reverse.tableId).toBe(tableB);
    expect(reverse.relationKind).toBe("bt");
    expect(reverse.isReverse).toBe(true);
    expect(reverse.linkFieldId).toBe(forward.id);
    expect(reverse.reverseFieldId).toBe(forward.id);

    // 落库行与返回值一致
    const fwdRow = await prisma.field.findUnique({ where: { id: forward.id } });
    const revRow = await prisma.field.findUnique({ where: { id: reverse.id } });
    expect(fwdRow?.linkFieldId).toBe(reverse.id);
    expect(revRow?.linkFieldId).toBe(forward.id);
    expect(revRow?.reverseFieldId).toBe(forward.id);
    expect(await fieldCount(tableA)).toBe(1);
    expect(await fieldCount(tableB)).toBe(1);
  });
});

describe("RC-10 deleteField links 对原子性", () => {
  it("T3 partner 软删之后 linkRow.updateMany 失败 → 本字段与 partner 的 deletedAt 都仍为 null（回滚，不半删）", async () => {
    const { forwardId, reverseId } = await makePairWithLink();

    // delete 序列（links）：field.update(本字段) → field.update(partner) → linkRow.updateMany
    armFault({ model: "linkRow", op: "updateMany", failAt: 1 });
    await expect(fieldService.deleteField(forwardId)).rejects.toThrow(/INJECTED/);

    const fwdAfter = await prisma.field.findUnique({ where: { id: forwardId } });
    const revAfter = await prisma.field.findUnique({ where: { id: reverseId } });
    expect(fwdAfter?.deletedAt).toBeNull();
    expect(revAfter?.deletedAt).toBeNull();
    // linkRow 也未被打标（同一事务回滚）
    const link = await prisma.linkRow.findFirst({ where: { linkFieldId: forwardId } });
    expect(link?.deletedAt).toBeNull();
  });

  it("T4 happy path：删除时两个字段都软删、linkRow 打标", async () => {
    const { forwardId, reverseId } = await makePairWithLink();

    const { deleted } = await fieldService.deleteField(forwardId);
    expect(deleted.sort()).toEqual([forwardId, reverseId].sort());

    const fwdAfter = await prisma.field.findUnique({ where: { id: forwardId } });
    const revAfter = await prisma.field.findUnique({ where: { id: reverseId } });
    expect(fwdAfter?.deletedAt).not.toBeNull();
    expect(revAfter?.deletedAt).not.toBeNull();
    const link = await prisma.linkRow.findFirst({ where: { linkFieldId: forwardId } });
    expect(link?.deletedAt).not.toBeNull();
  });
});

describe("RC-10 updateField 首次补配双向对原子性", () => {
  it("回填互指（第 2 次 field.update）失败 → 主更新与新建反向字段全部回滚", async () => {
    // 先建一个孤立 links 占位字段（无 relatedTableId / linkFieldId）
    const placeholder = await fieldService.createField({
      tableId: tableA,
      name: "待补配",
      type: "links",
    });
    const fieldId = placeholder.field.id;

    // 补配序列：update(主) → create(反向) → update(正向回填) → update(反向互指)；在第 2 次 update 注入。
    armFault({ model: "field", op: "update", failAt: 2 });
    await expect(
      fieldService.updateField(fieldId, { relatedTableId: tableB, relationKind: "hm" }),
    ).rejects.toThrow(/INJECTED/);

    // 主字段回未配对，B 表无孤立反向字段
    const row = await prisma.field.findUnique({ where: { id: fieldId } });
    expect(row?.linkFieldId).toBeNull();
    expect(row?.reverseFieldId).toBeNull();
    expect(await fieldCount(tableB)).toBe(0);
  });
});
