// beta.2 S3-runtime：定时同步引擎单例编排测试。
// 设计权威：DESIGN-OFFLINE-SYNC.md（离线优先双向同步，beta.2 B2）。
//
// 哲学：真临时库 + 真 migrate（不 mock DB，不碰 dev.db）；三个 once 内核用假 transport（不起 HTTP server）；
// 引擎单例经动态 import 在 setupOrgHarness 注入 DATABASE_URL 之后加载（见 replicaPush.test.ts 文件头同款说明）。
//
// 覆盖：
//   A. 默认关：无 config / flag 未开 / 有 URL 无 flag → start 返回 false、不启动、假传输零调用。
//   B. 一轮顺序 list → pull → push → reconcile；成功 push base 桶回写 lastPushedAt/subscribed；
//      accepted 回执带 entityId 时经 settleRowsTx 写入 sync_id_map（#945 接线端到端验证）。
//   C. 传输错误不炸进程：list/visibility 抛错被吞进 lastError，runReplicaSyncOnce 正常 resolve、仍 running。
//   D. inFlight 防重入：首轮卡在 list 时，手动触发两次都立即跳过（不重复拉列表）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";
import type { ReplicaPullTransport } from "../replicaPullTransport.js";
import type { ReplicaPushTransport } from "../replicaPushTransport.js";
import type { ReplicaVisibilityTransport } from "../replicaReconcile.js";
import type { VisibilityReport } from "../visibility.js";

type RuntimeMod = typeof import("../replicaSyncRuntime.js");
let mod: RuntimeMod;

let h: OrgHarness;
const OWNER = "rt_owner";
const NODE = "n1";
const CLIENT = "c1";
const BASE = "baseX";

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
function replicaEnvOn(): void {
  process.env.GX_OFFLINE_REPLICA = "on"; // once 内核首行读【全局】env 守门，必须置位。
  process.env.GX_OFFLINE_NODE_ID = NODE;
  process.env.GX_OFFLINE_CLIENT_ID = CLIENT;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 假传输小工具 ──
function emptyPullPage(baseId: string) {
  return { baseId, ops: [], nextCursor: "0", hasMore: false, authzVersion: 0 };
}
function throwingVisibility(err: Error): ReplicaVisibilityTransport {
  return {
    async fetchVisibility(): Promise<VisibilityReport> {
      throw err;
    },
  };
}

async function seedReplicaBase(): Promise<void> {
  // 已完成快照的副本行（pull 跳过 bootstrap）；authzVersion="0" 且 visibility 回 0 → identical，零擦除副作用。
  await h.prisma.replicaState.create({
    data: {
      nodeId: NODE, remoteBaseId: BASE, localBaseId: BASE, snapshotDone: true,
      subscribed: false, pullCursorSeq: 0n, authzVersion: "0",
    },
  });
  // 一条待推 record outbox（合法 create payload，可被适配发送）。
  await h.prisma.localOutbox.create({
    data: {
      clientOpId: "rt-op-1", nodeId: NODE, baseId: BASE, entityType: "record", entityId: "rec1",
      op: "create", baseVersion: 0n, status: "pending",
      payload: JSON.stringify({ op: "create", tableId: BASE, changes: [{ fieldId: "f1", fieldName: "F1", before: null, after: "v" }] }),
    },
  });
}

/** 等引擎首轮（start 即 fire-and-forget）跑完：纯轮询 status，不额外触发新轮（保 trace 干净）。 */
async function waitFirstRound(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = mod.replicaSyncRuntimeStatus();
    if (s.lastRunAt && !s.inFlight) return;
    await sleep(10);
  }
  throw new Error("等待引擎首轮完成超时");
}

beforeAll(async () => {
  h = await setupOrgHarness();
  mod = await import("../replicaSyncRuntime.js");
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner");
}, 120_000);

afterEach(async () => {
  await mod.stopReplicaSync().catch(() => {});
  restoreEnv(snapshotEnv());
});

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await h.cleanup();
});

// ───────────────── A. 默认关 fail-closed ─────────────────

describe("默认关闭：start 不建 timer/不跑", () => {
  it("完全无配置 -> false、未运行", async () => {
    const ok = await mod.startReplicaSync({ env: {} });
    expect(ok).toBe(false);
    expect(mod.isReplicaSyncRunning()).toBe(false);
  });

  it("flag 开但无远端 URL -> false", async () => {
    const ok = await mod.startReplicaSync({ env: { GX_OFFLINE_REPLICA: "on" } });
    expect(ok).toBe(false);
    expect(mod.isReplicaSyncRunning()).toBe(false);
  });

  it("有 URL 但 flag 未开 -> false（once 内核守门同源）", async () => {
    const ok = await mod.startReplicaSync({ env: { GX_REPLICA_REMOTE_URL: "http://x" } });
    expect(ok).toBe(false);
    expect(mod.isReplicaSyncRunning()).toBe(false);
  });

  it("未启动时 runReplicaSyncOnce 返回 false", async () => {
    expect(await mod.runReplicaSyncOnce()).toBe(false);
  });
});

