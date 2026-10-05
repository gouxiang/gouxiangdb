// P1-S8b-1 行级可见行条件（RowConditions）【写入口】端到端：只验写入校验与同事务持久化，
// 不涉读求值（读过滤由下一片做）。复用 navRouteHarness 的真 app/真库夹具，不另起 app。
//
// 覆盖：
//  - happy：table 节点 + actions 含 r + isNotEmpty 条件 -> 200，conditions 落库且可解析，policyVersion 递增；
//  - dynamic：currentUser 条件（op is / valueType dynamic）可落库；
//  - fail-closed：version2 / 未知 op / 坏嵌套 / 非法 valueType -> 400，整单回滚（同批合法项也不写）；
//  - 节点级：base 节点带条件 -> 409 POLICY_NODE_KIND_INVALID；table 但动作无 r -> 400 POLICY_ACTION_INVALID；
//  - 清空：二次 PUT 不带 conditions，conditions 列回到 null。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  json,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { parseRowConditions } from "@gx/shared-types";

let h: CharHarness;
let baseNode = "";
let tableNode = "";
let fieldId = "";

async function putPolicies(node: string, body: unknown): Promise<Response> {
  return await h.app.request(`/api/v1/nodes/${node}/policies`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await h.auth("owner")) },
    body: JSON.stringify(body),
  });
}

async function policyVersion(): Promise<number> {
  const ws = await h.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
  return ws.policyVersion;
}

beforeAll(async () => {
  h = await makeNavHarness("gx-s8b-row-");
  await h.createUser("owner", { email: "s8b-owner@x.com", displayName: "所有者" });
  await h.createUser("target", { email: "s8b-target@x.com", displayName: "目标用户" });
  await h.createUser("other", { email: "s8b-other@x.com", displayName: "另一用户" });
  const seeded = await seedBaseWithStarter(h, "s8b");
  baseNode = nodeId("base", seeded.baseId);
  tableNode = nodeId("table", seeded.tableId);
  await h.prisma.field.create({
    data: { id: "s8b_field1", tableId: seeded.tableId, name: "标题", type: "singleLineText", order: 0 },
  });
  fieldId = "s8b_field1";
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("RowConditions 写入口", () => {
  it("happy：table+r+isNotEmpty 落库可解析，policyVersion 递增", async () => {
    const before = await policyVersion();
    const res = await putPolicies(tableNode, {
      upserts: [{
        subjectType: "user",
        subjectId: "target",
        actions: ["r"],
        conditions: {
          version: 1,
          filter: { kind: "condition", fieldId, op: "isNotEmpty" },
        },
      }],
    });
    expect(res.status).toBe(200);
    const row = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    });
    expect(row.conditions).not.toBeNull();
    const parsed = parseRowConditions(row.conditions);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(1);
    expect(parsed!.filter).toMatchObject({ kind: "condition", fieldId, op: "isNotEmpty" });
    expect(await policyVersion()).toBe(before + 1);
  });

  it("dynamic currentUser 条件可落库", async () => {
    const res = await putPolicies(tableNode, {
      upserts: [{
        subjectType: "user",
        subjectId: "target",
        actions: ["r"],
        conditions: {
          version: 1,
          filter: {
            kind: "condition",
            fieldId,
            op: "is",
            valueType: "dynamic",
            dynamicValue: "currentUser",
          },
        },
      }],
    });
    expect(res.status).toBe(200);
    const row = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    });
    const parsed = parseRowConditions(row.conditions);
    expect(parsed).not.toBeNull();
    expect(parsed!.filter).toMatchObject({
      kind: "condition",
      fieldId,
      op: "is",
      valueType: "dynamic",
      dynamicValue: "currentUser",
    });
  });

  it.each([
    ["version=2", { version: 2, filter: { kind: "condition", fieldId, op: "isNotEmpty" } }],
    ["未知 op", { version: 1, filter: { kind: "condition", fieldId, op: "wat" } }],
    ["坏嵌套 and 无 children", { version: 1, filter: { kind: "and" } }],
    ["非法 valueType", {
      version: 1,
      filter: { kind: "condition", fieldId, op: "is", valueType: "bogus" },
    }],
  ])("fail-closed：%s -> 400 且整单回滚", async (_label, conditions) => {
    const before = await policyVersion();
    const res = await putPolicies(tableNode, {
      upserts: [
        {
          subjectType: "user",
          subjectId: "other",
          actions: ["r"],
          conditions,
        },
        { subjectType: "user", subjectId: "target", actions: ["r"] },
      ],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("POLICY_BAD_INPUT");
    // 同批合法项（other 带坏条件本就不写；target 的 r）也不得落库。
    expect(await h.prisma.authPolicy.findFirst({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "other" },
    })).toBeNull();
    expect(await h.prisma.authPolicy.findFirst({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    })).not.toBeNull(); // 由前序用例落库的 target 行保留
    const targetRow = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    });
    expect(targetRow.actions).not.toContain("u");
    expect(await policyVersion()).toBe(before);
  });

  it("非 table（base）节点带 conditions -> 409 POLICY_NODE_KIND_INVALID", async () => {
    // base 节点内容动作 r 非法，用合法库门位 enter 承载，让请求先过动作校验再撞 conditions 关卡。
    const res = await putPolicies(baseNode, {
      upserts: [{
        subjectType: "user",
        subjectId: "target",
        actions: ["enter"],
        conditions: {
          version: 1,
          filter: { kind: "condition", fieldId, op: "isNotEmpty" },
        },
      }],
    });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("POLICY_NODE_KIND_INVALID");
  });

  it("table 节点动作不含 r（[u]）带 conditions -> 400 POLICY_ACTION_INVALID", async () => {
    const res = await putPolicies(tableNode, {
      upserts: [{
        subjectType: "user",
        subjectId: "other",
        actions: ["u"],
        conditions: {
          version: 1,
          filter: { kind: "condition", fieldId, op: "isNotEmpty" },
        },
      }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: string }>(res)).code).toBe("POLICY_ACTION_INVALID");
    expect(await h.prisma.authPolicy.findFirst({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "other" },
    })).toBeNull();
  });

  it("二次 PUT 不带 conditions 清空既有条件（列变 null）", async () => {
    // 前置：target 行当前 conditions 非空（由 happy/dynamic 用例落库）。
    const seededRow = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    });
    expect(seededRow.conditions).not.toBeNull();

    const res = await putPolicies(tableNode, {
      upserts: [{ subjectType: "user", subjectId: "target", actions: ["r"] }],
    });
    expect(res.status).toBe(200);
    const row = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: tableNode, subjectType: "user", subjectId: "target" },
    });
    expect(row.conditions).toBeNull();
  });
});
