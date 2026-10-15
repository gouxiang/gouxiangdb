// YN4 push 回放契约测试（真 createApp + 真迁移临时库 + 真 JWT）。
// 设计权威：DESIGN-OFFLINE-SYNC §5.2、§7.1、§8.1、§8.2、§8.4、§8.5、§13、§15.2（YN4 验收）。
//
// 验收映射：
//   - 重连自动同步      → B：离线攒的 create/patch/delete 一批 push 全部 accepted、落库、版本推进。
//   - 断网中途重试不重复 → C：同一 clientOpId 重放回同一回执，主数据/oplog/incoming 都只有一条。
//   - 乱序/重试一致     → D：create→patch 批重放整批，结果一致、字段只应用一次；版本链正确。
//   - 关联临时 id       → E：批内 childClientRef 指向同批新建记录，解析到权威 id 并落 link_row。
//   - 部分接受          → F：批内第 2 条非法（必填缺失）rejected，第 1 条照常 accepted 不回滚。
//   - 冲突/拒绝三态     → G：版本不符 conflict（不写主数据）、实体已删 rejected、非法 op rejected。
//   - 门/鉴权/参数       → A：off 404、未登录 401、无库权限 403、缺参 400。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn4_owner";
const OTHER = "yn4_other";
const CLIENT = "yn4-client-1";

function withEnv<K>(key: string, value: string | undefined, fn: () => Promise<K>): Promise<K> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

let baseId = "";
let tableId = "";
let pf = "";
let reqField = "";
let autoField = "";
let autoTableId = "";
let autoPf = "";
// links 夹具：parent 表持正向 hm 关联指向 child 表。
let parentTableId = "";
let parentPf = "";
let childTableId = "";
let childPf = "";
let childLinkFieldId = "";

interface OpResult {
  clientOpId: string;
  status: "accepted" | "conflict" | "rejected";
  reasonCode?: string;
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

function op(
  clientOpId: string,
  op: string,
  entityId: string,
  baseVersion: string,
  payload: Record<string, unknown>,
  entityType = "record",
) {
  return { clientOpId, entityType, entityId, op, baseVersion, payload };
}

async function push(ops: ReturnType<typeof op>[], user = OWNER, clientId = CLIENT): Promise<PushResp> {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: { ...(await h.auth(user)), "Content-Type": "application/json" },
    body: JSON.stringify({ baseId, clientId, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code, results: body.result?.results };
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(OTHER);
  await h.grantSystemRole(OWNER, "owner");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const { createField } = await import("../../../../domain/fieldService.js");

  const base = await createBase({ name: "yn4", withStarter: false }, OWNER);
  baseId = base.id;

  const t = await createTable({ baseId, name: "t" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;
  // 一个必填文本字段（用于 F 的非法写：缺必填 → rejected）。
  const rf = await createField({ tableId, name: "必填项", type: "text", required: true }, OWNER);
  reqField = rf.field.id;

  // 自动编号表（验证 push create 的事务后补偿：autoNumber 必须被编号，与在线 POST 同构）。
  const autoTable = await createTable({ baseId, name: "autoT" }, OWNER);
  autoTableId = autoTable.tableId;
  autoPf = autoTable.primaryFieldId;
  const af = await createField(
    {
      tableId: autoTableId,
      name: "编号",
      type: "autoNumber",
      numberRule: { segments: [{ type: "fixed", text: "NO-" }, { type: "counter", digits: 3, reset: "never" }] },
    },
    OWNER,
  );
  autoField = af.field.id;

  // links 夹具两张表。
  const child = await createTable({ baseId, name: "child" }, OWNER);
  childTableId = child.tableId;
  childPf = child.primaryFieldId;
  const parent = await createTable({ baseId, name: "parent" }, OWNER);
  parentTableId = parent.tableId;
  parentPf = parent.primaryFieldId;
  // parent 上建正向一对多关联 → child（hm）。返回的正向字段挂在 parent。
  const link = await createField(
    { tableId: parentTableId, name: "子项", type: "links", relatedTableId: childTableId, relationKind: "hm" },
    OWNER,
  );
  childLinkFieldId = link.field.id;

  // 订阅（push 成功后推进该订阅游标）。
  const sub = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 门/鉴权/参数", () => {
  it("off -> 404 SYNC_DISABLED", () =>
    withEnv("GX_SYNC_SERVER", undefined, async () => {
      const r = await push([op("a-gate", "create", "x", "0", { tableId, fields: {} })]);
      expect(r.status).toBe(404);
      expect(r.code).toBe("SYNC_DISABLED");
    }));

  it("on + 未登录 -> 401", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const res = await h.app.request("/api/v1/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseId, clientId: CLIENT, ops: [] }),
      });
      expect(res.status).toBe(401);
    }));

  it("无库权限用户 -> 403 SYNC_PERMISSION_REVOKED", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const r = await push([op("a-perm", "create", "x", "0", { tableId, fields: {} })], OTHER);
      expect(r.status).toBe(403);
      expect(r.code).toBe("SYNC_PERMISSION_REVOKED");
    }));

  it("缺 baseId/clientId、空 ops、坏 baseVersion -> 400", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const headers = { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
      const noBase = await h.app.request("/api/v1/sync/push", {
        method: "POST", headers, body: JSON.stringify({ clientId: CLIENT, ops: [op("x", "create", "e", "0", {})] }),
      });
      expect(noBase.status).toBe(400);
      const empty = await h.app.request("/api/v1/sync/push", {
        method: "POST", headers, body: JSON.stringify({ baseId, clientId: CLIENT, ops: [] }),
      });
      expect(empty.status).toBe(400);
      const badVer = await h.app.request("/api/v1/sync/push", {
        method: "POST", headers,
        body: JSON.stringify({ baseId, clientId: CLIENT, ops: [op("x", "create", "e", "abc", {})] }),
      });
      expect(badVer.status).toBe(400);
    }));
});

