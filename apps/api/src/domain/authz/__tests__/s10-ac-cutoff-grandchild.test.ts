// M4/S10 AC-M4-2 孙节点经 cutoff(K) 边界规则端到端（真库真 effective，不 mock）。
//
// collectibleChainIndexes 纯函数已在 cutoff.test 覆盖；本文件锁定真实 decide/effective 在
// 三层 kb -> K(restricted, inherit=0) -> C(inherit=1) -> G(孙, inherit=1) 上的端到端口径：
//   规则1 K 自身策略仍及子孙：用户仅被授 K 节点 r（kb 无授予），则 C/G cutoff 收集都含 K，可见。
//   规则2 子孙链在 K 截断：用户仅被授 kb 节点 r（K 无授予），则 C/G cutoff 止于 K、不收 kb，不可见；
//         同一用户对 K 之外的普通库文档（不处在 restricted 子树）仍可见（kb 授予对它们有效）。
//
// EARS 其余项（409 门/审计 diff/豁免/重开 gaining/幂等）已由 s7-inheritance 14 例覆盖，不重复。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, json, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

let h: CharHarness;
const KB = "s10k_kb";
const K = "s10k_k";
const C = "s10k_c";
const G = "s10k_g";
const OUT = "s10k_out";
const UK = "s10k_user_k"; // 仅授 K
const UB = "s10k_user_b"; // 仅授 kb

let kNode = "";
let cNode = "";
let gNode = "";
let outNode = "";

/** owner 视角查某用户对节点的 r 判定。 */
async function canR(userId: string, node: string): Promise<boolean> {
  const res = await h.app.request(`/api/v1/nodes/${node}/effective?userId=${userId}`, { headers: await h.auth("owner") });
  if (res.status === 403 || res.status === 404) return false;
  expect(res.status).toBe(200);
  const body = await json<{ perAction: Array<{ action: string; allowed: boolean }> }>(res);
  return body.perAction.find((p) => p.action === "r")!.allowed;
}

async function grant(node: string, subjectType: "user" | "dept" | "role", subjectId: string, id: string): Promise<void> {
  await h.prisma.authPolicy.create({
    data: { id, workspaceId: "ws_default", nodeId: node, subjectType, subjectId, actions: "r", reason: "policy:v1", createdBy: "seed" },
  });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s10-kcut-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  await h.createUser(UK, { email: "uk@x.com", displayName: "授K用户" });
  await h.createUser(UB, { email: "ub@x.com", displayName: "授kb用户" });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });
  await h.prisma.$transaction([
    h.prisma.knowledgeBase.create({ data: { id: KB, name: "s10k 库", createdBy: "owner" } }),
    h.prisma.kbMember.create({ data: { id: "s10k_km_o", kbId: KB, userId: "owner", role: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: K, kbId: KB, kind: "doc", title: "K边界", content: "", createdBy: "owner", updatedBy: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: C, kbId: KB, kind: "doc", title: "C子", content: "", parentId: K, createdBy: "owner", updatedBy: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: G, kbId: KB, kind: "doc", title: "G孙", content: "", parentId: C, createdBy: "owner", updatedBy: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: OUT, kbId: KB, kind: "doc", title: "库外普通文档", content: "", createdBy: "owner", updatedBy: "owner" } }),
  ]);
  const { syncNavFromEntitiesTx } = await import("../../../domain/nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  kNode = nodeId("doc", K);
  cNode = nodeId("doc", C);
  gNode = nodeId("doc", G);
  outNode = nodeId("doc", OUT);
  // K 置 restricted（inherit=0），C/G 保持 inherit=1（sync 默认 1）。
  await h.prisma.navNode.update({ where: { id: kNode }, data: { inheritAncestors: 0 } });

  await grant(kNode, "user", UK, "s10k_p_k");
  await grant(nodeId("kb", KB), "user", UB, "s10k_p_kb");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("规则1 K 自身策略仍及子孙（cutoff 收集含 K）", () => {
  it("仅授 K 的用户：K/C/G 均可见", async () => {
    expect(await canR(UK, kNode)).toBe(true);
    expect(await canR(UK, cNode)).toBe(true);
    expect(await canR(UK, gNode)).toBe(true);
  });
});

describe("规则2 子孙链在 K 截断（kb 授予不下 restricted 子树）", () => {
  it("仅授 kb 的用户：K/C/G 不可见（K 自身无授予，cutoff 止于 K）", async () => {
    expect(await canR(UB, kNode)).toBe(false);
    expect(await canR(UB, cNode)).toBe(false);
    expect(await canR(UB, gNode)).toBe(false);
  });

  it("同一用户对 K 子树之外的普通库文档仍可见（kb 授予对其有效，未被一刀切）", async () => {
    expect(await canR(UB, outNode)).toBe(true);
  });
});
