// POST /api/local-sync/sync-now 手动触发一轮端点契约测试（真迁移临时库 + 真 createApp + 真 JWT，不 mock HTTP）。
//
// 覆盖（be-replica-wire1 三用例）：
//   A. 总门 off（GX_OFFLINE_REPLICA 未开 / 无远端 URL）-> 在鉴权之前 404 SYNC_DISABLED。
//   B. 总门 on + 未登录 -> 401（配置门与鉴权是两道独立闸，POST 与 GET 同源复用组首 use("*")）。
//   C. 总门 on + 登录 -> 200，返回体六字段齐；并【强断言】真触发了一轮：
//      注入假 lister 计数 +1 且可推进时钟，lastRunAt 从首轮时间推进到本轮时间，triggered=true、running=true。
//
// 加载纪律：localSync.js / replicaSyncRuntime.js 顶部静态 import db.ts（模块作用域即 new PrismaClient），
//   必须在 setupOrgHarness 注入临时 DATABASE_URL 之后【动态 import】；本文件只走 h.app.request + 引擎单例。
//
// 隔离：独立文件（不挤进已 205 行的 localSync.test.ts，守单文件 ≤300 行硬门禁）。引擎进程内单例仅在
//   本文件模块作用域内活动，afterEach 停引擎并清场，不污染同进程其它文件（各自 h.app 独立库）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupOrgHarness, json, type OrgHarness } from "../v1/org/__tests__/orgHarness.js";

type RuntimeMod = typeof import("../../domain/sync/replicaSyncRuntime.js");
let mod: RuntimeMod;
let h: OrgHarness;

const PATH = "/api/local-sync/sync-now";
const USER = "sn_user";
const NODE = "local";
const CLIENT = "c1";

// 路由门读 process.env（replicaSyncConfig() 无参走 process.env）；引擎 once 内核读【全局】env 守门。
const CFG_KEYS = [
  "GX_OFFLINE_REPLICA",
  "GX_REPLICA_REMOTE_URL",
  "GX_REPLICA_REMOTE_TOKEN",
  "GX_OFFLINE_NODE_ID",
  "GX_OFFLINE_CLIENT_ID",
] as const;

function clearCfg(): void {
  for (const k of CFG_KEYS) delete process.env[k];
}
/** 门 on 的 env 窗口（路由总门 replicaSyncConfig 走 process.env）。 */
function gateOn(): void {
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_REPLICA_REMOTE_URL = "http://127.0.0.1:59999";
  process.env.GX_REPLICA_REMOTE_TOKEN = "t";
  process.env.GX_OFFLINE_NODE_ID = NODE;
  process.env.GX_OFFLINE_CLIENT_ID = CLIENT;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  clearCfg();
  h = await setupOrgHarness();
  mod = await import("../../domain/sync/replicaSyncRuntime.js");
  await h.createUser(USER);
  // 一轮需要本地存在 ACTIVE role_owner，否则 runRound 在 list 之前早退（lastError 提示无属主）。
  await h.grantSystemRole(USER, "owner");
}, 120_000);

beforeEach(async () => {
  await mod.stopReplicaSync().catch(() => {});
  clearCfg();
});

afterEach(async () => {
  await mod.stopReplicaSync().catch(() => {});
  clearCfg();
});

afterAll(async () => {
  await mod.stopReplicaSync().catch(() => {});
  clearCfg();
  await h.cleanup();
});

/** 等首轮（start 即 fire-and-forget）跑完：纯轮询 status，不额外触发新轮。 */
async function waitFirstRound(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = mod.replicaSyncRuntimeStatus();
    if (s.lastRunAt && !s.inFlight) return;
    await sleep(10);
  }
  throw new Error("等待引擎首轮完成超时");
}

describe("A. POST /sync-now 总门 off -> 404 SYNC_DISABLED（鉴权之前）", () => {
  it("全未配 + 登录态 -> 404（不是 401/405）", async () => {
    const res = await h.app.request(PATH, { method: "POST", headers: await h.auth(USER) });
    expect(res.status).toBe(404);
    expect((await json<{ code: string }>(res)).code).toBe("SYNC_DISABLED");
  });
});

describe("B. POST /sync-now 总门 on + 未登录 -> 401", () => {
  it("配置齐全但无鉴权头 -> 401", async () => {
    gateOn();
    const res = await h.app.request(PATH, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("C. POST /sync-now 门 on + 登录 -> 200 且真触发一轮", () => {
  it("六字段齐；triggered/running=true；lister 再被调一次；lastRunAt 推进", async () => {
    gateOn();
    // 可推进的假时钟：每次取值 +1ms（锁 acquire / lastRunAt / 心跳各取一次），
    // 保证「手动轮」的 lastRunAt 严格晚于「首轮」。
    let clockMs = Date.parse("2026-10-24T00:00:00.000Z");
    const now = () => new Date(clockMs++);
    let listCalls = 0;
    const started = await mod.startReplicaSync({
      config: { remoteUrl: "http://127.0.0.1:1", remoteToken: "t", intervalMs: 30_000 },
      env: {
        GX_OFFLINE_REPLICA: "on",
        GX_OFFLINE_NODE_ID: NODE,
        GX_OFFLINE_CLIENT_ID: CLIENT,
      },
      hostname: "sn-h1",
      now,
      // 空 base 列表：owner 有效、outbox 空 -> 不 pull / 不 reconcile；push 空 outbox 在查库后即返回，
      // 默认 HTTP transport 永不被调用（绝打不到 127.0.0.1:1）。lister 每轮被调一次，用于强断言。
      listRemoteBaseIds: async () => {
        listCalls++;
        return [];
      },
    });
    expect(started).toBe(true);
    await waitFirstRound();
    const before = mod.replicaSyncRuntimeStatus();
    expect(before.lastRunAt).toBeTruthy();
    const listAfterFirst = listCalls;
    expect(listAfterFirst).toBeGreaterThanOrEqual(1);
    const firstRunAtIso = before.lastRunAt!.toISOString();

    const res = await h.app.request(PATH, { method: "POST", headers: await h.auth(USER) });
    expect(res.status).toBe(200);
    const body = await json<{
      triggered: boolean;
      running: boolean;
      inFlight: boolean;
      stage: string;
      lastError: string | null;
      lastRunAt: string | null;
    }>(res);

    // 六字段齐备且类型正确。
    for (const k of ["triggered", "running", "inFlight", "stage", "lastError", "lastRunAt"] as const) {
      expect(body).toHaveProperty(k);
    }
    expect(body.triggered).toBe(true); // 引擎已启动，runReplicaSyncOnce 真跑了一轮。
    expect(body.running).toBe(true);
    expect(body.inFlight).toBe(false); // await 已等到本轮结束。
    expect(body.stage).toBe("idle");
    expect(body.lastError).toBeNull(); // owner 存在 + 空列表/空 outbox：一轮无错。
    // 强断言：lister 多调一次且 lastRunAt 从首轮时间推进（证明不是回陈旧态、确实跑了新轮）。
    expect(listCalls).toBe(listAfterFirst + 1);
    expect(body.lastRunAt).not.toBeNull();
    expect(body.lastRunAt!.localeCompare(firstRunAtIso)).toBeGreaterThan(0);
  });
});