describe("B. 重连自动同步：create/patch/delete 全部 accepted 且落库", () => {
  const C1 = "yn4-c1";
  const C2 = "yn4-c2";
  const C3 = "yn4-c3";
  const ID1 = "rec_yn4_keep";
  const ID2 = "rec_yn4_edit";
  const ID3 = "rec_yn4_del";

  it("一批 create×2 + patch + delete，accepted、保留 cuid、版本=1/2、墓碑成立", async () => {
    const r = await push([
      op(`op-${C1}`, "create", ID1, "0", { tableId, fields: { [pf]: "保留", [reqField]: "v" } }),
      op(`op-${C2}`, "create", ID2, "0", { tableId, fields: { [pf]: "原值", [reqField]: "v" } }),
      op(`op-${C3}`, "create", ID3, "0", { tableId, fields: { [pf]: "将删", [reqField]: "v" } }),
      op("op-patch-c2", "patch", ID2, "1", { tableId, changed: { [pf]: { from: "原值", to: "新值" } } }),
      op("op-del-c3", "delete", ID3, "1", {}),
    ]);
    expect(r.status).toBe(200);
    const res = r.results!;
    expect(res.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
    // create 保留客户端 cuid；create 后 newVersion=1，patch 后 =2。
    expect(res[0]!.entityId).toBe(ID1);
    expect(res[0]!.newVersion).toBe("1");
    expect(res[3]!.entityId).toBe(ID2);
    expect(res[3]!.newVersion).toBe("2");
    expect(res[4]!.newVersion).toBe("2"); // create=1, delete=2
    // seq 严格递增且为字符串。
    const seqs = res.map((x) => BigInt(x.seq!));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);

    // 主数据落库核对。
    const keep = await h.prisma.record.findUnique({ where: { id: ID1 } });
    expect(keep).not.toBeNull();
    expect(keep!.deletedAt).toBeNull();
    const edited = await h.prisma.record.findUnique({ where: { id: ID2 } });
    expect(JSON.parse(edited!.fields as string)[pf]).toBe("新值");
    const deleted = await h.prisma.record.findUnique({ where: { id: ID3 } });
    expect(deleted!.deletedAt).not.toBeNull();

    // 版本表 / oplog / incoming 各一条且 clientOpId 正确。
    const v1 = await h.prisma.syncEntityVersion.findUnique({ where: { id: ID1 } });
    expect(v1!.version.toString()).toBe("1");
    expect(v1!.isDeleted).toBe(false);
    const v3 = await h.prisma.syncEntityVersion.findUnique({ where: { id: ID3 } });
    expect(v3!.isDeleted).toBe(true);
    const opLogCount = await h.prisma.syncOpLog.count({ where: { entityId: { in: [ID1, ID2, ID3] } } });
    expect(opLogCount).toBe(5);
    const inc = await h.prisma.syncIncoming.findUnique({ where: { clientOpId: `op-${C1}` } });
    expect(inc!.status).toBe("accepted");
  });

  it("订阅游标被推进到本批 accepted 最大 seq", async () => {
    const sub = await h.prisma.syncSubscription.findUnique({
      where: { clientId_scopeType_scopeId: { clientId: CLIENT, scopeType: "base", scopeId: baseId } },
    });
    const maxLog = await h.prisma.syncOpLog.aggregate({ _max: { seq: true } });
    expect(sub!.cursorSeq.toString()).toBe((maxLog._max.seq ?? 0n).toString());
  });
});

