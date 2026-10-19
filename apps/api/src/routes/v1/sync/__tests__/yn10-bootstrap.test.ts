// S3b-1 空副本下行引导基线 GET /api/v1/sync/bootstrap 契约测试
// （真 createApp + 真迁移临时库 + 真 JWT，不 mock；不碰 dev.db）。
// 设计权威：DESIGN-OFFLINE-SYNC §6（引导基线）；只读、默认关、读端点不挂 S0 协议门。
//
// 骨架严格对齐同目录 yn2a-snapshot.test.ts：顶部仅静态 import vitest + setupOrgHarness（+ type）；
// beforeAll 先 delete GX_SYNC_SERVER 再 setupOrgHarness（off 态建库），服务一律在 beforeAll 内
// 【动态 import】（libraryService/tableService/fieldService/viewService）防 PrismaClient 先连真实 dev.db；
// withEnv 在各用例内进程内开同步；afterAll delete env + h.cleanup()。
//
// 复用既有夹具范式（不发明 harness API）：
//   - withEnv / 在线 POST /api/records 取服务端 cuid：yn2a-snapshot.test.ts:20 / :52-59
//   - 授权/收回字段：yn5-adjudication.test.ts 的 putScopes(:49) / fullScopes(:58)（PUT library-scopes）
//   - 建 links 双向关联字段：yn4-push.test.ts:117-129（createField type=links relationKind=hm）
//   说明：team-lead 提到的 yn2b 经读全文确认【不含】收回权限/建关联 helper（其 :10-11 明确不搭策略
//   夹具），故这两类范式改从 yn5/yn4 复用。
//
// 覆盖（bootstrap 区别于 snapshot 的全部增量契约）：
//   A. off 404 SYNC_DISABLED（鉴权/DB 之前）。
//   B. on + owner happy：kind/base/表 primaryFieldId 保 cuid/fields/views/records(甲,乙)/meta/links 数组。
//   C. 结构全量、数据按权限裁剪：OTHER 进得去库但某表 r 被收 + 某字段被藏 → 被收表 table/field/view
//      结构仍在、records 与该表 links 不出现；被藏字段 key 不出现在 record.fields 但 field 元数据仍在。
//   D. links 仅正向字段 + 两端可见：每条 link.linkFieldId=正向(isReverse=false)字段，parent/child 在可见集。
//   E. 软删剔除：软删记录/字段后均不在 bootstrap（只投影 deletedAt:null；views 无软删列，不验 view 删除）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn10_owner";
const OTHER = "yn10_other";

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
let mainTableId = "";
let mainPf = "";
let childTableId = "";
let childPf = "";
let fwdLinkFieldId = "";
let revLinkFieldId = "";
let secretFieldId = "";
let viewId = "";
let restrictedTableId = "";
let restrictedPf = "";
let restrictedViewId = "";
let rJia = "";
let rYi = "";
let c1 = "";
let c2 = "";
let restrictedRec = "";

const CLIENT = "yn10-client";

