// YN5 权限裁决 + 隔离 + 同步中心 + 失权可见集 + 审计 契约测试
// （真 createApp + 真迁移临时库 + 真 JWT + 真权限引擎，不 mock 决策）。
// 设计权威：DESIGN-OFFLINE-SYNC §9.1（服务端唯一裁决者）、§9.2（rejected/quarantined/重试/放弃）、
//   §9.3（失权可见集对账）、§9.5（审计只带标识、不落字段明文）、§13（incoming/visibility 端点）、
//   §15.2（YN5 验收：模拟离线期间降权/移除，操作不落地且明确告知、失权本地数据被擦的服务端依据）。
//
// 验收映射：
//   A 探针阶段刷到 YN5；同步中心默认只看本人待处理项。
//   B 离线期间【表级 u 被收回】→ push 200 但该 op rejected=SYNC_PERMISSION_REVOKED，主数据不动。
//   C visibility 按当前权限收敛：隐藏字段退出 visibleFieldIds；不可见表 readable=false。
//   D 离线期间【被移出 base】（曾订阅）→ 该 op quarantined（不是 rejected），主数据不动。
//   E 重新授权后对隔离项 retry → accepted 落库、同一 clientOpId、attempts 累加。
//   F 显式放弃：confirm 缺省 400；confirm=true → dropped 留痕。
//   G restore 走 manage_table：有数据编辑权但无管理权限的成员被 rejected。
//   H 被移出后 visibility 库门 403（侧车据此销毁整节点加密镜像，§18.3）。
//   I 审计：sync_push_rejected/quarantined/accepted 落盘，detail 只带标识，绝不落字段明文。

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn5_owner";
const ED = "yn5_editor";
const C_ED = "yn5-client-ed";
const C_OWNER = "yn5-client-owner";

let baseId = "";
let tableId = "";
let pf = "";
let secretField = "";
let table2Id = "";
const R1 = "rec_yn5_r1"; // B：被降权 patch 的目标（始终 v1）
const R2 = "rec_yn5_r2"; // D/E：隔离后重试 accepted 的目标
const RD = "rec_yn5_rd"; // G：墓碑，restore 目标

const SECRET_MARKER = "ZZZ_SECRET_PAYLOAD_XYZ_yn5";

function op(clientOpId: string, opName: string, entityId: string, baseVersion: string, payload: Record<string, unknown>) {
  return { clientOpId, entityType: "record", entityId, op: opName, baseVersion, payload };
}

async function auth(user: string): Promise<Record<string, string>> {
  return { ...(await h.auth(user)), "Content-Type": "application/json" };
}

/** 用超级管理员整份替换 role_restricted 对本 base 的库视野（走完整投影链）。 */
async function putScopes(items: unknown[]): Promise<Response> {
  return h.app.request("/api/v1/org/library-scopes", {
    method: "PUT",
    headers: await auth(OWNER),
    body: JSON.stringify({ roleId: "role_restricted", items }),
  });
}

/** 对本 base 两张表都给全 c/r/u/d（不可管理），fields 不隐藏。 */
function fullScopes(extra: Record<string, unknown> = {}): unknown[] {
  return [
    {
      libraryKind: "base",
      libraryId: baseId,
      visible: true,
      canManage: false,
      config: {
        tables: {
          [tableId]: { read: true, create: true, update: true, delete: true },
          [table2Id]: { read: true, create: true, update: true, delete: true },
        },
        fields: {},
        ...extra,
      },
    },
  ];
}

async function pushAs(user: string, clientId: string, ops: ReturnType<typeof op>[]) {
  const res = await h.app.request("/api/v1/sync/push", {
    method: "POST",
    headers: await auth(user),
    body: JSON.stringify({ baseId, clientId, ops }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body.code as string | undefined, results: body.result?.results as Array<Record<string, unknown>> | undefined };
}

async function subscribe(user: string, clientId: string): Promise<number> {
  const res = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST",
    headers: await auth(user),
    body: JSON.stringify({ clientId, scopeType: "base", scopeId: baseId }),
  });
  return res.status;
}

