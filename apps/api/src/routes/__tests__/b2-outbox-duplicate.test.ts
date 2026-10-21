// beta.2 S2-API 补盲：复制表 POST /tables/:id/duplicate（在线 oplog 与本地 outbox 双缺路径）。
// on 时同一事务内须落：create_table ×1 + add_field ×N + create（记录）×M + create_view ×1，
// 且全部 pending、entityId/baseId/tableId 正确、顺序与物理因果一致（先建表/字段，再记录，后视图）。
// off（默认）时 local_outbox 零行，复制业务结果与改动前一致。
//
// 夹具用 _realApp 的 "entities" 挂载（tables 路由），身份固定 owner。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupHarness, type Harness, OWNER_ID } from "./_realApp.js";

vi.mock("../../auth.js", () => ({ getUserId: () => Promise.resolve(OWNER_ID) }));

const ENV_KEYS = ["GX_OFFLINE_REPLICA", "GX_OFFLINE_NODE_ID", "GX_OFFLINE_CLIENT_ID"] as const;
type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const s = {} as EnvSnapshot;
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}
async function withReplicaOn<T>(fn: () => Promise<T>): Promise<T> {
  const prev = snapshotEnv();
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_OFFLINE_NODE_ID = "n1";
  process.env.GX_OFFLINE_CLIENT_ID = "c1";
  try {
    return await fn();
  } finally {
    restoreEnv(prev);
  }
}

let h: Harness;
let baseId = "";

beforeAll(async () => {
  h = await setupHarness("gx-b2-outbox-dup-", "entities");
  baseId = await h.makeBase();
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await h.teardown();
});

/** 造一张含 主字段 + 额外「城市」字段、2 行记录的源表（makeTable 已带一个「名称」主字段与默认视图）。 */
async function seedSourceTable(
  targetBase: string = baseId,
  name: string = "城市表",
): Promise<{ tableId: string; pf: string; city: string }> {
  const t = await h.makeTable(targetBase, name);
  const city = (await h.prisma.field.create({
    data: { tableId: t.id, name: "城市", type: "singleLineText", order: 1 },
  })).id;
  await h.prisma.record.create({
    data: { tableId: t.id, fields: JSON.stringify({ [t.primaryFieldId]: "甲", [city]: "北京" }), createdBy: OWNER_ID, updatedBy: OWNER_ID },
  });
  await h.prisma.record.create({
    data: { tableId: t.id, fields: JSON.stringify({ [t.primaryFieldId]: "乙", [city]: "上海" }), createdBy: OWNER_ID, updatedBy: OWNER_ID },
  });
  return { tableId: t.id, pf: t.primaryFieldId, city };
}

/** 取属于某张（复制出的）表的 outbox 行（按 payload.tableId 过滤，结构/记录轨都带该键）。 */
async function rowsForTable(copyTableId: string) {
  const all = await h.prisma.localOutbox.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return all.filter((r) => {
    try {
      const p = JSON.parse(r.payload) as { tableId?: string };
      return p.tableId === copyTableId;
    } catch {
      return false;
    }
  });
}

