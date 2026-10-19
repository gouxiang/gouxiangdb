// beta.2 S2c commit2：导航树（navnode）轨离线发件箱切面契约测试
// （真 createApp + 真迁移临时库 + 真 JWT + 真 manage_menu 权限，不 mock；复用 orgHarness）。
// 设计权威：DESIGN-OFFLINE-SYNC §5.1/§19.1/§19.6。
//
// 覆盖：
//  off 默认关：在线建组（POST /api/v1/nav/groups）→ local_outbox 0 行、分组建成（零行为锚点）。
//  on：在线建组 + 改名（PATCH）各 1 条 outbox；entityType=navnode/op/baseId=null；treeVersion
//      随每条 +1；sync_op_log 有 clientId=c1 且 clientOpId 与 outbox 完全相同。
//  回放安全：push 树回放走 /api/v1/sync/push/tree → navRegistry.applyTx（不经 nodes.ts 路由），
//      即便副本 on 也不进 local_outbox（计数不变），但 treeVersion 推进、oplog clientId 为设备 id。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "../../../routes/v1/org/__tests__/orgHarness.js";

let h: OrgHarness;
const OWNER = "s2ct_owner";
const REPLAY_CLIENT = "s2ct-replay-device";

const ENV_KEYS = ["GX_OFFLINE_REPLICA", "GX_OFFLINE_NODE_ID", "GX_OFFLINE_CLIENT_ID", "GX_SYNC_SERVER"] as const;
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
/**
 * 开副本切面（真实设 env）。syncServer 控制 GX_SYNC_SERVER：
 *  - "off"：仅副本切面激活 → 在线直写只推进一次本地钟（干净的 +1，baseVersion 可逐字节断言）。
 *  - "on"：两开关同真 → 在线直写先经服务端切面(srv)再经副本切面(local)，各一条 oplog、钟 +2
 *    （两角色独立、各写各的，符合设计）；回放用例需要服务端门 on 才能到 /push/tree。
 */
