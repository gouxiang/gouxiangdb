// YN2b pull 游标增量 + 当前权限过滤契约测试（真 createApp + 真迁移临时库 + 真 JWT）。
// 设计权威：DESIGN-OFFLINE-SYNC §6、§8.3、§9.1、§13、§15.2（YN2）。
//
// 覆盖：
//  A. off：/pull 404 SYNC_DISABLED；on+未登录 401；无库权限 403；坏 after 400。
//  B. on 下在线写（YN1 切面）产生 oplog，pull after=0 按 seq 升序回传，BigInt 全为字符串，
//     payload 含 op/tableId/changes；create/update/delete 三类齐全；delete 墓碑照常下发。
//  C. keyset 分页：小 limit 时 hasMore/nextCursor 正确，逐页拼起来 seq 连续不漏不重。
//  D. 增量：after=最后 seq 再拉为空、hasMore false。
//  行级「降权不下发」由 pull 复用 snapshot 的同一 buildTableVisibility 保证（yn2a 已对拍其与在线
//  列表口径一致），此处不重复搭策略夹具。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "yn2b_owner";
const OTHER = "yn2b_other";

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
let recIds: string[] = [];
const CLIENT = "yn2b-client-1";

interface PullOpShape {
  seq: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: { tableId?: string; op?: string; changes?: unknown[] };
  newVersion: string;
}
interface PullResult {
  ops: PullOpShape[];
  nextCursor: string;
  hasMore: boolean;
  authzVersion: number;
}

async function pull(q: string, user = OWNER): Promise<{ status: number; result?: PullResult; code?: string }> {
  const res = await h.app.request(`/api/v1/sync/pull?${q}`, { headers: await h.auth(user) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, result: body.result, code: body.code };
}

beforeAll(async () => {
  process.env.GX_SYNC_SERVER = "on"; // 在线写即产生 oplog（YN1 切面运行时读 env）
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.createUser(OTHER);
  await h.grantSystemRole(OWNER, "owner");

  const { createBase } = await import("../../../../domain/libraryService.js");
  const { createTable } = await import("../../../../domain/tableService.js");
  const base = await createBase({ name: "yn2b", withStarter: false }, OWNER);
  baseId = base.id;
  const t = await createTable({ baseId, name: "t" }, OWNER);
  tableId = t.tableId;
  pf = t.primaryFieldId;

  // 订阅（pull 推进游标记账需要订阅行；不订阅也能拉，只是不记账）。
  const sub = await h.app.request("/api/v1/sync/subscribe", {
    method: "POST",
    headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT, scopeType: "base", scopeId: baseId }),
  });
  expect(sub.status).toBe(200);

  // 建 4 条（r1..r4）→ 改 r1 → 软删 r4。
  // 按设计 §6.2/§6.4：r4 软删后，其历史 create 按「当前不可见」被过滤，但 delete 墓碑仍下发。
  const headers = { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
  const ids: string[] = [];
  for (const v of ["r1", "r2", "r3", "r4"]) {
    const r = await h.app.request(`/api/records?tableId=${tableId}`, {
      method: "POST", headers, body: JSON.stringify({ fields: { [pf]: v } }),
    });
    expect(r.status).toBe(201);
    ids.push(((await r.json()) as { record: { id: string } }).record.id);
  }
  const upd = await h.app.request(`/api/records/${ids[0]}`, {
    method: "PATCH", headers, body: JSON.stringify({ fields: { [pf]: "r1改" } }),
  });
  expect(upd.status).toBe(200);
  const del = await h.app.request(`/api/records/${ids[3]}`, { method: "DELETE", headers });
  expect(del.status).toBe(200);
  recIds = ids;
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  await h.cleanup();
});

describe("A. 门/鉴权/参数", () => {
  it("off -> 404 SYNC_DISABLED", () =>
    withEnv("GX_SYNC_SERVER", undefined, async () => {
      const r = await pull(`baseId=${baseId}`);
      expect(r.status).toBe(404);
      expect(r.code).toBe("SYNC_DISABLED");
    }));

  it("on + 未登录 -> 401", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const res = await h.app.request(`/api/v1/sync/pull?baseId=${baseId}`);
      expect(res.status).toBe(401);
    }));

  it("无库权限用户 -> 403", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const r = await pull(`baseId=${baseId}`, OTHER);
      expect(r.status).toBe(403);
    }));

  it("缺 baseId -> 400；坏 after -> 400", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const noBase = await h.app.request("/api/v1/sync/pull", { headers: await h.auth(OWNER) });
      expect(noBase.status).toBe(400);
      const badAfter = await pull(`baseId=${baseId}&after=abc`);
      expect(badAfter.status).toBe(400);
    }));
});