describe("复制表 local_outbox 切面", () => {
  it("on：含 2 字段/2 行的表复制 -> create_table + 2 add_field + 2 record create + create_view 全 pending", () =>
    withReplicaOn(async () => {
      const src = await seedSourceTable();

      const res = await h.request("POST", `/tables/${src.tableId}/duplicate`, { withData: true });
      expect(res.status).toBe(201);
      const body = await res.json();
      const copyId = body.table.id as string;
      expect(copyId).toBeTruthy();
      expect(copyId).not.toBe(src.tableId);

      const rows = await rowsForTable(copyId);
      // 多集合断言（不依赖同事务内同毫秒的 createdAt/cuid 次序）：
      // 建表 + 2 字段 + 主字段设置 + 2 记录 + 视图。
      expect(rows.map((r) => `${r.entityType}:${r.op}`).sort()).toEqual(
        [
          "table:create_table",
          "field:add_field",
          "field:add_field",
          "table:update_table_settings",
          "record:create",
          "record:create",
          "view:create_view",
        ].sort(),
      );

      // 因果顺序由该表 table_schema 版本钟保证（记录轨用各自 per-entity 钟，不参与）：
      // create_table(0) -> add_field(1) -> add_field(2) -> update_table_settings(3) -> create_view(4)。
      const structInOrder = rows
        .filter((r) => r.entityType !== "record")
        .sort((a, b) => Number(a.baseVersion - b.baseVersion));
      expect(structInOrder.map((r) => r.op)).toEqual([
        "create_table", "add_field", "add_field", "update_table_settings", "create_view",
      ]);
      expect(structInOrder.map((r) => r.baseVersion)).toEqual([0n, 1n, 2n, 3n, 4n]);

      for (const r of rows) {
        expect(r.status).toBe("pending");
        expect(r.nodeId).toBe("n1");
        expect(r.baseId).toBe(baseId);
      }

      // create_table：entityId=新表 id，payload 带 name 且 withDefaults=false（裸建表 + 逐字段）。
      const ct = rows.find((r) => r.op === "create_table")!;
      expect(ct.entityType).toBe("table");
      expect(ct.entityId).toBe(copyId);
      const ctP = JSON.parse(ct.payload) as { name: string; withDefaults: boolean };
      expect(ctP.name).toBe("城市表 副本");
      expect(ctP.withDefaults).toBe(false);

      // add_field：新字段 id（不同于源字段 id），payload 仅 tableId/name/type。
      const adds = rows.filter((r) => r.op === "add_field");
      const addNames = adds.map((r) => (JSON.parse(r.payload) as { name: string }).name).sort();
      // 两边都按默认 Unicode 码位排序后比较（U+540D「名」< U+57CE「城」），不依赖字段物理次序。
      expect(addNames).toEqual(["名称", "城市"]);
      for (const a of adds) {
        const p = JSON.parse(a.payload) as { tableId: string; type: string };
        expect(p.tableId).toBe(copyId);
        expect(p.type).toBe("singleLineText");
        // 新字段确实建在复制表上且 id 与源字段不同。
        const f = await h.prisma.field.findUniqueOrThrow({ where: { id: a.entityId } });
        expect(f.tableId).toBe(copyId);
        expect([src.pf, src.city]).not.toContain(a.entityId);
      }

      // update_table_settings：主字段被复制时须有一条，payload.primaryFieldId = 新表「名称」字段 id
      // （≠ 源主字段 id），且该字段确为新表活字段；顺序在 add_field 之后（baseVersion=3 已在上方校验）。
      const settings = rows.filter((r) => r.op === "update_table_settings");
      expect(settings).toHaveLength(1);
      const st = settings[0]!;
      expect(st.entityType).toBe("table");
      expect(st.entityId).toBe(copyId);
      const stP = JSON.parse(st.payload) as { primaryFieldId: string };
      const newNameField = adds.find(
        (a) => (JSON.parse(a.payload) as { name: string }).name === "名称",
      )!;
      expect(stP.primaryFieldId).toBe(newNameField.entityId);
      expect(stP.primaryFieldId).not.toBe(src.pf);
      const copiedTable = await h.prisma.table.findUniqueOrThrow({ where: { id: copyId } });
      expect(copiedTable.primaryFieldId).toBe(stP.primaryFieldId);

      // record create：2 条，changes 覆盖复制到的新字段值。
      const recRows = rows.filter((r) => r.entityType === "record" && r.op === "create");
      expect(recRows).toHaveLength(2);
      const copiedRecords = await h.prisma.record.findMany({
        where: { tableId: copyId, deletedAt: null },
        select: { id: true },
      });
      const copiedIds = new Set(copiedRecords.map((r) => r.id));
      const seenNames = new Set<string>();
      for (const r of recRows) {
        expect(copiedIds.has(r.entityId)).toBe(true);
        const p = JSON.parse(r.payload) as {
          changes: { fieldId: string; fieldName: string; before: null; after: unknown }[];
        };
        expect(p.changes).toHaveLength(2);
        const nameChange = p.changes.find((c) => c.fieldName === "名称")!;
        seenNames.add(String(nameChange.after));
        expect(nameChange.before).toBeNull();
      }
      expect(seenNames).toEqual(new Set(["甲", "乙"]));

      // create_view：复制固定新建一个网格视图（不复制源视图）。
      const cv = rows.find((r) => r.op === "create_view")!;
      expect(cv.entityType).toBe("view");
      const cvP = JSON.parse(cv.payload) as { name: string; type: string; tableId: string };
      expect(cvP).toMatchObject({ name: "网格视图", type: "grid", tableId: copyId });
      const v = await h.prisma.view.findUniqueOrThrow({ where: { id: cv.entityId } });
      expect(v.tableId).toBe(copyId);
    }));

  it("on：源表无有效主字段（primary 解析为空/非新表字段）时不发 update_table_settings", () =>
    withReplicaOn(async () => {
      // 走服务建表（createTable 同步 nav 节点 + owner 策略投影，过 requireSchemaDesign），
      // 得到一张带一个「名称」字段的表；再仅把源表主字段指针悬空（列仍在）。duplicate 时
      // idMap.get("") 为 undefined -> fallback fields[0].id 取到的是【源字段旧 id】，不是新表
      // 活字段；切面须据此跳过，不发会被回放端判 400 的空/悬挂主字段 op。
      const t = await h.makeTable(baseId, "无主字段表");
      await h.prisma.table.update({ where: { id: t.id }, data: { primaryFieldId: "" } });

      const res = await h.request("POST", `/tables/${t.id}/duplicate`);
      expect(res.status).toBe(201);
      const copyId = ((await res.json()) as { table: { id: string } }).table.id;

      const rows = await rowsForTable(copyId);
      expect(rows.some((r) => r.op === "update_table_settings")).toBe(false);
      // 字段仍被正常复制（一条 add_field，新 id），create_table/create_view 也在。
      const add = rows.filter((r) => r.op === "add_field");
      expect(add).toHaveLength(1);
      expect(add[0]!.entityId).not.toBe(t.primaryFieldId);
      expect(rows.map((r) => r.op).sort()).toEqual(
        ["add_field", "create_table", "create_view"].sort(),
      );
    }));

  it("off（默认）：复制业务照常完成（表/字段/2 行/视图齐全），local_outbox 零行", async () => {
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      // 独立 base：避免与上面 on 用例已建的「城市表」同库名唯一冲突（409），也隔离 outbox 计数。
      // 传唯一名（makeBase 默认名 "b" 与 beforeAll 已建库冲突，会 409）。
      const offBase = await h.makeBase("b-off");
      const src = await seedSourceTable(offBase, "城市表-off");
      const before = await h.prisma.localOutbox.count();

      const res = await h.request("POST", `/tables/${src.tableId}/duplicate`, { withData: true });
      expect(res.status).toBe(201);
      const copyId = ((await res.json()) as { table: { id: string } }).table.id;

      // 业务结果与改动前一致：字段 2、活记录 2、视图 1。
      expect(await h.prisma.field.count({ where: { tableId: copyId, deletedAt: null } })).toBe(2);
      expect(await h.prisma.record.count({ where: { tableId: copyId, deletedAt: null } })).toBe(2);
      expect(await h.prisma.view.count({ where: { tableId: copyId } })).toBe(1);

      expect(await h.prisma.localOutbox.count()).toBe(before);
      expect((await rowsForTable(copyId))).toHaveLength(0);
    } finally {
      restoreEnv(prev);
    }
  });
});
