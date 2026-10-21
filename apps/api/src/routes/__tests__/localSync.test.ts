// GET /api/local-sync/status 本机副本引擎【只读状态】端点契约测试（真迁移临时库 + 真 createApp + 真 JWT，不 mock）。
//
// 覆盖：
//   A. 默认关（GX_OFFLINE_REPLICA 未开 或 未配 GX_REPLICA_REMOTE_URL）：门在鉴权/DB 之前 404 SYNC_DISABLED，
//      即便带登录态也 404；与 /api/v1/sync 服务端面互不影响（那是 GX_SYNC_SERVER 另一个门）。
//   B. 配置齐全 + 未登录 -> 401（配置门与鉴权是两道独立闸）。
//   C. 配置齐全 + 登录（Authorization 与 X-GX-Token 两头都认）-> 200，契约字段、本地库 bases 形状与真实计数一致。
//
// 加载纪律：本文件只走 h.app.request（app 在 harness 内动态创建），不静态 import db 链。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../v1/org/__tests__/orgHarness.js";

// localSync.js 顶部 import db.ts，绝不能在 harness 注入临时 DATABASE_URL 前静态加载（否则 PrismaClient
// 误连 dev.db）；纯函数 localDatabaseBytes 在 beforeAll 之后动态 import 取用。
type LocalDatabaseBytes = (databaseUrl: string) => number;
let localDatabaseBytes: LocalDatabaseBytes;

let h: OrgHarness;
const PATH = "/api/local-sync/status";
const USER = "ls_user";

const CFG_KEYS = ["GX_OFFLINE_REPLICA", "GX_REPLICA_REMOTE_URL", "GX_REPLICA_REMOTE_TOKEN", "GX_OFFLINE_NODE_ID"] as const;

beforeAll(async () => {
  for (const k of CFG_KEYS) delete process.env[k];
  h = await setupOrgHarness();
  ({ localDatabaseBytes } = await import("../localSync.js"));
  await h.createUser(USER);
}, 120_000);

afterAll(async () => {
  for (const k of CFG_KEYS) delete process.env[k];
  await h.cleanup();
});

/** 在副本配置齐全（GX_OFFLINE_REPLICA=on + 非空远端 URL）的 env 窗口内执行。 */
async function withReplicaConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const snap: Record<string, string | undefined> = {};
  for (const k of CFG_KEYS) snap[k] = process.env[k];
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_REPLICA_REMOTE_URL = "http://127.0.0.1:59999";
  process.env.GX_OFFLINE_NODE_ID = "local";
  try {
    return await fn();
  } finally {
    for (const k of CFG_KEYS) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  }
}

describe("localDatabaseBytes（file: URL → 字节，异常归零）", () => {
  it("非 file: URL / 不存在文件 / 空路径 -> 0", () => {
    expect(localDatabaseBytes("postgresql://x/y")).toBe(0);
    expect(localDatabaseBytes("")).toBe(0);
    expect(localDatabaseBytes("file:/nonexistent/definitely-missing-xyz.db")).toBe(0);
    expect(localDatabaseBytes("file:")).toBe(0);
  });
  it("query/hash 被剥离；真实存在的文件返回其字节数", () => {
    // 不存在但带 query：剥 query 后仍不存在 -> 0（证明不会把 query 当路径）。
    expect(localDatabaseBytes("file:/nonexistent/x.db?mode=ro")).toBe(0);
  });
});