async function auth(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

/** 在线 POST /api/records（yn2a :52-59 范式），返回服务端分配 cuid。 */
async function onlineRecord(tableId: string, pfId: string, value: string): Promise<string> {
  const res = await h.app.request(`/api/records?tableId=${tableId}`, {
    method: "POST",
    headers: await auth(OWNER),
    body: JSON.stringify({ fields: { [pfId]: value } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { id: string } }).record.id;
}

async function bootstrap(user: string) {
  const res = await h.app.request(
    `/api/v1/sync/bootstrap?baseId=${baseId}&clientId=${CLIENT}`,
    { method: "GET", headers: await h.auth(user) },
  );
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    code: body.code as string | undefined,
    page: body.result as Record<string, unknown> | undefined,
  };
}

/** 复用 yn5 putScopes（:49）：超管整份替换 role_restricted 对本 base 的库视野。 */
async function putScopes(items: unknown[]): Promise<number> {
  const res = await h.app.request("/api/v1/org/library-scopes", {
    method: "PUT",
    headers: await auth(OWNER),
    body: JSON.stringify({ roleId: "role_restricted", items }),
  });
  return res.status;
}

/** main/child 两表全 c/r/u/d、另给受限表只读；fields 可叠加 extra（yn5 fullScopes :58 范式）。 */
function scopesFor(extra: Record<string, unknown> = {}): unknown[] {
  return [{
    libraryKind: "base",
    libraryId: baseId,
    visible: true, // enter 库门通过
    canManage: false,
    config: {
      tables: {
        [mainTableId]: { read: true, create: true, update: true, delete: true },
        [childTableId]: { read: true, create: true, update: true, delete: true },
        [restrictedTableId]: { read: true },
      },
      fields: {},
      ...extra,
    },
  }];
}

/** 收回 OTHER 对受限表的 r：删掉该表节点上 role_restricted 的策略行（base 节点只授 enter，不含 r）。 */
async function revokeTableReadForOther(tableId: string): Promise<void> {
  await h.prisma.authPolicy.deleteMany({
    where: { nodeId: `nav_table_${tableId}`, subjectType: "role", subjectId: "role_restricted" },
  });
}

beforeAll(async () => {
  delete process.env.GX_SYNC_SERVER; // off 态建库（与 yn2a 一致）
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(OTHER);
  await h.grantSystemRole(OWNER, "owner");
  await h.grantSystemRole(OTHER, "restricted");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const { createField } = await import("../../../../domain/fieldService.js");
  const { createView } = await import("../../../../domain/viewService.js");

  const base = await createBase({ name: "yn10", withStarter: false }, OWNER);
  baseId = base.id;

  // 主表 + 子表（yn4 links 夹具 :117-129）。
  const child = await createTable({ baseId, name: "child" }, OWNER);
  childTableId = child.tableId; childPf = child.primaryFieldId;
  const main = await createTable({ baseId, name: "main" }, OWNER);
  mainTableId = main.tableId; mainPf = main.primaryFieldId;

  // 主表正向 hm 关联 -> 子表；正向字段挂主表，反向挂子表。
  const link = await createField(
    { tableId: mainTableId, name: "子项", type: "links", relatedTableId: childTableId, relationKind: "hm" },
    OWNER,
  );
  fwdLinkFieldId = link.field.id;
  const fwdRow = await h.prisma.field.findUniqueOrThrow({ where: { id: fwdLinkFieldId } });
  // 正向字段经 linkFieldId 指向反向字段（fieldServiceTx.ts:158 建正向时只写 linkFieldId、
  // 不写 reverseFieldId；反向字段才用 reverseFieldId/linkFieldId 互指正面向，见 :169-172）。
  revLinkFieldId = fwdRow.linkFieldId!;

  // 普通文本字段（字段权限用）+ 视图。
  const secret = await createField({ tableId: mainTableId, name: "密档", type: "text" }, OWNER);
  secretFieldId = secret.field.id;
  const v = await createView({ tableId: mainTableId, name: "视图甲", type: "grid", config: { x: 1 } }, OWNER);
  viewId = v.id;

  // 第三张「受限表」+ 字段 + 视图 + 一条记录（用于结构全量但数据裁剪用例）。
  const restricted = await createTable({ baseId, name: "restricted" }, OWNER);
  restrictedTableId = restricted.tableId; restrictedPf = restricted.primaryFieldId;
  const rv = await createView({ tableId: restrictedTableId, name: "受限视图", type: "grid" }, OWNER);
  restrictedViewId = rv.id;

  // 在线写记录（off 态 POST /api/records 不经同步门，yn2a 已证 201）。
  rJia = await onlineRecord(mainTableId, mainPf, "甲");
  rYi = await onlineRecord(mainTableId, mainPf, "乙");
  c1 = await onlineRecord(childTableId, childPf, "c1");
  c2 = await onlineRecord(childTableId, childPf, "c2");
  restrictedRec = await onlineRecord(restrictedTableId, restrictedPf, "secret-row");

  // 正向关联行：主表 rJia -> 子表 c1/c2（linkFieldId 挂正向字段，recordWrite.ts:114 同口径）。
  await h.prisma.linkRow.create({ data: { linkFieldId: fwdLinkFieldId, parentRowId: rJia, childRowId: c1, ord: 0 } });
  await h.prisma.linkRow.create({ data: { linkFieldId: fwdLinkFieldId, parentRowId: rJia, childRowId: c2, ord: 1 } });
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 默认 off：bootstrap 404 SYNC_DISABLED", () => {
  it("GX_SYNC_SERVER 未设 -> 404（鉴权/DB 之前）", async () => {
    const r = await bootstrap(OWNER);
    expect(r.status).toBe(404);
    expect(r.code).toBe("SYNC_DISABLED");
  });
});

describe("B. on + owner happy path", () => {
  it("完整结构保 cuid + 两记录(甲/乙) + 视图 + meta + links 数组", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const r = await bootstrap(OWNER);
      expect(r.status).toBe(200);
      const p = r.page!;
      expect(p.kind).toBe("replica-bootstrap");
      expect(typeof p.anchorSeq).toBe("string");
      expect(/^\d+$/.test(p.anchorSeq as string)).toBe(true);
      expect(typeof p.authzVersion).toBe("number");
      expect(typeof p.serverTime).toBe("string");
      expect(p.recordsTruncated).toBe(false);

      expect((p.base as { id: string }).id).toBe(baseId);
      const tables = p.tables as Array<{ id: string; primaryFieldId: string }>;
      const mainTbl = tables.find((t) => t.id === mainTableId)!;
      expect(mainTbl).toBeTruthy();
      expect(mainTbl.primaryFieldId).toBe(mainPf); // 保 cuid，与 createTable 返回一致

      const fields = p.fields as Array<{ id: string; tableId: string; isReverse: boolean }>;
      expect(fields.some((f) => f.id === mainPf)).toBe(true);
      expect(fields.some((f) => f.id === fwdLinkFieldId && f.isReverse === false)).toBe(true);
      expect(fields.some((f) => f.id === revLinkFieldId && f.isReverse === true)).toBe(true);

      const views = p.views as Array<{ id: string; tableId: string }>;
      const view = views.find((x) => x.id === viewId)!;
      expect(view).toBeTruthy();
      expect(view.tableId).toBe(mainTableId);

      const records = p.records as Array<{ id: string; tableId: string; fields: Record<string, unknown> }>;
      const byId = new Map(records.map((x) => [x.id, x]));
      expect([rJia, rYi].every((id) => byId.has(id))).toBe(true);
      expect(byId.get(rJia)!.fields[mainPf]).toBe("甲");
      expect(byId.get(rYi)!.fields[mainPf]).toBe("乙");

      expect(Array.isArray(p.links)).toBe(true);
      expect((p.links as unknown[]).length).toBe(2);
    }));
});