// ───────────────── B. 一轮顺序 + push 回写 + id_map ─────────────────

describe("一轮 list→pull→push→reconcile 顺序与回写", () => {
  it("四阶段顺序正确；push 成功回写 subscribed/lastPushedAt；accepted entityId 落 sync_id_map", async () => {
    await seedReplicaBase();
    replicaEnvOn();
    // 统一 trace：按调用先后追加标记，用于断言 list→pull(sub/pull)→push→reconcile(vis) 全局顺序。
    const trace: string[] = [];
    const pull: ReplicaPullTransport = {
      async subscribeBase(baseId) {
        trace.push(`sub:${baseId}`);
        return { clientId: CLIENT, scopeType: "base", scopeId: baseId, cursorSeq: "0", snapshotDone: true, authzVersion: 0 };
      },
      async subscribeTree() {
        trace.push("sub:tree");
        return { clientId: CLIENT, scopeType: "workspace_tree", scopeId: "ws_default", cursorSeq: "0", snapshotDone: true, authzVersion: 0, scope: "workspace_tree", treeVersion: "0" };
      },
      async fetchBootstrap() {
        throw new Error("snapshotDone=true，不应触发 bootstrap");
      },
      async pullBase(baseId) {
        trace.push(`pull:${baseId}`);
        return emptyPullPage(baseId);
      },
      async pullTree() {
        trace.push("pull:tree");
        return { scope: "workspace_tree", scopeId: "ws_default", ops: [], nextCursor: "0", hasMore: false, treeVersion: "0", authzVersion: 0 };
      },
    };
    const push: ReplicaPushTransport = {
      async pushBase(baseId, ops) {
        trace.push(`push:${baseId}`);
        return {
          baseId,
          results: ops.map((o) => ({
            clientOpId: o.clientOpId, status: "accepted" as const, seq: "1", newVersion: o.baseVersion,
            // 回服务端实体 id（=本地 id）：settleRowsTx accepted 分支应 bind 进 sync_id_map。
            entityId: o.entityId,
          })),
        };
      },
      async pushTree(ops) {
        trace.push("push:tree");
        return { scope: "workspace_tree" as const, results: ops.map((o) => ({ clientOpId: o.clientOpId, status: "accepted" as const, seq: "1", newVersion: o.baseVersion })) };
      },
    };
    const visibility: ReplicaVisibilityTransport = {
      async fetchVisibility(baseId) {
        trace.push(`vis:${baseId}`);
        return { baseId, authzVersion: 0, serverTime: new Date(0).toISOString(), tables: [] };
      },
    };

    const started = await mod.startReplicaSync({
      config: { remoteUrl: "http://127.0.0.1:1", remoteToken: "t", intervalMs: 30_000 },
      env: { GX_OFFLINE_REPLICA: "on", GX_OFFLINE_NODE_ID: NODE, GX_OFFLINE_CLIENT_ID: CLIENT },
      hostname: "h1",
      pullTransport: pull,
      pushTransport: push,
      visibilityTransport: visibility,
      listRemoteBaseIds: async () => {
        trace.push("list");
        return [BASE];
      },
    });
    expect(started).toBe(true);
    await waitFirstRound();

    // 断言【首轮】全局阶段顺序：list → subscribe/pull(base，树在其后) → push(base) → reconcile(vis)。
    const idx = (m: string) => trace.indexOf(m);
    expect(idx("list")).toBeGreaterThanOrEqual(0);
    expect(idx(`sub:${BASE}`)).toBeGreaterThan(idx("list"));
    expect(idx(`pull:${BASE}`)).toBeGreaterThan(idx(`sub:${BASE}`));
    expect(idx(`push:${BASE}`)).toBeGreaterThan(idx(`pull:${BASE}`));
    expect(idx(`vis:${BASE}`)).toBeGreaterThan(idx(`push:${BASE}`));
    // 树轨在所有 base 之后拉取一次。
    expect(trace.indexOf("sub:tree")).toBeGreaterThan(idx(`pull:${BASE}`));

    // push 成功回写 replica_state。
    const state = await h.prisma.replicaState.findUniqueOrThrow({
      where: { nodeId_remoteBaseId: { nodeId: NODE, remoteBaseId: BASE } },
    });
    expect(state.subscribed).toBe(true);
    expect(state.lastPushedAt).toBeTruthy();

    // accepted 回执 entityId 经 settleRowsTx.bindRemoteIdTx 落 sync_id_map。
    const mapped = await h.prisma.syncIdMap.findUnique({ where: { clientOpId: "rt-op-1" } });
    expect(mapped).toBeTruthy();
    expect(mapped!.localEntityId).toBe("rec1");
    expect(mapped!.remoteEntityId).toBe("rec1");
    // outbox 终态 acked。
    const ob = await h.prisma.localOutbox.findUniqueOrThrow({ where: { clientOpId: "rt-op-1" } });
    expect(ob.status).toBe("acked");
  });
});