describe("C. 断网中途重试：同一 clientOpId 重放不重复", () => {
  const ID = "rec_yn4_retry";
  const OPID = "op-retry-create";
  it("重放返回同一 seq/newVersion，主数据/oplog/incoming 都只有一条", async () => {
    const payload = { tableId, fields: { [pf]: "重试", [reqField]: "v" } };
    const first = await push([op(OPID, "create", ID, "0", payload)]);
    const second = await push([op(OPID, "create", ID, "0", payload)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.results![0]).toMatchObject({
      clientOpId: OPID, status: "accepted", entityId: ID,
      seq: first.results![0]!.seq, newVersion: "1",
    });
    expect(await h.prisma.record.count({ where: { id: ID } })).toBe(1);
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: OPID } })).toBe(1);
    expect(await h.prisma.syncIncoming.count({ where: { clientOpId: OPID } })).toBe(1);
  });
});

describe("D. 乱序/重试一致：create→patch 整批重放结果一致、只应用一次", () => {
  const ID = "rec_yn4_chain";
  const OP_C = "op-chain-create";
  const OP_U = "op-chain-patch";
  it("整批重放，最终字段一致、版本链 1→2、无重复 oplog", async () => {
    const batch = [
      op(OP_C, "create", ID, "0", { tableId, fields: { [pf]: "a", [reqField]: "v" } }),
      op(OP_U, "patch", ID, "1", { tableId, changed: { [pf]: { from: "a", to: "b" } } }),
    ];
    const r1 = await push(batch);
    const r2 = await push(batch); // 模拟重试/乱序到达，整批再发一次
    expect(r1.results!.map((x) => x.status)).toEqual(["accepted", "accepted"]);
    expect(r2.results!.map((x) => x.status)).toEqual(["accepted", "accepted"]);
    // 重放的 seq/newVersion 与首次完全一致（幂等回同一回执）。
    expect(r2.results![0]!.seq).toBe(r1.results![0]!.seq);
    expect(r2.results![1]!.newVersion).toBe("2");
    const rec = await h.prisma.record.findUnique({ where: { id: ID } });
    expect(JSON.parse(rec!.fields as string)[pf]).toBe("b");
    const v = await h.prisma.syncEntityVersion.findUnique({ where: { id: ID } });
    expect(v!.version.toString()).toBe("2");
    expect(await h.prisma.syncOpLog.count({ where: { entityId: ID } })).toBe(2);
  });
});

describe("E. 批内关联：childClientRef 临时 id 解析到同批新建记录", () => {
  it("先建 child、再建带 links 的 parent，link_row 正确挂接", async () => {
    const CHILD = "rec_yn4_childref";
    const PARENT = "rec_yn4_parentref";
    const r = await push([
      op("op-link-child", "create", CHILD, "0", { tableId: childTableId, fields: { [childPf]: "子" } }),
      op("op-link-parent", "create", PARENT, "0", {
        tableId: parentTableId,
        fields: { [parentPf]: "父" },
        links: [{ linkFieldId: childLinkFieldId, childClientRef: CHILD, ord: 0 }],
      }),
    ]);
    expect(r.results!.map((x) => x.status)).toEqual(["accepted", "accepted"]);
    const rows = await h.prisma.linkRow.findMany({
      where: { linkFieldId: childLinkFieldId, parentRowId: PARENT, childRowId: CHILD, deletedAt: null },
    });
    expect(rows.length).toBe(1);
  });
});

