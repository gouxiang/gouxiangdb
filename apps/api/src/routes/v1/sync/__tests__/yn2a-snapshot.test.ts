// YN2a subscribe + 权限裁剪基线快照契约测试（真 createApp + 真迁移临时库 + 真 JWT，不 mock）。
// 设计权威：DESIGN-OFFLINE-SYNC §6.1/§6.2、§9.1、§13、§15.2（YN2）。
//
// 覆盖：
//  A. off：/subscribe 与 /snapshot 在鉴权/DB 之前 404 SYNC_DISABLED（默认零行为）。
//  B. on subscribe：owner 订阅返回 cursorSeq "0"、snapshotDone false、authzVersion 数字；
//     重复订阅幂等（不重置、不报错）。
//  C. on snapshot：返回该 base 全部活记录，id 集与在线列表 GET /api/records 完全一致（同口径）；
//     老记录（同步开启前建、无版本行）version "0"；字段值正确；snapshotSeq 为当前最大 seq 的字符串。
//  D. 无库权限用户 subscribe/snapshot -> 403（当前权限实时裁决，不因别人订过而放行）。
//  E. 缺参/坏 scope 400。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn2_owner";
const OTHER = "yn2_other";

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
let primaryFieldId = "";
const CLIENT = "yn2-client-1";

beforeAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(OTHER);
  await h.grantSystemRole(OWNER, "owner");

  // 经标准服务建空库 + 一张表（同步 nav/owner 策略投影），再写两条记录（在线写，默认 off 不产生 oplog）。
  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const base = await createBase({ name: "yn2", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "t" }, OWNER);
  tableId = t.tableId;
  primaryFieldId = t.primaryFieldId;

  const headers = await h.auth(OWNER);
  for (const v of ["甲", "乙"]) {
    const res = await h.app.request(`/api/records?tableId=${tableId}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { [primaryFieldId]: v } }),
    });
    expect(res.status).toBe(201);
  }
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 默认 off：subscribe/snapshot 404 SYNC_DISABLED", () => {
  it("subscribe", async () => {
    const res = await h.app.request("/api/v1/sync/subscribe", {
      method: "POST",
      headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
  });
  it("snapshot", async () => {
    const res = await h.app.request(`/api/v1/sync/snapshot?baseId=${baseId}`, {
      method: "GET",
      headers: await h.auth(OWNER),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
  });
});

describe("B. on subscribe：记账 + 游标 + authzVersion，幂等", () => {
  it("首次订阅 cursor 0/snapshotDone false；重复订阅不报错", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const headers = { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
      const body = () =>
        JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId });

      const r1 = await h.app.request("/api/v1/sync/subscribe", { method: "POST", headers, body: body() });
      expect(r1.status).toBe(200);
      const d1 = (await json<{ result: Record<string, unknown> }>(r1)).result;
      expect(d1.scopeType).toBe("base");
      expect(d1.scopeId).toBe(baseId);
      expect(d1.cursorSeq).toBe("0");
      expect(d1.snapshotDone).toBe(false);
      expect(typeof d1.authzVersion).toBe("number");

      const r2 = await h.app.request("/api/v1/sync/subscribe", { method: "POST", headers, body: body() });
      expect(r2.status).toBe(200);
      const d2 = (await json<{ result: { cursorSeq: string } }>(r2)).result;
      // 幂等：游标不被重置。
      expect(d2.cursorSeq).toBe("0");
    }));

  it("scopeType 非 base -> 400；缺 clientId -> 400", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const headers = { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
      const badScope = await h.app.request("/api/v1/sync/subscribe", {
        method: "POST", headers,
        body: JSON.stringify({ clientId: CLIENT, scopeType: "kb", scopeId: "x" }),
      });
      expect(badScope.status).toBe(400);
      const noClient = await h.app.request("/api/v1/sync/subscribe", {
        method: "POST", headers,
        body: JSON.stringify({ scopeType: "base", scopeId: baseId }),
      });
      expect(noClient.status).toBe(400);
    }));
});

describe("C. on snapshot：与在线列表同口径", () => {
  it("快照记录 id 集 = 列表 id 集；老记录 version 0；snapshotSeq/authzVersion 形态正确", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const headers = await h.auth(OWNER);

      // 在线列表口径（GET /api/records）。
      const listRes = await h.app.request(`/api/records?tableId=${tableId}&limit=1000`, { headers });
      expect(listRes.status).toBe(200);
      const listBody = await json<{ records: Array<{ id: string }> }>(listRes);
      const listIds = listBody.records.map((r) => r.id).sort();
      expect(listIds.length).toBe(2);

      const snapRes = await h.app.request(
        `/api/v1/sync/snapshot?baseId=${baseId}&clientId=${CLIENT}`,
        { headers },
      );
      expect(snapRes.status).toBe(200);
      const snap = (await json<{
        result: {
          baseId: string;
          records: Array<{ id: string; tableId: string; fields: Record<string, unknown>; version: string; isDeleted: boolean; lastSeq: string }>;
          snapshotSeq: string;
          serverTime: string;
          authzVersion: number;
        };
      }>(snapRes)).result;

      expect(snap.baseId).toBe(baseId);
      const snapIds = snap.records.map((r) => r.id).sort();
      expect(snapIds).toEqual(listIds); // 与在线列表完全一致
      for (const r of snap.records) {
        expect(r.tableId).toBe(tableId);
        expect(r.version).toBe("0"); // 同步开启前的老记录，懒初始化不回填
        expect(r.isDeleted).toBe(false);
        // 主字段值确实带下来了（字段未被错误裁剪）。
        expect(["甲", "乙"]).toContain(r.fields[primaryFieldId]);
      }
      expect(typeof snap.snapshotSeq).toBe("string");
      expect(Number.isFinite(Number(snap.snapshotSeq))).toBe(true);
      expect(typeof snap.authzVersion).toBe("number");
      expect(Number.isFinite(Date.parse(snap.serverTime))).toBe(true);
    }));

  it("带 clientId 拉快照后订阅标记 snapshotDone=true", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const headers = { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
      const r = await h.app.request("/api/v1/sync/subscribe", {
        method: "POST", headers,
        body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
      });
      const d = (await json<{ result: { snapshotDone: boolean } }>(r)).result;
      expect(d.snapshotDone).toBe(true);
    }));
});

describe("D. 当前权限实时裁决：无库权限 -> 403", () => {
  it("OTHER（无角色）subscribe/snapshot 均 403", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const sub = await h.app.request("/api/v1/sync/subscribe", {
        method: "POST",
        headers: { ...(await h.auth(OTHER)), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "yn2-other", scopeType: "base", scopeId: baseId }),
      });
      expect(sub.status).toBe(403);

      const snap = await h.app.request(`/api/v1/sync/snapshot?baseId=${baseId}`, {
        headers: await h.auth(OTHER),
      });
      expect(snap.status).toBe(403);
    }));

  it("on + 未登录 -> 401（门放行后鉴权拦）", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const snap = await h.app.request(`/api/v1/sync/snapshot?baseId=${baseId}`);
      expect(snap.status).toBe(401);
    }));
});
