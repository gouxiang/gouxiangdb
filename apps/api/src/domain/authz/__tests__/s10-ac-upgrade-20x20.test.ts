// M4/S10 回填升级等价：随机 20 主体 x 20 节点新旧判定全同（确定性选种，不 mock）。
//
// 造 v0.1.0 风格旧三库活行（members / kb_members / kb_doc_acls，仅旧表不写 auth_policies），
// 经 reconcile --apply 等价升级投影后，对每个 (用户, 节点) 用引擎 effective 求 r，
// 与"旧三表角色档直接派生的 r oracle"逐对比较，400 格必须全等（升级不改判定）。
//
// 旧 r oracle（requireDocAccess = kbMember 或 kbDocAcl 取较高；成员任一档位均含 r）：
//   base 节点：members(base,user) 活行存在
//   kb   节点：kb_members(kb,user) 活行存在
//   doc  节点：kb_members(doc.kb,user) 或 kb_doc_acls(doc,user) 任一存在
// 20 主体全部非资源创建人（createdBy=owner），故 creator 兜底不进入 oracle，纯测成员投影。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, json, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { applyAuthzReconcileFixes } from "../reconcile.js";

const N_USER = 20;
const N_BASE = 7;
const N_KB = 7;
const N_DOC = 6; // 每个 kb 各 1 doc；总数 7+7+6=20 节点
const USERS = Array.from({ length: N_USER }, (_, i) => `su_${i}`);

/** 确定性 LCG（选种 42），返回 [0,1)。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let h: CharHarness;
const bases: string[] = [];
const kbs: string[] = [];
const docs: Array<{ id: string; kb: string }> = [];
// 旧三表 r oracle：nodeId -> Set<userId>
const legacyAllow = new Map<string, Set<string>>();

function mark(node: string, user: string): void {
  const set = legacyAllow.get(node) ?? new Set<string>();
  set.add(user);
  legacyAllow.set(node, set);
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s10-2020-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  for (const u of USERS) await h.createUser(u, { email: `${u}@x.com`, displayName: u });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });

  const rng = makeRng(42);
  const roles = ["viewer", "commenter", "editor"];

  // 7 base + 每 base 成员（概率 0.6）。
  for (let b = 0; b < N_BASE; b++) {
    const id = `s20_b${b}`;
    await h.prisma.base.create({ data: { id, name: `base${b}`, createdBy: "owner" } });
    bases.push(id);
    const node = nodeId("base", id);
    for (const u of USERS) {
      if (rng() < 0.6) {
        await h.prisma.member.create({ data: { id: `s20_m_${b}_${u}`, baseId: id, userId: u, role: roles[b % 3]! } });
        mark(node, u);
      }
    }
  }
  // 7 kb + kb 成员（概率 0.5）；前 6 个 kb 各 1 doc（doc acl 概率 0.35）。
  for (let k = 0; k < N_KB; k++) {
    const id = `s20_k${k}`;
    await h.prisma.knowledgeBase.create({ data: { id, name: `kb${k}`, createdBy: "owner" } });
    kbs.push(id);
    const kbNode = nodeId("kb", id);
    const kbMembers = new Set<string>();
    for (const u of USERS) {
      if (rng() < 0.5) {
        await h.prisma.kbMember.create({ data: { id: `s20_km_${k}_${u}`, kbId: id, userId: u, role: roles[k % 3]! } });
        kbMembers.add(u);
        mark(kbNode, u);
      }
    }
    if (k < N_DOC) {
      const did = `s20_d${k}`;
      await h.prisma.kbDoc.create({ data: { id: did, kbId: id, kind: "doc", title: `doc${k}`, content: "", createdBy: "owner", updatedBy: "owner" } });
      docs.push({ id: did, kb: id });
      const docNode = nodeId("doc", did);
      for (const u of USERS) {
        if (kbMembers.has(u)) mark(docNode, u); // 继承 kb 成员
        if (rng() < 0.35) {
          await h.prisma.kbDocAcl.create({ data: { id: `s20_ac_${k}_${u}`, docId: did, userId: u, role: "viewer" } });
          mark(docNode, u);
        }
      }
    }
  }
  // 直接 prisma 建实体不经过 HTTP 写点，需先同步 nav 节点（生产路径写点已同事务同步）。
  const { syncNavFromEntitiesTx } = await import("../../nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  // 写点已同步 nav 节点；等价升级：把旧三表活行投影到 auth_policies。
  const fixes = await applyAuthzReconcileFixes(h.prisma);
  expect(fixes.created).toBeGreaterThan(0);
}, 180000);

afterAll(async () => {
  await h.cleanup();
});

/** owner 调 effective 查 target 对节点的 r（owner 仅作调用方，不影响 target 判定）。 */
async function engineAllowsR(user: string, node: string): Promise<boolean> {
  const res = await h.app.request(`/api/v1/nodes/${node}/effective?userId=${user}`, { headers: await h.auth("owner") });
  if (res.status === 404 || res.status === 403) return false;
  expect(res.status, `${user}@${node}`).toBe(200);
  const body = await json<{ perAction: Array<{ action: string; allowed: boolean }> }>(res);
  return body.perAction.find((p) => p.action === "r")!.allowed;
}

describe("20 主体 x 20 节点：引擎 r 判定 == 旧三表 oracle（升级 0 漂移）", () => {
  // 惰性在 it 内构造（describe 回调体在 collect 期求值，早于 beforeAll 填 bases/kbs/docs）。
  const buildNodes = (): Array<{ kind: "base" | "kb" | "doc"; id: string }> => [
    ...bases.map((id) => ({ kind: "base" as const, id: nodeId("base", id) })),
    ...kbs.map((id) => ({ kind: "kb" as const, id: nodeId("kb", id) })),
    ...docs.map((d) => ({ kind: "doc" as const, id: nodeId("doc", d.id) })),
  ];

  it("节点数恰为 20，且 oracle 既有 allow 也有 deny（夹具非平凡）", () => {
    const allNodes = buildNodes();
    expect(allNodes).toHaveLength(20);
    let allowCells = 0;
    for (const n of allNodes) allowCells += legacyAllow.get(n.id)?.size ?? 0;
    expect(allowCells).toBeGreaterThan(0);
    expect(allowCells).toBeLessThan(N_USER * 20);
  });

  it("400 格逐对全等（确定性选种，不抽样）", async () => {
    const allNodes = buildNodes();
    const mismatches: string[] = [];
    for (const u of USERS) {
      for (const n of allNodes) {
        const want = legacyAllow.get(n.id)?.has(u) ?? false;
        const got = await engineAllowsR(u, n.id);
        if (got !== want) mismatches.push(`${u}@${n.kind}:${n.id} want=${want} got=${got}`);
      }
    }
    expect(mismatches, `漂移格:\n${mismatches.slice(0, 20).join("\n")}`).toEqual([]);
  });
});
