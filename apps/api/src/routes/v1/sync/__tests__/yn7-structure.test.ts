// YN7 结构同步（table/field/view）op 词表 + 结构版本门 + 回放原语 契约测试
// （真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock）。
// 设计权威：DESIGN-OFFLINE-SYNC §19.1（词表）、§19.2（table_schema 结构版本/baseSchemaVersion 门）、
//   §19.3（回放只走现有领域写原语、跑现有校验、结构分叉人工）、§19.4（manage_schema 当前权限重判）、
//   §8.4（保留离线 cuid）、§8.6（在线结构写也推进结构版本）、§20.1（注册表分派）、§15.2（YN7 验收）。
//
// 本用例覆盖 #787（happy path 回放 + 版本门 + 权限 + 幂等）；结构分叉人工 resolve / restore /
// reorder / 类型变更存量数据可转换校验在 #788。
//
// 验收映射：
//   A 探针阶段刷到 YN7。
//   B create_table 回放：保留离线 cuid、主字段「名称」+默认网格视图原子落地、结构版本 1、oplog 落 table。
//   C add_field / create_link_field 回放：字段（含正/反两字段）落地、结构版本随每条结构 op +1。
//   D alter_field（changed 子集）/ rename_table / update_table_settings 回放。
//   E create_view / alter_view / delete_view 回放（至少保留一个视图约束生效）。
//   F 结构版本门：baseSchemaVersion 落后 → conflict=SYNC_STRUCTURE_VERSION_CONFLICT，主数据不生效。
//   G 幂等：同一 clientOpId 重放回同一回执，结构只应用一次、版本不二次推进。
//   H 当前权限：有数据 c/r/u/d 但无 manage_schema 的受限成员推结构 op → rejected=PERMISSION_REVOKED。
//   I 未登记结构 op（restore_table）→ rejected=OP_UNSUPPORTED；payload 非法 → rejected=MALFORMED。
//   J 批内部分接受：一条非法被拒，其余照常 accepted。
//   K 在线结构写切面（§8.6）：开同步时在线建表推进 table_schema 钟 + 落 __server__ oplog。
//   L pull 同流下发结构 op（客户端据此维护 schemaVersion）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn7_owner";
const ED = "yn7_editor";
const CLIENT = "yn7-client-owner";
const C_ED = "yn7-client-ed";

let baseId = "";

interface OpResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected" | "quarantined";
  reasonCode?: string;
  reasonDetail?: string;
  seq?: string;
  newVersion?: string;
  entityId?: string;
  serverVersion?: string;
}
interface PushResp {
  status: number;
  code?: string;
  results?: OpResult[];
}

function sop(
  clientOpId: string,
  entityType: "table" | "field" | "view",
  op: string,
  entityId: string,
  baseVersion: string,
  payload: Record<string, unknown>,
) {
  return { clientOpId, entityType, entityId, op, baseVersion, payload };
}