describe("B. on pull 增量内容与形状", () => {
  it("after=0 回传 create×3 + update×1 + delete×1，seq 升序、版本连续、BigInt 为字符串", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const r = await pull(`baseId=${baseId}&after=0&clientId=${CLIENT}&limit=500`);
      expect(r.status).toBe(200);
      const page = r.result!;
      expect(page.hasMore).toBe(false);
      expect(typeof page.authzVersion).toBe("number");

      // YN7 起 pull 同流也下发结构 op（建表时在线切面会先产一条 create_table）。本用例只验
      // 记录轨（YN2b 的主题），故按 entityType=record 过滤后再对记录序列断言；结构轨由 yn7 覆盖。
      const ops = page.ops.filter((o) => o.entityType === "record");
      expect(ops.map((o) => o.op)).toEqual(["create", "create", "create", "update", "delete"]);
      // 建表的结构 op 也在同一条 oplog 流里（YN7 §19.2：结构时钟滴答须随 pull 下发）。
      expect(page.ops.some((o) => o.entityType === "table" && o.op === "create_table")).toBe(true);
      // seq 严格升序、连续正整数串
      const seqs = ops.map((o) => BigInt(o.seq));
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
      // 所有数值字段都是字符串（BigInt JSON 安全）
      for (const o of ops) {
        expect(typeof o.seq).toBe("string");
        expect(typeof o.newVersion).toBe("string");
        expect(o.entityType).toBe("record");
        expect(o.payload.tableId).toBe(tableId);
      }
      // 第 4 条 update 的 newVersion=2（该记录 create=1, update=2）；第 5 条 delete newVersion=2。
      expect(ops[3]!.entityId).toBe(recIds[0]);
      expect(ops[3]!.newVersion).toBe("2");
      expect(ops[4]!.entityId).toBe(recIds[3]);
      expect(ops[4]!.op).toBe("delete");
      expect(ops[4]!.newVersion).toBe("2");
      // r4 的历史 create（已软删→当前不可见）被过滤，但其 delete 墓碑仍下发（§6.2/§6.4）。
      const createIds = ops.filter((o) => o.op === "create").map((o) => o.entityId).sort();
      expect(createIds).toEqual([recIds[0], recIds[1], recIds[2]].sort());
      // nextCursor = 最后一条 seq
      expect(page.nextCursor).toBe(ops[ops.length - 1]!.seq);
    }));
});

describe("C. keyset 分页", () => {
  it("limit=2 逐页拉取，拼起来与全量一致、seq 不重不漏、hasMore 收敛", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const all: PullOpShape[] = [];
      let cursor = "0";
      let guard = 0;
      for (;;) {
        const r = await pull(`baseId=${baseId}&after=${cursor}&limit=2`);
        expect(r.status).toBe(200);
        const page = r.result!;
        all.push(...page.ops);
        if (!page.hasMore) break;
        // 原始页可能含被当前权限过滤掉的 op（如软删行的历史 create），过滤后条数可 <2 甚至 0，
        // 但游标必须严格推进（nextCursor 取原始最后一条 seq），否则会死循环。
        expect(page.nextCursor > cursor).toBe(true);
        cursor = page.nextCursor;
        if (++guard > 20) throw new Error("分页不收敛");
      }
      // 与一次性全量拉取的结果（顺序、内容）完全一致（分页与全量都含同一条结构 op，不影响等价）。
      const full = await pull(`baseId=${baseId}&after=0&limit=500`);
      const fullOps = full.result!.ops;
      expect(all.map((o) => o.seq)).toEqual(fullOps.map((o) => o.seq));
      // 记录轨序列仍为 3 create + update + delete（结构 op 不在本用例断言范围）。
      expect(all.filter((o) => o.entityType === "record").map((o) => o.op))
        .toEqual(["create", "create", "create", "update", "delete"]);
      const seqSet = new Set(all.map((o) => o.seq));
      expect(seqSet.size).toBe(all.length); // 无重复
    }));
});

describe("D. 增量到最新后为空", () => {
  it("after=最新 seq 再拉 ops=[]、hasMore=false", () =>
    withEnv("GX_SYNC_SERVER", "on", async () => {
      const first = await pull(`baseId=${baseId}&after=0&limit=500`);
      const last = first.result!.nextCursor;
      const r = await pull(`baseId=${baseId}&after=${last}&limit=500`);
      expect(r.status).toBe(200);
      expect(r.result!.ops).toEqual([]);
      expect(r.result!.hasMore).toBe(false);
      expect(r.result!.nextCursor).toBe(last);
    }));
});