// ───────────────── C. 传输错不炸进程 ─────────────────

describe("传输错误吞进 lastError，不炸进程", () => {
  it("list 抛错 + visibility 抛错：首轮正常结束、仍 running、lastError 非空", async () => {
    await h.prisma.replicaState.create({
      data: { nodeId: NODE, remoteBaseId: "bErr", localBaseId: "bErr", snapshotDone: true, pullCursorSeq: 0n, authzVersion: "0" },
    });
    replicaEnvOn();
    const { ReplicaTransportError } = await import("../replicaPushTransport.js");
    const started = await mod.startReplicaSync({
      config: { remoteUrl: "http://127.0.0.1:1", remoteToken: "", intervalMs: 30_000 },
      env: { GX_OFFLINE_REPLICA: "on", GX_OFFLINE_NODE_ID: NODE, GX_OFFLINE_CLIENT_ID: CLIENT },
      listRemoteBaseIds: async () => {
        throw new Error("ECONNREFUSED-list");
      },
      // list 失败时不 pull；reconcile 仍对本地副本跑，让其 visibility 抛传输错。
      visibilityTransport: throwingVisibility(new ReplicaTransportError("boom", 500)),
    });
    expect(started).toBe(true);
    await expect(waitFirstRound()).resolves.toBeUndefined();
    expect(mod.isReplicaSyncRunning()).toBe(true);
    expect(mod.replicaSyncRuntimeStatus().lastError).toBeTruthy();
    // 再手动触发一轮也不 reject（下轮自动重试语义）。
    await expect(mod.runReplicaSyncOnce()).resolves.toBe(true);
  });
});

// ───────────────── D. inFlight 防重入 ─────────────────

describe("inFlight 防回调重入", () => {
  it("首轮卡在 list 时，并发手动触发不重复拉列表", async () => {
    replicaEnvOn();
    let listCalls = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const started = await mod.startReplicaSync({
      config: { remoteUrl: "http://127.0.0.1:1", remoteToken: "", intervalMs: 30_000 },
      env: { GX_OFFLINE_REPLICA: "on", GX_OFFLINE_NODE_ID: NODE, GX_OFFLINE_CLIENT_ID: CLIENT },
      // 注入全离线 transport：本用例只验证 inFlight 防重入，绝不让首轮 reconcile 误打真实 127.0.0.1:1。
      pullTransport: {
        async subscribeBase() {
          return { clientId: CLIENT, scopeType: "base", scopeId: "x", cursorSeq: "0", snapshotDone: true, authzVersion: 0 };
        },
        async subscribeTree() {
          return { clientId: CLIENT, scopeType: "workspace_tree", scopeId: "ws_default", cursorSeq: "0", snapshotDone: true, authzVersion: 0, scope: "workspace_tree", treeVersion: "0" };
        },
        async fetchBootstrap() {
          throw new Error("不应触发 bootstrap");
        },
        async pullBase() {
          throw new Error("list 返回空，不应 pull");
        },
        async pullTree() {
          throw new Error("list 返回空，不应拉树");
        },
      },
      pushTransport: {
        async pushBase() {
          throw new Error("无 pending outbox，不应 push base");
        },
        async pushTree() {
          throw new Error("无 pending outbox，不应 push tree");
        },
      },
      visibilityTransport: {
        async fetchVisibility(baseId) {
          return { baseId, authzVersion: 0, serverTime: new Date(0).toISOString(), tables: [] };
        },
      },
      listRemoteBaseIds: async () => {
        listCalls++;
        await gate;
        return [];
      },
    });
    expect(started).toBe(true);
    // 等首轮 tick 进入 list（owner 查询很快），此时 inFlight=true。
    await sleep(50);
    // 两次手动触发都应被 inFlight 立即挡回（返回 true 但不跑新轮）。
    expect(await mod.runReplicaSyncOnce()).toBe(true);
    expect(await mod.runReplicaSyncOnce()).toBe(true);
    expect(listCalls).toBe(1); // 没有因重入再次拉列表。
    releaseGate();
    await waitFirstRound();
    expect(listCalls).toBe(1);
    expect(mod.replicaSyncRuntimeStatus().inFlight).toBe(false);
  });
});