async function auth(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

async function pushAs(user: string, clientId: string, ops: unknown[]): Promise<PushResp> {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: await auth(user),
    body: JSON.stringify({ baseId, clientId, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code, results: body.result?.results };
}

async function putScopes(items: unknown[]): Promise<Response> {
  return h.app.request("/api/v1/org/library-scopes", {
    method: "PUT",
    headers: await auth(OWNER),
    body: JSON.stringify({ roleId: "role_restricted", items }),
  });
}

let pushSeq = 0;
function cid(prefix: string): string {
  pushSeq += 1;
  return `${prefix}-${pushSeq}`;
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(ED);
  await h.grantSystemRole(OWNER, "owner");
  await h.grantSystemRole(ED, "restricted");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const base = await createBase({ name: "yn7", withStarter: false }, OWNER);
  baseId = base.id;

  // 受限成员：对本 base 有库视野 + 表级数据 c/r/u/d（可写记录），但【无】manage_schema。
  const scopes = await putScopes([
    {
      libraryKind: "base",
      libraryId: baseId,
      visible: true,
      canManage: false,
      config: { tables: {}, fields: {} },
    },
  ]);
  expect(scopes.status).toBe(200);

  // ED 订阅（建立成员关系，库门 enter 可过；结构动作仍应被 manage_schema 拦下）。
  const sub = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST",
    headers: await auth(ED),
    body: JSON.stringify({ clientId: C_ED, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 探针", () => {
  it("on + 登录 → phase YN7", async () => {
    const r = await h.app.request("/api/v1/sync", { headers: await h.auth(OWNER) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.phase).toBe("YN8");
  });
});

describe("B/C/D/E. 结构 op 回放 happy path（保留离线 id + 结构版本逐 op +1）", () => {
  // 离线端预生成的 cuid（回放保留为主键，§8.4）。
  const newTableId = "tbl_yn7_offline_a";
  const refTableId = "tbl_yn7_ref_b";
  const textFieldId = "fld_yn7_text";
  const fwdLinkId = "fld_yn7_link_fwd";
  const revLinkId = "fld_yn7_link_rev";
  const viewId = "view_yn7_one";
  let schemaVer = 0n;

  it("B create_table → accepted，表/主字段/默认视图原子落地、保留 cuid、版本 1", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("ct"), "table", "create_table", newTableId, "0", { name: "离线建表A", withDefaults: true }),
    ]);
    expect(r.status).toBe(200);
    const res = r.results![0]!;
    expect(res.status).toBe("accepted");
    expect(res.entityId).toBe(newTableId);
    expect(res.newVersion).toBe("1");
    schemaVer = 1n;

    const t = await h.prisma.table.findUnique({ where: { id: newTableId } });
    expect(t).not.toBeNull();
    expect(t!.name).toBe("离线建表A");
    expect(t!.deletedAt).toBeNull();
    // 主字段「名称」+ withDefaults 四默认字段，共 5 个活字段；默认网格视图 1 个。
    const fields = await h.prisma.field.findMany({ where: { tableId: newTableId, deletedAt: null } });
    expect(fields.map((f) => f.name).sort()).toEqual(
      ["名称", "数量", "日期", "状态", "备注"].sort(),
    );
    expect(t!.primaryFieldId).toBe(fields.find((f) => f.name === "名称")!.id);
    const views = await h.prisma.view.findMany({ where: { tableId: newTableId } });
    expect(views).toHaveLength(1);
  });

  it("C add_field → accepted，字段落地、结构版本 +1", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("af"), "field", "add_field", textFieldId, schemaVer.toString(), {
        tableId: newTableId, name: "离线文本", type: "text",
      }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    expect(r.results![0]!.newVersion).toBe(schemaVer.toString());
    const f = await h.prisma.field.findUnique({ where: { id: textFieldId } });
    expect(f).not.toBeNull();
    expect(f!.name).toBe("离线文本");
    expect(f!.type).toBe("text");
  });

  it("C create_link_field → accepted，正/反两字段原子落地（跨两表）", async () => {
    // 先离线建被关联表 refTableId（它是一张独立的新表，独立结构钟，baseVersion=0）。
    const r0 = await pushAs(OWNER, CLIENT, [
      sop(cid("ct"), "table", "create_table", refTableId, "0", { name: "被关联表B" }),
    ]);
    expect(r0.results![0]!.status).toBe("accepted");

    // 在 newTableId 上建一条指向 refTableId 的 hm 关联（正/反字段都带离线 cuid）。
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("clf"), "field", "create_link_field", fwdLinkId, schemaVer.toString(), {
        tableId: newTableId, name: "关联B", type: "links",
        relatedTableId: refTableId, relationKind: "hm", reverseFieldId: revLinkId,
      }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    const fwd = await h.prisma.field.findUnique({ where: { id: fwdLinkId } });
    const rev = await h.prisma.field.findUnique({ where: { id: revLinkId } });
    expect(fwd).not.toBeNull();
    expect(rev).not.toBeNull();
    expect(fwd!.tableId).toBe(newTableId);
    expect(fwd!.relatedTableId).toBe(refTableId);
    expect(fwd!.linkFieldId).toBe(revLinkId);
    expect(rev!.tableId).toBe(refTableId);
    expect(rev!.isReverse).toBe(true);
  });

  it("D alter_field changed 子集 → accepted，仅改名、结构版本 +1", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("alf"), "field", "alter_field", textFieldId, schemaVer.toString(), {
        changed: { name: "离线文本改名" },
      }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    const f = await h.prisma.field.findUnique({ where: { id: textFieldId } });
    expect(f!.name).toBe("离线文本改名");
  });

  it("D rename_table / update_table_settings → accepted", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("rt"), "table", "rename_table", newTableId, schemaVer.toString(), { name: "离线建表A改" }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    const t = await h.prisma.table.findUnique({ where: { id: newTableId } });
    expect(t!.name).toBe("离线建表A改");
    // 表结构版本钟按表独立累计（对 newTableId 已多次 +1）。
    const clock = await h.prisma.syncEntityVersion.findUnique({
      where: { id: `table_schema:${newTableId}` },
    });
    expect(clock?.version.toString()).toBe(schemaVer.toString());
  });

  it("E create_view → alter_view → delete_view 回放（保留 cuid；至少保留一个视图）", async () => {
    const r1 = await pushAs(OWNER, CLIENT, [
      sop(cid("cv"), "view", "create_view", viewId, schemaVer.toString(), {
        tableId: newTableId, name: "离线看板", type: "kanban",
      }),
    ]);
    expect(r1.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    let v = await h.prisma.view.findUnique({ where: { id: viewId } });
    expect(v).not.toBeNull();
    expect(v!.name).toBe("离线看板");

    const r2 = await pushAs(OWNER, CLIENT, [
      sop(cid("av"), "view", "alter_view", viewId, schemaVer.toString(), { name: "离线看板2" }),
    ]);
    expect(r2.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    v = await h.prisma.view.findUnique({ where: { id: viewId } });
    expect(v!.name).toBe("离线看板2");

    // 删除该视图后仍剩建表时的默认网格视图 → 允许。
    const r3 = await pushAs(OWNER, CLIENT, [
      sop(cid("dv"), "view", "delete_view", viewId, schemaVer.toString(), {}),
    ]);
    expect(r3.results![0]!.status).toBe("accepted");
    schemaVer += 1n;
    v = await h.prisma.view.findUnique({ where: { id: viewId } });
    expect(v).toBeNull();
  });

  it("E delete_view 最后一个视图 → rejected（至少保留一个）", async () => {
    // refTableId 建表时自带一个默认网格视图；尝试删掉它（应被现有校验拒绝）。
    const onlyView = await h.prisma.view.findFirstOrThrow({ where: { tableId: refTableId } });
    const ver = await h.prisma.syncEntityVersion.findUnique({
      where: { id: `table_schema:${refTableId}` },
    });
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("dvlast"), "view", "delete_view", onlyView.id, ver?.version.toString() ?? "1", {}),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(await h.prisma.view.findUnique({ where: { id: onlyView.id } })).not.toBeNull();
  });

  // S3b-3a：create_table 回放保子实体权威 id（§8.4）。直接喂注册表 handler.apply（不经 push
  // HTTP/权限裁决/引擎记账），故只跑 *Tx 原语、不写 local_outbox/sync_op_log。
  it("create_table 回放：payload 带 primaryFieldId/defaultFieldIds/defaultViewId 时子实体 id 逐字保留；老 payload 缺键回退随机", async () => {
    const { withWriteTx } = await import("../../../../db.js");
    const { getStructureOpHandler } = await import("../../../../domain/sync/structureRegistry.js");
    const handler = getStructureOpHandler("table", "create_table");
    expect(handler).toBeTruthy();
    if (!handler) return;

    // A) 保 id：主字段/4 默认字段/默认视图全部按 payload 权威 cuid 落地。
    const presetTableId = "tbl_preset_0001";
    const presetPfId = "fld_name_0001";
    const presetDefaults = ["fld_qty_0001", "fld_status_0001", "fld_date_0001", "fld_note_0001"];
    const presetViewId = "view_grid_0001";
    let outcomeA: { payload: Record<string, unknown> } | null = null;
    await withWriteTx("yn7.preset.createTable", async (tx) => {
      outcomeA = await handler.apply(tx, OWNER, baseId, {
        clientOpId: "yn7-preset-ct",
        entityType: "table",
        entityId: presetTableId,
        op: "create_table",
        baseVersion: 0n,
        payload: {
          name: "保id表",
          withDefaults: true,
          primaryFieldId: presetPfId,
          defaultFieldIds: presetDefaults,
          defaultViewId: presetViewId,
        },
      });
    });

    const tA = await h.prisma.table.findUniqueOrThrow({ where: { id: presetTableId } });
    expect(tA.name).toBe("保id表");
    expect(tA.primaryFieldId).toBe(presetPfId);

    const expectedFields: Array<[string, string, string]> = [
      [presetPfId, "名称", "singleLineText"],
      [presetDefaults[0], "数量", "number"],
      [presetDefaults[1], "状态", "singleSelect"],
      [presetDefaults[2], "日期", "date"],
      [presetDefaults[3], "备注", "longText"],
    ];
    for (const [fid, fname, ftype] of expectedFields) {
      const f = await h.prisma.field.findUnique({ where: { id: fid } });
      expect(f).not.toBeNull();
      expect(f!.tableId).toBe(presetTableId);
      expect(f!.deletedAt).toBeNull();
      expect(f!.name).toBe(fname);
      expect(f!.type).toBe(ftype);
    }
    const vA = await h.prisma.view.findUniqueOrThrow({ where: { id: presetViewId } });
    expect(vA.type).toBe("grid");
    expect(vA.tableId).toBe(presetTableId);

    expect(outcomeA).not.toBeNull();
    expect(outcomeA!.payload.primaryFieldId).toBe(presetPfId);
    expect(outcomeA!.payload.defaultFieldIds).toEqual(presetDefaults);
    expect(outcomeA!.payload.defaultViewId).toBe(presetViewId);
    // *Tx 原语层不经 wrapper/引擎记账：local_outbox 与 sync_op_log 对该表零写入。
    expect(await h.prisma.localOutbox.count({ where: { entityId: presetTableId } })).toBe(0);
    expect(
      await h.prisma.syncOpLog.count({ where: { entityId: presetTableId, op: "create_table" } }),
    ).toBe(0);

    // B) 老 op：payload 仅 {name,withDefaults}，缺三新键 → 子实体 id 全部回退随机 cuid，
    // 但回放结果 payload 仍恒定带 defaultFieldIds(4)/defaultViewId。
    const legacyTableId = "tbl_legacy_0001";
    const presetIds = new Set<string>([presetPfId, ...presetDefaults, presetViewId]);
    let outcomeB: { payload: Record<string, unknown> } | null = null;
    await withWriteTx("yn7.legacy.createTable", async (tx) => {
      outcomeB = await handler.apply(tx, OWNER, baseId, {
        clientOpId: "yn7-legacy-ct",
        entityType: "table",
        entityId: legacyTableId,
        op: "create_table",
        baseVersion: 0n,
        payload: { name: "老表", withDefaults: true },
      });
    });

    const tB = await h.prisma.table.findUniqueOrThrow({ where: { id: legacyTableId } });
    expect(tB.name).toBe("老表");
    expect(tB.primaryFieldId).toBeTruthy();
    expect(presetIds.has(tB.primaryFieldId)).toBe(false);

    const fieldsB = await h.prisma.field.findMany({
      where: { tableId: legacyTableId, deletedAt: null },
    });
    expect(fieldsB).toHaveLength(5);
    for (const f of fieldsB) expect(presetIds.has(f.id)).toBe(false);
    expect(
      fieldsB.some(
        (f) => f.id === tB.primaryFieldId && f.name === "名称" && f.type === "singleLineText",
      ),
    ).toBe(true);

    const viewsB = await h.prisma.view.findMany({ where: { tableId: legacyTableId } });
    expect(viewsB).toHaveLength(1);
    expect(presetIds.has(viewsB[0]!.id)).toBe(false);

    expect(outcomeB).not.toBeNull();
    const bDefaults = outcomeB!.payload.defaultFieldIds;
    expect(Array.isArray(bDefaults)).toBe(true);
    expect(bDefaults as unknown[]).toHaveLength(4);
    for (const id of bDefaults as string[]) expect(presetIds.has(id)).toBe(false);
    expect(typeof outcomeB!.payload.defaultViewId).toBe("string");
    expect(outcomeB!.payload.defaultViewId).not.toBe(presetViewId);
    expect(await h.prisma.localOutbox.count({ where: { entityId: legacyTableId } })).toBe(0);
  });
});