async function withReplicaOn<T>(fn: () => Promise<T>, syncServer: "on" | "off" = "off"): Promise<T> {
  const prev = snapshotEnv();
  process.env.GX_OFFLINE_REPLICA = "on";
  process.env.GX_OFFLINE_NODE_ID = "n1";
  process.env.GX_OFFLINE_CLIENT_ID = "c1";
  if (syncServer === "on") process.env.GX_SYNC_SERVER = "on";
  else delete process.env.GX_SYNC_SERVER;
  try {
    return await fn();
  } finally {
    restoreEnv(prev);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  return { ...(await h.auth(OWNER)), "Content-Type": "application/json" };
}

async function treeVersion(): Promise<bigint> {
  const row = await h.prisma.syncEntityVersion.findUnique({
    where: { id: "workspace_tree:ws_default" },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

let seq = 0;
function cid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 在线建组（nodes 路由）。 */
async function onlineCreateGroup(name: string, parentId: string | null = null): Promise<string> {
  const res = await h.app.request("/api/v1/nav/groups", {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ name, ...(parentId ? { parentId } : {}) }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** 在线改名（nodes 路由）。 */
async function onlineRenameGroup(groupId: string, name: string): Promise<void> {
  const res = await h.app.request(`/api/v1/nav/groups/${groupId}`, {
    method: "PATCH",
    headers: await authHeader(),
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
}

/** 树 push 回放（navRegistry 路径，不经 nodes.ts）。 */
async function replayTree(ops: unknown[]): Promise<number> {
  const res = await h.app.request("/api/v1/sync/push/tree", {
    method: "POST",
    headers: await authHeader(),
    body: JSON.stringify({ clientId: REPLAY_CLIENT, ops }),
  });
  expect(res.status).toBe(200);
  return res.status;
}

beforeAll(async () => {
  // 回放安全用例需经 /api/v1/sync/push/tree，故服务端总门 on；副本门单独按用例切换。
  process.env.GX_SYNC_SERVER = "on";
  h = await setupOrgHarness();
  await h.createUser(OWNER);
  await h.grantSystemRole(OWNER, "owner"); // owner 持 manage_menu
}, 120_000);

afterAll(async () => {
  delete process.env.GX_SYNC_SERVER;
  for (const k of ENV_KEYS) delete process.env[k];
  await h.cleanup();
});

describe("默认关：在线导航写零行为锚点", () => {
  it("GX_OFFLINE_REPLICA 未设时在线建组建成分组，但 local_outbox 0 行", async () => {
    const prev = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const before = await h.prisma.localOutbox.count();
      const gid = await onlineCreateGroup("s2ct_off_group");
      const node = await h.prisma.navNode.findUniqueOrThrow({ where: { id: gid } });
      expect(node.kind).toBe("group");
      expect(await h.prisma.localOutbox.count()).toBe(before);
      expect(await h.prisma.localOutbox.count()).toBe(0);
    } finally {
      restoreEnv(prev);
    }
  });
});

describe("on：在线建组/改名同事务落 outbox + 推进 treeVersion", () => {
  it("create_group + rename 各 1 条 outbox（navnode/baseId=null），钟 +2，oplog c1 同 clientOpId", () =>
    withReplicaOn(async () => {
      const before = await treeVersion();

      const gid = await onlineCreateGroup("s2ct_on_group");
      const createRows = await h.prisma.localOutbox.findMany({
        where: { entityId: gid, op: "nav_create_group" },
      });
      expect(createRows).toHaveLength(1);
      const createRow = createRows[0]!;
      expect(createRow.status).toBe("pending");
      expect(createRow.entityType).toBe("navnode");
      expect(createRow.nodeId).toBe("n1");
      expect(createRow.baseId).toBeNull();
      expect(createRow.baseVersion).toBe(before);
      expect((await treeVersion())).toBe(before + 1n);

      // oplog clientId=c1 且 clientOpId 与 outbox 完全相同。
      const createOp = await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: "c1", clientOpId: createRow.clientOpId },
      });
      expect(createOp.entityType).toBe("navnode");
      expect(createOp.baseId).toBeNull();
      expect(createRow.clientOpId.startsWith("local-")).toBe(true);

      // payload 形状：{op,entityType,workspaceId,...payload}，含 name/parentId。
      const createPayload = JSON.parse(createRow.payload) as {
        op: string; entityType: string; workspaceId: string; name?: string;
      };
      expect(createPayload.op).toBe("nav_create_group");
      expect(createPayload.entityType).toBe("navnode");
      expect(createPayload.workspaceId).toBe("ws_default");
      expect(createPayload.name).toBe("s2ct_on_group");

      // 改名：第二条 outbox，op=nav_rename，baseVersion=before+1。
      await onlineRenameGroup(gid, "s2ct_on_group_改");
      const renameRows = await h.prisma.localOutbox.findMany({
        where: { entityId: gid, op: "nav_rename" },
      });
      expect(renameRows).toHaveLength(1);
      const renameRow = renameRows[0]!;
      expect(renameRow.baseId).toBeNull();
      expect(renameRow.baseVersion).toBe(before + 1n);
      expect((await treeVersion())).toBe(before + 2n);
      await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: "c1", clientOpId: renameRow.clientOpId },
      });
      const renamePayload = JSON.parse(renameRow.payload) as { name?: string };
      expect(renamePayload.name).toBe("s2ct_on_group_改");
    }));
});

describe("回放安全：push/tree 走 navRegistry，不经 nodes.ts，不进 local_outbox", () => {
  it("即便副本 on，回放 nav_create_group 推进 treeVersion 但 local_outbox 计数不变", () =>
    withReplicaOn(async () => {
      const outboxBefore = await h.prisma.localOutbox.count();
      const treeBefore = await treeVersion();
      const replayGid = `s2ct_replay_grp_${seq}`;
      await replayTree([
        {
          clientOpId: cid("rp"), entityType: "navnode", entityId: replayGid,
          op: "nav_create_group", baseVersion: treeBefore.toString(),
          payload: { name: "回放分组", parentId: "root", ord: 0 },
        },
      ]);

      // 树钟推进、分组建成，但没有进本地发件箱。
      expect((await treeVersion())).toBe(treeBefore + 1n);
      const node = await h.prisma.navNode.findUniqueOrThrow({ where: { id: replayGid } });
      expect(node.kind).toBe("group");
      expect(await h.prisma.localOutbox.count()).toBe(outboxBefore);

      // 回放 oplog 的 clientId 是设备 id（REPLAY_CLIENT），不是本地副本 c1。
      const op = await h.prisma.syncOpLog.findFirstOrThrow({
        where: { clientId: REPLAY_CLIENT, entityId: replayGid, op: "nav_create_group" },
      });
      expect(op.baseId).toBeNull();
    }, "on"));
});
