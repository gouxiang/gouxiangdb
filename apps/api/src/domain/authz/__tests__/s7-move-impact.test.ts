// M4/S7 move-impact 升级端到端：三源逐节点对称差人数 + willBreakInheritanceHint 真值。
//
// 拓扑：s7_d_move 的实体父是 s7_d_secret（nav 物理链 d_move -> secret(inheritAncestors=0) -> kb）。
// 授予挂在 cutoff 边界 secret 节点（kb 授予被 K 挡住，荫不进 restricted 子树）：
//   - subjectType=user s7_lose_direct r；subjectType=dept s7_deptB r（deptB 成员 2 人）。
// 预览把 d_move 移到根层空 group：cutoff 链不再含 secret -> 3 人失访；最近 restricted 祖先
// secret -> null，hint=true。对照组 d1（父 kb 无边界）移入空 group：hint=false、人数 0
// （d1 自身 ACL 投影随节点走，DIRECT 两侧皆可见）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupS7Fixture, OWNER, type S7Fixture } from "./s7Harness.js";
import { nodeId } from "../../nav/backfill.js";
import { json } from "../../nav/__tests__/characterization/charHarness.js";
import type { MoveImpactDTO } from "@gx/shared-types";

let fx: S7Fixture;
const I = (): S7Fixture["ids"] => fx.ids;

beforeAll(async () => {
  fx = await setupS7Fixture();
  // secret 节点授予：user 直授 1 + deptB（成员 s7_deptBuser/s7_gain）。
  await fx.prisma.authPolicy.createMany({
    data: [
      {
        id: "s7_p_secret_direct", workspaceId: "ws_default", nodeId: nodeId("doc", "s7_d_secret"),
        subjectType: "user", subjectId: "s7_lose_direct", actions: "r", reason: "s7:seed", createdBy: OWNER,
      },
      {
        id: "s7_p_secret_deptb", workspaceId: "ws_default", nodeId: nodeId("doc", "s7_d_secret"),
        subjectType: "dept", subjectId: "s7_deptB", actions: "r", reason: "s7:seed", createdBy: OWNER,
      },
    ],
  });
}, 120000);

afterAll(async () => {
  await fx.cleanup();
});

async function impact(node: string, newParentId: string): Promise<MoveImpactDTO> {
  const res = await fx.call("GET", `/api/v1/nodes/${node}/move-impact?newParentId=${newParentId}`, OWNER);
  expect(res.status).toBe(200);
  return json<MoveImpactDTO>(res);
}

describe("move-impact 三源人数 + restricted 边界 hint", () => {
  it("移出 restricted 子树：hint=true，三源失访 3 人（user 1 + deptB 子树 2），creator/owner 不计", async () => {
    const r = await impact(nodeId("doc", I().dMove), I().gA);
    expect(r.willBreakInheritanceHint).toBe(true);
    expect(r.affectedUserCount).toBe(3);
    expect(r.subtreeItemCount).toBe(1); // d_move 一个 doc 内容
    expect(r.shortcutCount).toBe(0);
  });

  it("无边界移动（grouped 已在 gA，仅自身 direct 授予）：hint=false、人数 0（两侧可见集不变）", async () => {
    // grouped 物理父是 gA（group 透明），授予只在 doc 自身（ADMIN 直授 r）+ OWNER creator 兜底；
    // 从 gA 移到 gP（同为根层空 group），cutoff 两侧都只收集自身 -> 对称差 0、无 restricted 边界。
    const r = await impact(nodeId("doc", "s7_d_grouped"), I().gP);
    expect(r.willBreakInheritanceHint).toBe(false);
    expect(r.affectedUserCount).toBe(0);
    expect(r.subtreeItemCount).toBe(1);
  });

  it("确认执行跨边界移动后：节点物理父改写、navVersion bump；旧来源再不可见（scope 对拍）", async () => {
    const node = nodeId("doc", I().dMove);
    const res = await fx.call("POST", `/api/v1/nodes/${node}/move`, OWNER, { newParentId: I().gA, confirmed: true });
    expect(res.status).toBe(200);
    const row = await fx.prisma.navNode.findUniqueOrThrow({ where: { id: node } });
    expect(row.parentId).toBe(I().gA);
    // 移动后 secret 的授予不再荫及 d_move：失访用户 scope 不可见，creator OWNER 仍可见。
    const scope = await fx.call("GET", "/api/v1/authz/visible-scope?userId=s7_lose_direct", OWNER);
    const body = await json<{ nodeIds: string[] }>(scope);
    expect(body.nodeIds).not.toContain(node);
    const ownerScope = await fx.call("GET", "/api/v1/authz/visible-scope?userId=s7_owner", OWNER);
    const ownerBody = await json<{ nodeIds: string[] }>(ownerScope);
    expect(ownerBody.nodeIds).toContain(node);
    // 移出后再预览"原地不动"无意义；预览移到另一个根 group：两侧 cutoff 均无 secret -> hint=false。
    const r2 = await impact(node, I().gP);
    expect(r2.willBreakInheritanceHint).toBe(false);
  });
});