describe("F. 结构版本门", () => {
  it("baseSchemaVersion 落后 → conflict，主数据不生效、incoming 留 conflict", async () => {
    const tableId = "tbl_yn7_gate";
    const r0 = await pushAs(OWNER, CLIENT, [
      sop(cid("ct"), "table", "create_table", tableId, "0", { name: "版本门表" }),
    ]);
    expect(r0.results![0]!.status).toBe("accepted"); // 版本 1
    // 在线再改一次结构（推进到版本 2），制造服务端领先。
    const { createField } = await import("../../../../domain/fieldService.js");
    await createField({ tableId, name: "在线加的字段", type: "text" }, OWNER);

    // 离线端仍基于版本 1 推 add_field → 结构版本冲突，字段不得落地。
    const staleField = "fld_yn7_stale";
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("af_stale"), "field", "add_field", staleField, "1", {
        tableId, name: "离线落后字段", type: "text",
      }),
    ]);
    const res = r.results![0]!;
    expect(res.status).toBe("conflict");
    expect(res.reasonCode).toBe("SYNC_STRUCTURE_VERSION_CONFLICT");
    expect(res.serverVersion).toBe("2");
    expect(await h.prisma.field.findUnique({ where: { id: staleField } })).toBeNull();
    const incoming = await h.prisma.syncIncoming.findUnique({
      where: { clientOpId: res.clientOpId },
    });
    expect(incoming?.status).toBe("conflict");
  });
});