async function listIncoming(status: string) {
  const res = await h.app.request(`/api/v1/sync/incoming?status=${status}`, { headers: await h.auth(ED) });
  const body = await res.json();
  return { status: res.status, items: body.result?.items as Array<Record<string, unknown>> };
}

async function readAudit(): Promise<string> {
  const file = path.join(h.tmpDir, ".audit", "audit.logl");
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(ED);
  await h.grantSystemRole(OWNER, "owner");
  await h.grantSystemRole(ED, "restricted");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const { createField } = await import("../../../../domain/fieldService.js");

  const base = await createBase({ name: "yn5", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "t" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;
  const sf = await createField({ tableId, name: "密档", type: "text" }, OWNER);
  secretField = sf.field.id;
  const t2 = await createTable({ baseId, name: "t2" }, OWNER);
  table2Id = t2.tableId;

  // owner 推三条种子记录（含一条随后删成墓碑）。
  const seed = await pushAs(OWNER, C_OWNER, [
    op("seed-r1", "create", R1, "0", { tableId, fields: { [pf]: "R1", [secretField]: "密" } }),
    op("seed-r2", "create", R2, "0", { tableId, fields: { [pf]: "R2", [secretField]: "密" } }),
    op("seed-rd", "create", RD, "0", { tableId, fields: { [pf]: "RD" } }),
  ]);
  expect(seed.results!.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted"]);
  const del = await pushAs(OWNER, C_OWNER, [op("seed-rd-del", "delete", RD, "1", {})]);
  expect(del.results![0]!.status).toBe("accepted"); // RD 现版本 2、墓碑

  // 先给受限成员全权并订阅（建立 sync_subscriptions.actorId —— 日后 quarantine 的判据）。
  expect((await putScopes(fullScopes())).status).toBe(200);
  expect(await subscribe(ED, C_ED)).toBe(200);
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 探针与同步中心", () => {
  it("探针 phase 刷到 YN5", async () => {
    const res = await h.app.request("/api/v1/sync", { headers: await h.auth(ED) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.phase).toBe("YN5");
  });

  it("同步中心默认只返回本人待处理项（此刻为空）", async () => {
    const r = await listIncoming("quarantined,conflict,rejected,pending_approval");
    expect(r.status).toBe(200);
    expect(r.items).toEqual([]);
  });
});

describe("B. 离线期间表级 update 权限被收回 → rejected，操作不落地", () => {
  it("逐表 u:false（仍在库、其它权限在）→ patch rejected=SYNC_PERMISSION_REVOKED，主数据不变", async () => {
    const scopes = fullScopes();
    (scopes[0] as { config: { tables: Record<string, unknown> } }).config.tables[tableId] = {
      read: true, create: true, update: false, delete: true,
    };
    expect((await putScopes(scopes)).status).toBe(200);

    const r = await pushAs(ED, C_ED, [
      op("yn5-b-patch", "patch", R1, "1", {
        tableId,
        changed: { [pf]: { from: "R1", to: SECRET_MARKER } },
      }),
    ]);
    expect(r.status).toBe(200); // 库门仍进得去，批整体 200，逐条裁决
    expect(r.results![0]!).toMatchObject({
      clientOpId: "yn5-b-patch", status: "rejected", reasonCode: "SYNC_PERMISSION_REVOKED",
    });

    // 主数据原封不动。
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: R1 } });
    expect(JSON.parse(rec.fields as string)[pf]).toBe("R1");
    // 没有为这次失败写 oplog/版本。
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: "yn5-b-patch" } })).toBe(0);
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "yn5-b-patch" } });
    expect(inc.status).toBe("rejected");
  });
});