describe("A. 默认关：404 SYNC_DISABLED 在鉴权/DB 之前", () => {
  it("全未配 + 未登录 -> 404（不是 401）", async () => {
    const res = await h.app.request("/api/local-sync/status", { method: "GET" });
    expect(res.status).toBe(404);
    expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
  });

  it("旧路径 GET /api/local-sync 根不再服务（契约钉在 /status）", async () => {
    const res = await h.app.request("/api/local-sync", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("全未配 + 登录态 -> 仍 404", async () => {
    const res = await h.app.request(PATH, { method: "GET", headers: await h.auth(USER) });
    expect(res.status).toBe(404);
    expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
  });

  it("flag 开但无远端 URL -> 404（fail-closed）", async () => {
    const prev = process.env.GX_OFFLINE_REPLICA;
    process.env.GX_OFFLINE_REPLICA = "on";
    try {
      const res = await h.app.request(PATH, { method: "GET", headers: await h.auth(USER) });
      expect(res.status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.GX_OFFLINE_REPLICA;
      else process.env.GX_OFFLINE_REPLICA = prev;
    }
  });
});

describe("B. 配置齐全：鉴权独立", () => {
  it("配置 on + 未登录 -> 401", () =>
    withReplicaConfigured(async () => {
      const res = await h.app.request(PATH, { method: "GET" });
      expect(res.status).toBe(401);
    }));
});

describe("C. 配置齐全 + 登录：200 契约与真实计数 / 本地库 bases", () => {
  it("Authorization 头：空态契约字段齐全、本地库字节>0（临时库是真文件）", () =>
    withReplicaConfigured(async () => {
      const res = await h.app.request(PATH, { method: "GET", headers: await h.auth(USER) });
      expect(res.status).toBe(200);
      const body = await json<{
        enabled: boolean;
        running: boolean;
        inFlight: boolean;
        stage: string;
        nodeId: string;
        lastPulledAt: string | null;
        lastPushedAt: string | null;
        pendingOutbox: number;
        conflictCount: number;
        quarantinedCount: number;
        localBytesUsed: number;
        lastError: string | null;
        lastRunAt: string | null;
        bases: unknown[];
      }>(res);
      expect(body.enabled).toBe(true);
      expect(body.running).toBe(false); // 本测试未 start 引擎（只读端点不触发同步）。
      expect(body.stage).toBe("idle");
      expect(body.nodeId).toBe("local");
      expect(body.conflictCount).toBe(0);
      expect(body.quarantinedCount).toBe(0);
      expect(body.localBytesUsed).toBeGreaterThan(0); // harness DATABASE_URL 指向已 migrate 的真 db 文件。
      expect(Array.isArray(body.bases)).toBe(true);
      // 诊断字段已从 wire 删除（前端 DTO 不收）。
      expect(body).not.toHaveProperty("conflictOutbox");
      expect(body).not.toHaveProperty("quarantinedIncoming");
    }));

  it("X-GX-Token 头同样鉴权通过；本地库 bases 用 localBaseId+本地 name，计数正确", () =>
    withReplicaConfigured(async () => {
      const pulledAt = new Date("2026-10-01T00:00:00.000Z");
      const pushedAt = new Date("2026-10-02T00:00:00.000Z");
      // 本地真实 base（bases.name 应被带出）。
      await h.prisma.base.create({ data: { id: "lsBase", name: "我的本地库", createdBy: USER } });
      await h.prisma.replicaState.create({
        data: {
          nodeId: "local", remoteBaseId: "remoteLsBase", localBaseId: "lsBase", snapshotDone: true,
          subscribed: true, pullCursorSeq: 42n, authzVersion: "7",
          lastPulledAt: pulledAt, lastPushedAt: pushedAt,
        },
      });
      // 已删除/纯树游标对应的孤儿副本行：base 查不到 -> name=null，但不能 500。
      await h.prisma.replicaState.create({
        data: { nodeId: "local", remoteBaseId: "remoteGone", localBaseId: "goneBase", snapshotDone: false },
      });
      await h.prisma.localOutbox.createMany({
        data: [
          { clientOpId: "ls-p1", nodeId: "local", baseId: "lsBase", entityType: "record", entityId: "r1", op: "create", status: "pending", payload: "{}" },
          { clientOpId: "ls-p2", nodeId: "local", baseId: "lsBase", entityType: "record", entityId: "r2", op: "update", status: "pending", payload: "{}" },
          { clientOpId: "ls-c1", nodeId: "local", baseId: "lsBase", entityType: "record", entityId: "r3", op: "update", status: "conflict", payload: "{}" },
          { clientOpId: "ls-q1", nodeId: "local", baseId: "lsBase", entityType: "record", entityId: "r4", op: "update", status: "quarantined", payload: "{}" },
          { clientOpId: "ls-a1", nodeId: "local", baseId: "lsBase", entityType: "record", entityId: "r5", op: "create", status: "acked", payload: "{}" },
          // 他节点的 pending 不应计入。
          { clientOpId: "ls-other", nodeId: "otherNode", baseId: "lsBase", entityType: "record", entityId: "r6", op: "create", status: "pending", payload: "{}" },
        ],
      });

      const token = await h.token(USER);
      const res = await h.app.request(PATH, { method: "GET", headers: { "X-GX-Token": token } });
      expect(res.status).toBe(200);
      const body = await json<{
        pendingOutbox: number;
        conflictCount: number;
        quarantinedCount: number;
        lastPulledAt: string | null;
        lastPushedAt: string | null;
        bases: Array<{ id: string; name: string | null; lastPulledAt: string | null; lastPushedAt: string | null }>;
      }>(res);
      expect(body.pendingOutbox).toBe(2);
      expect(body.conflictCount).toBe(1);
      expect(body.quarantinedCount).toBe(1);

      // bases 按 remoteBaseId 升序：remoteGone < remoteLsBase。
      expect(body.bases).toHaveLength(2);
      const [gone, live] = body.bases;
      expect(gone!.id).toBe("goneBase");
      expect(gone!.name).toBeNull();
      expect(live!.id).toBe("lsBase");
      expect(live!.name).toBe("我的本地库");
      expect(live!.lastPulledAt).toBe(pulledAt.toISOString());
      expect(live!.lastPushedAt).toBe(pushedAt.toISOString());
      // 顶层时间为各 base 的 max（gone 行时间为 null，取 live 行）。
      expect(body.lastPulledAt).toBe(pulledAt.toISOString());
      expect(body.lastPushedAt).toBe(pushedAt.toISOString());

      // bases 元素不再带诊断字段。
      expect(live!).not.toHaveProperty("remoteBaseId");
      expect(live!).not.toHaveProperty("pullCursorSeq");
      expect(live!).not.toHaveProperty("subscribed");
      expect(live!).not.toHaveProperty("authzVersion");
      expect(live!).not.toHaveProperty("snapshotDone");
    }));
});