describe("G. 幂等", () => {
  it("同一 clientOpId 重放回同一回执，结构只应用一次、版本不二次推进", async () => {
    const tableId = "tbl_yn7_idem";
    const op0 = sop(cid("idem_ct"), "table", "create_table", tableId, "0", { name: "幂等表" });
    const r1 = await pushAs(OWNER, CLIENT, [op0]);
    expect(r1.results![0]!.status).toBe("accepted");
    const v1 = r1.results![0]!.newVersion;
    // 整批原样重发（同 clientOpId）。
    const r2 = await pushAs(OWNER, CLIENT, [op0]);
    expect(r2.results![0]!.status).toBe("accepted");
    expect(r2.results![0]!.newVersion).toBe(v1);
    // 表只有一个、oplog 只有一条该 clientOpId。
    expect(await h.prisma.table.count({ where: { id: tableId } })).toBe(1);
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: op0.clientOpId } })).toBe(1);
  });
});

describe("H. 当前权限重判（manage_schema）", () => {
  it("受限成员（有数据权、无结构权）推 add_field → rejected=PERMISSION_REVOKED，字段不落地", async () => {
    // 用 OWNER 建一张表作为目标（ED 对它有数据 c/r/u/d，但无 manage_schema）。
    const tableId = "tbl_yn7_perm";
    const r0 = await pushAs(OWNER, CLIENT, [
      sop(cid("ct"), "table", "create_table", tableId, "0", { name: "权限表" }),
    ]);
    expect(r0.results![0]!.status).toBe("accepted");
    // ED 对该表有数据 r/c/u/d（库门 enter 可过、记录可写），但 canManage=false → 无 manage_schema。
    const put = await putScopes([
      {
        libraryKind: "base",
        libraryId: baseId,
        visible: true,
        canManage: false,
        config: {
          tables: { [tableId]: { read: true, create: true, update: true, delete: true } },
          fields: {},
        },
      },
    ]);
    expect(put.status).toBe(200);

    const fid = "fld_yn7_ed";
    const r = await pushAs(ED, C_ED, [
      sop(cid("ed_af"), "field", "add_field", fid, "1", { tableId, name: "ED想加的字段", type: "text" }),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(r.results![0]!.reasonCode).toBe("SYNC_PERMISSION_REVOKED");
    expect(await h.prisma.field.findUnique({ where: { id: fid } })).toBeNull();
  });
});

describe("I. 未登记/非法 op", () => {
  it("未登记结构 op（nav_create_group 属 YN8）→ rejected=OP_UNSUPPORTED", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      { clientOpId: cid("unsupp"), entityType: "navnode", entityId: "nav_x", op: "nav_create_group", baseVersion: "0", payload: { name: "分组" } },
    ]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(r.results![0]!.reasonCode).toBe("SYNC_OP_UNSUPPORTED");
  });

  it("已登记但 payload 无法解析目标的 restore_field（字段不存在）→ rejected", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("restore_missing"), "field", "restore_field", "fld_never_existed", "0", {}),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
  });

  it("create_table 缺 name → rejected=MALFORMED，表不落地", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("badct"), "table", "create_table", "tbl_yn7_bad", "0", { withDefaults: false }),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(r.results![0]!.reasonCode).toBe("SYNC_MALFORMED_PAYLOAD");
    expect(await h.prisma.table.findUnique({ where: { id: "tbl_yn7_bad" } })).toBeNull();
  });

  it("alter_field 改不存在的字段 → rejected", async () => {
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("nf"), "field", "alter_field", "fld_does_not_exist", "0", { changed: { name: "x" } }),
    ]);
    expect(r.results![0]!.status).toBe("rejected");
  });
});