describe("C. visibility 按当前权限收敛（失权擦除的服务端依据）", () => {
  it("隐藏字段退出 visibleFieldIds；仍给 authzVersion；未降权表字段全可见", async () => {
    // 权限模型事实：库 visible=1 时表级 r 是基线（scopeProjection.tableActions 恒补 r），整表不可见
    // 只由字段掩码引擎 cap.visible 驱动；library scope 能在本期直接收紧的是【写权 c/u/d】与
    // 【字段 hidden 档】。故这里验字段隐藏收敛（失权字段擦除依据）；整表/整库不可见由 H 的 403 覆盖。
    const scopes = fullScopes({
      fields: { [tableId]: { [secretField]: "hidden" } },
    });
    (scopes[0] as { config: { tables: Record<string, unknown> } }).config.tables[tableId] = {
      read: true, create: true, update: false, delete: true,
    };
    expect((await putScopes(scopes)).status).toBe(200);

    const res = await h.app.request(`/api/v1/sync/visibility?baseId=${baseId}`, {
      headers: await h.auth(ED),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const report = body.result;
    expect(typeof report.authzVersion).toBe("number");
    const byTable = new Map<string, { readable: boolean; visibleEntityIds: string[]; visibleFieldIds: string[] | null }>(
      report.tables.map((t: { tableId: string }) => [t.tableId, t]),
    );
    const t1 = byTable.get(tableId)!;
    expect(t1.readable).toBe(true);
    expect(t1.visibleEntityIds).toContain(R1);
    expect(t1.visibleFieldIds).not.toContain(secretField); // 失权字段退出可见集 → 侧车擦它
    expect(t1.visibleFieldIds).toContain(pf);
    // 未降权的 T2 字段不裁剪（null=全可见）。
    const t2 = byTable.get(table2Id)!;
    expect(t2.readable).toBe(true);
    expect(t2.visibleFieldIds).toBeNull();
  });
});

describe("D. 离线期间被移出 base（曾订阅）→ quarantined，不落地", () => {
  it("清空库视野后 push → quarantined=SYNC_QUARANTINED，主数据不变", async () => {
    expect((await putScopes([])).status).toBe(200); // 移出 base
    const r = await pushAs(ED, C_ED, [
      op("yn5-d-patch", "patch", R2, "1", {
        tableId,
        changed: { [pf]: { from: "R2", to: "QUARANTINED_SHOULD_NOT_LAND" } },
      }),
    ]);
    expect(r.status).toBe(200);
    expect(r.results![0]!).toMatchObject({
      clientOpId: "yn5-d-patch", status: "quarantined", reasonCode: "SYNC_QUARANTINED",
    });
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: R2 } });
    expect(JSON.parse(rec.fields as string)[pf]).toBe("R2");
    expect(await h.prisma.syncOpLog.count({ where: { clientOpId: "yn5-d-patch" } })).toBe(0);
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "yn5-d-patch" } });
    expect(inc.status).toBe("quarantined");
    expect(inc.attempts).toBe(1);
  });
});

describe("E. 重新授权后重试隔离项 → accepted（同一 clientOpId，attempts 累加）", () => {
  it("regrant → POST retry 落库、版本推进、attempts=2", async () => {
    expect((await putScopes(fullScopes())).status).toBe(200); // 重新授权
    const list = await listIncoming("quarantined");
    const item = list.items.find((x) => x.clientOpId === "yn5-d-patch")!;
    expect(item).toBeDefined();

    const res = await h.app.request(`/api/v1/sync/incoming/${item.id as string}/retry`, {
      method: "POST",
      headers: await auth(ED),
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toMatchObject({
      clientOpId: "yn5-d-patch", status: "accepted", attempts: 2,
    });

    // 主数据真的落地（隔离时被拦下的那处修改，重试后生效）、版本推进到 2。
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: R2 } });
    expect(JSON.parse(rec.fields as string)[pf]).toBe("QUARANTINED_SHOULD_NOT_LAND");
    const v = await h.prisma.syncEntityVersion.findUniqueOrThrow({ where: { id: R2 } });
    expect(v.version.toString()).toBe("2");
    // 仍只有一条 incoming（复用同一行），且已 accepted。
    const cnt = await h.prisma.syncIncoming.count({ where: { clientOpId: "yn5-d-patch" } });
    expect(cnt).toBe(1);
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "yn5-d-patch" } });
    expect(inc.status).toBe("accepted");
    expect(inc.attempts).toBe(2);
  });
});

