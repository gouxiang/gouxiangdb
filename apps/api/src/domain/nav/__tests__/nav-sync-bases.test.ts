// M3/S3 路由层写点同步测试（bases.ts：#1 建 / #2 改名 / #3 软删）。
//
// 每写点三条真库真 HTTP 证明（裁决 9）：
//  - 正向：操作成功后 reconcile 无阻断差异（A+B+C=0），节点状态符合实体；
//  - 方向①：trigger 让 nav_nodes 写失败 -> HTTP 500 且实体写整体回滚（行不存在/字段未变）；
//  - 方向②：trigger 让实体表写失败 -> nav 无残留/未变（同事务回滚）。
// trigger 不随事务回滚，每例 afterEach 必清。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  json,
  failNavWrites,
  failEntityWrite,
  stopFailing,
  assertNoBlockingDiffs,
  type CharHarness,
} from "./navRouteHarness.js";
import { nodeId } from "../backfill.js";

let h: CharHarness;
const OWNER = "owner";

beforeAll(async () => {
  h = await makeNavHarness("gx-m3-s3-bases-");
  await h.createUser(OWNER, { email: "owner@x.com", displayName: "Owner" });
});
afterAll(async () => {
  await h.cleanup();
});
afterEach(async () => {
  await stopFailing(h);
});

const post = async (url: string, body: unknown) =>
  h.app.request(url, { method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = async (url: string, body: unknown) =>
  h.app.request(url, { method: "PATCH", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = async (url: string) =>
  h.app.request(url, { method: "DELETE", headers: await h.auth(OWNER) });

describe("#1 建 base（含 starter table/view，多写收紧进单事务）", () => {
  it("正向：201，base+table+view 三节点齐、三层 path，reconcile 0 阻断差异", async () => {
    const res = await post("/api/bases", { name: "B1" });
    expect(res.status).toBe(201);
    const { base } = await json<{ base: { id: string } }>(res);
    await assertNoBlockingDiffs(h);
    const table = await h.prisma.table.findFirstOrThrow({ where: { baseId: base.id } });
    const view = await h.prisma.view.findFirstOrThrow({ where: { tableId: table.id } });
    const n = await h.prisma.navNode.findMany({ where: { deletedAt: null } });
    expect(n.map((x) => x.resourceId).sort()).toEqual([base.id, table.id, view.id].sort());
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", view.id) } })).depth).toBe(3);
  });

  it("方向①：nav 写失败 -> 500，base/成员/starter 表全部回滚（无半截实体）", async () => {
    await failNavWrites(h);
    const res = await post("/api/bases", { name: "B1-rollback" });
    expect(res.status).toBe(500);
    expect(await h.prisma.base.count({ where: { name: "B1-rollback" } })).toBe(0);
    expect(await h.prisma.member.count({ where: { userId: OWNER } })).toBe(1); // 仅正向用例那一条
    expect(await h.prisma.navNode.count({ where: { resourceType: "base" } })).toBe(1); // 仅正向用例
  });

  it("方向②：实体写失败（bases INSERT 失败）-> 500，nav 无新增节点", async () => {
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "bases", "INSERT");
    const res = await post("/api/bases", { name: "B1-entityfail" });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});

describe("#2 base 改名", () => {
  beforeEach(async () => {
    // 每组一个干净 base
  });
  it("正向：节点 name 同步，reconcile 0 阻断", async () => {
    const res = await post("/api/bases", { name: "B2" });
    const { base } = await json<{ base: { id: string } }>(res);
    const pr = await patch(`/api/bases/${base.id}`, { name: "B2-renamed" });
    expect(pr.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("base", base.id) } })).name).toBe("B2-renamed");
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 写失败 -> 500，实体 name 未变（同事务回滚）", async () => {
    const { base } = await json<{ base: { id: string } }>(await post("/api/bases", { name: "B2b" }));
    await failNavWrites(h);
    const pr = await patch(`/api/bases/${base.id}`, { name: "B2b-x" });
    expect(pr.status).toBe(500);
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: base.id } })).name).toBe("B2b");
  });

  it("方向②：实体更新失败 -> 500，节点 name 未变", async () => {
    const { base } = await json<{ base: { id: string } }>(await post("/api/bases", { name: "B2c" }));
    await failEntityWrite(h, "bases", "UPDATE");
    const pr = await patch(`/api/bases/${base.id}`, { name: "B2c-x" });
    expect(pr.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("base", base.id) } })).name).toBe("B2c");
  });
});

describe("#3 base 软删（base+tables 收紧进单事务，nav 整棵子树软删）", () => {
  it("正向：base/table/view 节点全软删（行保留），实体 deletedAt 置位，reconcile 0 阻断", async () => {
    const { base } = await json<{ base: { id: string } }>(await post("/api/bases", { name: "B3" }));
    const table = await h.prisma.table.findFirstOrThrow({ where: { baseId: base.id } });
    const view = await h.prisma.view.findFirstOrThrow({ where: { tableId: table.id } });
    const res = await del(`/api/bases/${base.id}`);
    expect(res.status).toBe(200);
    for (const [kind, rid] of [["base", base.id], ["table", table.id], ["view", view.id]] as const) {
      expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId(kind, rid) } })).deletedAt).not.toBeNull();
    }
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: base.id } })).deletedAt).not.toBeNull();
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 写失败 -> 500，base/tables 未软删（回滚）", async () => {
    const { base } = await json<{ base: { id: string } }>(await post("/api/bases", { name: "B3b" }));
    await failNavWrites(h);
    const res = await del(`/api/bases/${base.id}`);
    expect(res.status).toBe(500);
    expect((await h.prisma.base.findUniqueOrThrow({ where: { id: base.id } })).deletedAt).toBeNull();
    expect(await h.prisma.table.count({ where: { baseId: base.id, deletedAt: null } })).toBe(1);
  });

  it("方向②：实体软删失败 -> 500，nav 子树未软删", async () => {
    const { base } = await json<{ base: { id: string } }>(await post("/api/bases", { name: "B3c" }));
    await failEntityWrite(h, "bases", "UPDATE");
    const res = await del(`/api/bases/${base.id}`);
    expect(res.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("base", base.id) } })).deletedAt).toBeNull();
  });
});