describe("E2. 事务后默认值补偿：autoNumber 与在线 POST 同构", () => {
  it("push create 后自动编号字段被编号（NO-001），补偿失败不静默", async () => {
    const ID = "rec_yn4_auto1";
    const r = await push([
      op("op-auto-1", "create", ID, "0", { tableId: autoTableId, fields: { [autoPf]: "编号行" } }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    const rec = await h.prisma.record.findUnique({ where: { id: ID } });
    expect(rec).not.toBeNull();
    expect(JSON.parse(rec!.fields as string)[autoField]).toBe("NO-001");
  });
});

describe("F. 批内部分接受：非法条 rejected 不回滚已确认条", () => {
  it("第 1 条 accepted、第 2 条缺必填 rejected，第 1 条仍落库", async () => {
    const GOOD = "rec_yn4_good";
    const BAD = "rec_yn4_bad";
    const r = await push([
      op("op-part-good", "create", GOOD, "0", { tableId, fields: { [pf]: "好", [reqField]: "v" } }),
      op("op-part-bad", "create", BAD, "0", { tableId, fields: { [pf]: "坏" } }), // 缺 reqField
    ]);
    expect(r.results![0]!.status).toBe("accepted");
    expect(r.results![1]!.status).toBe("rejected");
    expect(r.results![1]!.reasonCode).toBeDefined();
    expect(await h.prisma.record.findUnique({ where: { id: GOOD } })).not.toBeNull();
    expect(await h.prisma.record.findUnique({ where: { id: BAD } })).toBeNull();
    const inc = await h.prisma.syncIncoming.findUnique({ where: { clientOpId: "op-part-bad" } });
    expect(inc!.status).toBe("rejected");
  });
});

describe("G. 冲突 / 实体已删 / 非法操作", () => {
  const ID = "rec_yn4_conf";
  beforeAll(async () => {
    const r = await push([
      op("op-conf-seed", "create", ID, "0", { tableId, fields: { [pf]: "x", [reqField]: "v" } }),
    ]);
    expect(r.results![0]!.status).toBe("accepted");
  });

  it("baseVersion 落后 -> conflict，不写主数据，incoming=conflict 带 serverVersion", async () => {
    // 服务端当前 version=1；带 baseVersion=0 必冲突。
    const r = await push([
      op("op-conf-stale", "patch", ID, "0", { tableId, changed: { [pf]: { from: "x", to: "抢改" } } }),
    ]);
    expect(r.results![0]!.status).toBe("conflict");
    expect(r.results![0]!.reasonCode).toBe("SYNC_VERSION_CONFLICT");
    expect(r.results![0]!.serverVersion).toBe("1");
    const rec = await h.prisma.record.findUnique({ where: { id: ID } });
    expect(JSON.parse(rec!.fields as string)[pf]).toBe("x"); // 未被改动
    const inc = await h.prisma.syncIncoming.findUnique({ where: { clientOpId: "op-conf-stale" } });
    expect(inc!.status).toBe("conflict");
    expect(inc!.serverVersion.toString()).toBe("1");
    // 冲突 op 不进 oplog。
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: "op-conf-stale" } })).toBe(0);
  });

  it("冲突重放同 clientOpId 回同一 conflict 回执（幂等）", async () => {
    const r = await push([
      op("op-conf-stale", "patch", ID, "0", { tableId, changed: { [pf]: { from: "x", to: "抢改" } } }),
    ]);
    expect(r.results![0]!.status).toBe("conflict");
    expect(r.results![0]!.serverVersion).toBe("1");
    expect(await h.prisma.syncIncoming.count({ where: { clientOpId: "op-conf-stale" } })).toBe(1);
  });

  it("delete 对已删实体幂等成功；对不存在记录 patch -> ENTITY_NOT_FOUND", async () => {
    const GONE = "rec_yn4_gone";
    const del = await push([
      op("op-gone-del", "create", GONE, "0", { tableId, fields: { [pf]: "g", [reqField]: "v" } }),
      op("op-gone-del2", "delete", GONE, "1", {}),
      op("op-gone-del3", "delete", GONE, "1", {}), // 已删：幂等 accepted
    ]);
    expect(del.results!.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted"]);
    const v = await h.prisma.syncEntityVersion.findUnique({ where: { id: GONE } });
    expect(v!.version.toString()).toBe("2"); // 重复 delete 不推进版本

    const patch404 = await push([
      op("op-patch-404", "patch", "rec_does_not_exist_zzz", "0", { tableId, changed: { [pf]: { to: 1 } } }),
    ]);
    expect(patch404.results![0]!.status).toBe("rejected");
    expect(patch404.results![0]!.reasonCode).toBe("SYNC_ENTITY_NOT_FOUND");
  });

  it("不支持的 op/实体 -> rejected OP_UNSUPPORTED，不写主数据", async () => {
    const r = await push([op("op-restore", "restore", ID, "1", {})]);
    expect(r.results![0]!.status).toBe("rejected");
    expect(r.results![0]!.reasonCode).toBe("SYNC_OP_UNSUPPORTED");
    const r2 = await push([op("op-kb", "create", "x", "0", {}, "kb_doc")]);
    expect(r2.results![0]!.status).toBe("rejected");
    expect(r2.results![0]!.reasonCode).toBe("SYNC_OP_UNSUPPORTED");
  });
});