describe("F. 显式放弃 → dropped 留痕", () => {
  it("confirm 缺省 → 400；confirm=true → dropped（行保留）", async () => {
    // B 产生的 rejected 项仍在。
    const list = await listIncoming("rejected");
    const item = list.items.find((x) => x.clientOpId === "yn5-b-patch")!;
    expect(item).toBeDefined();

    const noConfirm = await h.app.request(`/api/v1/sync/incoming/${item.id as string}/discard`, {
      method: "POST", headers: await auth(ED), body: JSON.stringify({}),
    });
    expect(noConfirm.status).toBe(400);

    const ok = await h.app.request(`/api/v1/sync/incoming/${item.id as string}/discard`, {
      method: "POST", headers: await auth(ED), body: JSON.stringify({ confirm: true }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.result).toMatchObject({ clientOpId: "yn5-b-patch", status: "dropped" });

    // 行不删除（留痕），状态 dropped。
    const inc = await h.prisma.syncIncoming.findUniqueOrThrow({ where: { clientOpId: "yn5-b-patch" } });
    expect(inc.status).toBe("dropped");
    expect(inc.decidedBy).toBe(ED);
  });
});

describe("G. restore 需 manage_table：有数据权限但无管理权 → rejected", () => {
  it("受限成员（canManage:false）push restore 墓碑 → rejected=SYNC_PERMISSION_REVOKED，记录仍删", async () => {
    // E 之后是 fullScopes（c/r/u/d 全开但 canManage:false）。
    const r = await pushAs(ED, C_ED, [op("yn5-g-restore", "restore", RD, "2", {})]);
    expect(r.results![0]!).toMatchObject({
      clientOpId: "yn5-g-restore", status: "rejected", reasonCode: "SYNC_PERMISSION_REVOKED",
    });
    const rec = await h.prisma.record.findUniqueOrThrow({ where: { id: RD } });
    expect(rec.deletedAt).not.toBeNull(); // 仍是墓碑
  });
});

describe("H. 被移出后 visibility 库门 403（侧车整节点销毁依据）", () => {
  it("清空库视野 → GET visibility 403", async () => {
    expect((await putScopes([])).status).toBe(200);
    const res = await h.app.request(`/api/v1/sync/visibility?baseId=${baseId}`, {
      headers: await h.auth(ED),
    });
    expect(res.status).toBe(403);
  });
});

describe("I. 审计：裁决事件落盘，detail 不落字段明文", () => {
  it("sync_push_rejected/quarantined/accepted 均在；字段明文 marker 不进审计", async () => {
    const log = await readAudit();
    expect(log).toContain("sync_push_rejected");
    expect(log).toContain("sync_push_quarantined");
    // E 的 retry accepted 是新鲜终态，应发 sync_push_accepted。
    const acceptedLines = log.split("\n").filter((l) => l.includes('"event":"sync_push_accepted"'));
    expect(acceptedLines.some((l) => l.includes("yn5-d-patch"))).toBe(true);
    // 关键隐私断言：离线改动的字段值绝不能写进审计（§9.5）。
    expect(log).not.toContain(SECRET_MARKER);
    expect(log).not.toContain("QUARANTINED_SHOULD_NOT_LAND");
    // rejected/quarantined 行带原因码与 baseId，可值班排查。
    const qLines = log.split("\n").filter((l) => l.includes('"event":"sync_push_quarantined"'));
    expect(qLines.some((l) => l.includes("yn5-d-patch") && l.includes("SYNC_QUARANTINED") && l.includes(baseId))).toBe(true);
  });
});