describe("J. 批内部分接受", () => {
  it("批内第 2 条非法，第 1 条照常 accepted 不回滚", async () => {
    const t1 = "tbl_yn7_partial_1";
    const r = await pushAs(OWNER, CLIENT, [
      sop(cid("p1"), "table", "create_table", t1, "0", { name: "批内合法表" }),
      sop(cid("p2"), "table", "create_table", "tbl_yn7_partial_2", "0", {}), // 缺 name → rejected
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    expect(r.results![1]!.status).toBe("rejected");
    expect(await h.prisma.table.findUnique({ where: { id: t1 } })).not.toBeNull();
    expect(await h.prisma.table.findUnique({ where: { id: "tbl_yn7_partial_2" } })).toBeNull();
  });
});

describe("K/L. 在线结构写切面（§8.6）+ pull 下发结构 op", () => {
  it("在线建表推进 table_schema 钟 + 落 __server__ 结构 oplog，且 pull 能拉到", async () => {
    const { createTable } = await import("../../../../domain/tableService.js");
    const t = await createTable({ baseId, name: "在线结构切面表" }, OWNER);
    const clock = await h.prisma.syncEntityVersion.findUnique({
      where: { id: `table_schema:${t.tableId}` },
    });
    expect(clock).not.toBeNull();
    expect(clock!.entityType).toBe("table_schema");
    expect(clock!.version).toBe(1n);
    const log = await h.prisma.syncOpLog.findFirst({
      where: { entityType: "table", entityId: t.tableId, op: "create_table" },
    });
    expect(log).not.toBeNull();
    expect(log!.clientId).toBe("__server__");

    // OWNER 订阅后 pull，能在同一条流里看到该结构 op。
    await h.app.request("/api/v1/sync/subscribe", {
      method: "POST",
      headers: await auth(OWNER),
      body: JSON.stringify({ clientId: "yn7-pull-client", scopeType: "base", scopeId: baseId }),
    });
    const pr = await h.app.request(
      `/api/v1/sync/pull?baseId=${baseId}&after=0&clientId=yn7-pull-client&limit=2000`,
      { headers: await h.auth(OWNER) },
    );
    expect(pr.status).toBe(200);
    const page = (await pr.json()).result;
    const structOps = page.ops.filter(
      (o: { entityType: string; op: string }) => o.entityType === "table" && o.op === "create_table",
    );
    expect(structOps.some((o: { entityId: string }) => o.entityId === t.tableId)).toBe(true);
  });
});