describe("C. 结构全量、数据按当前权限裁剪", () => {
  it("OTHER：被收表结构仍在但 records/links 不出现；被藏字段 key 不在 record.fields 但 field 元数据在", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      // OTHER 对库可见 + 三表 r；主表密档字段 hidden（yn5 字段收窄）。
      expect(await putScopes(scopesFor({ fields: { [mainTableId]: { [secretFieldId]: "hidden" } } }))).toBe(200);
      // 库 visible=1 时 r 是每表基线（scopeProjection 恒补），单表不可见只能删该表节点 r 策略。
      await revokeTableReadForOther(restrictedTableId);

      const r = await bootstrap(OTHER);
      expect(r.status).toBe(200);
      const p = r.page!;

      // 被收【表】结构仍下发（table / 其字段 / 其视图都在）。
      expect((p.tables as unknown[]).some((t) => (t as { id: string }).id === restrictedTableId)).toBe(true);
      expect((p.fields as unknown[]).some((f) => (f as { tableId: string }).tableId === restrictedTableId)).toBe(true);
      expect((p.views as unknown[]).some((v) => (v as { id: string }).id === restrictedViewId)).toBe(true);
      // 但该表记录不出现。
      const recIds = (p.records as Array<{ id: string }>).map((x) => x.id);
      expect(recIds).not.toContain(restrictedRec);
      // 该表无 link（其记录不在全局可见集，相关 link 两端过滤排除）。
      const links = p.links as Array<{ parentRowId: string; childRowId: string }>;
      expect(links.every((l) => l.parentRowId !== restrictedRec && l.childRowId !== restrictedRec)).toBe(true);

      // 被藏【字段】：主表记录 fields 无该 key，但 fields[] 结构元数据仍在。
      expect((p.fields as unknown[]).some((f) => (f as { id: string }).id === secretFieldId)).toBe(true);
      const jia = (p.records as Array<{ id: string; fields: Record<string, unknown> }>).find((x) => x.id === rJia)!;
      expect(jia.fields[secretFieldId]).toBeUndefined();
      expect(jia.fields[mainPf]).toBe("甲");
    }));
});

describe("D. links 仅正向字段 + 两端可见", () => {
  it("owner：每条 link.linkFieldId=正向字段(非反向)，parent/child 在可见记录集，含 id/ord", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const r = await bootstrap(OWNER);
      const p = r.page!;
      const visibleIds = new Set((p.records as Array<{ id: string }>).map((x) => x.id));
      const links = p.links as Array<{ id: string; linkFieldId: string; parentRowId: string; childRowId: string; ord: number }>;
      expect(links.length).toBe(2);
      for (const l of links) {
        expect(l.linkFieldId).toBe(fwdLinkFieldId); // 正向字段
        expect(l.linkFieldId).not.toBe(revLinkFieldId); // 绝不等于反向字段
        expect(visibleIds.has(l.parentRowId)).toBe(true);
        expect(visibleIds.has(l.childRowId)).toBe(true);
        expect(typeof l.id).toBe("string");
        expect(typeof l.ord).toBe("number");
      }
      const childSet = links.map((l) => l.childRowId).sort();
      expect(childSet).toEqual([c1, c2].sort());
    }));
});

describe("E. 软删剔除（只投影活态）", () => {
  it("软删字段与记录后不在 bootstrap（views 无软删列，不验 view 删除）", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const { createField } = await import("../../../../domain/fieldService.js");
      const { deleteField } = await import("../../../../domain/fieldService.js");
      const disposable = await createField({ tableId: mainTableId, name: "待删列", type: "text" }, OWNER);
      // 在线标准写路径删记录（yn2b :95 范式）。
      const delRec = await h.app.request(`/api/records/${rYi}`, { method: "DELETE", headers: await auth(OWNER) });
      expect(delRec.status).toBe(200);
      // 在线编排删字段。
      await deleteField(disposable.field.id, OWNER);

      const r = await bootstrap(OWNER);
      const p = r.page!;
      const recIds = (p.records as Array<{ id: string }>).map((x) => x.id);
      expect(recIds).not.toContain(rYi); // 软删记录剔除
      expect(recIds).toContain(rJia); // 未删仍在
      expect((p.fields as unknown[]).some((f) => (f as { id: string }).id === disposable.field.id)).toBe(false);
      expect((p.fields as unknown[]).some((f) => (f as { id: string }).id === mainPf)).toBe(true);
    }));
});
