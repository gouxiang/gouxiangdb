// M4/S10 升级等价：随机 20 主体 x 20 节点，验证 ADR-0056 + 迁移#28 后的双口径（确定性选种，不 mock）。
//
// 造 v0.1.0 风格旧三库活行（members / kb_members / kb_doc_acls）+ 与成员身份【刻意独立】的 scope 门角色，
// 经 sync + applyAuthzReconcileFixes 等价升级后，对每个 (用户, 节点) 走真 HTTP effective 求库门/内容动作，
// 与两套独立 oracle 逐对比较（400 格必须全等）：
//
//   - doc 内容 r：随【旧投影 + 祖先继承】延续——旧 kb 成员 r 投在 kb 节点、doc 沿祖先链继承；
//     kb_doc_acls r 直投 doc；kb scope visible 也会让 kb 投 r、doc 继承。
//   - base/kb 库门 enter：【只由 scope role 投影派生】，旧 per-user 成员不自动带库门
//     （迁移#28 明确不接管旧成员放权，管理员在角色编辑器逐库勾选；enter 不得手授，不变量 I1）。
//
// 「旧成员身份 × scope 门身份」四象限必须都出现，锁死 enter 跟 scope 走、不跟旧成员走：
// legacyOnly 证明旧成员不再自带 enter；doorOnly 证明非成员凭 scope role 也能进库。
// 20 主体全部非资源创建人（createdBy=owner），故 creator 兜底不进入判定，纯测成员/门投影。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, json, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { applyAuthzReconcileFixes } from "../reconcile.js";

const N_USER = 20;
const N_BASE = 7;
const N_KB = 7;
const N_DOC = 6; // 前 6 个 kb 各 1 doc；总数 7+7+6=20 节点
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
// doc 内容 r oracle：nodeId -> Set<userId>（仅 doc 节点）。
const contentAllow = new Map<string, Set<string>>();
// base/kb 库门 enter oracle：nodeId -> Set<userId>（仅库节点，只由 scope 角色覆盖派生）。
const doorAllow = new Map<string, Set<string>>();
// 库门四象限（14 库 × 20 人）：legacy 成员身份 与 scope 门身份刻意独立。
const quad = { both: 0, legacyOnly: 0, doorOnly: 0, neither: 0 };

function markInto(map: Map<string, Set<string>>, node: string, user: string): void {
  const set = map.get(node) ?? new Set<string>();
  set.add(user);
  map.set(node, set);
}

function tallyDoor(isLegacy: boolean, hasDoor: boolean): void {
  if (isLegacy && hasDoor) quad.both++;
  else if (isLegacy) quad.legacyOnly++;
  else if (hasDoor) quad.doorOnly++;
  else quad.neither++;
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s10-2020-");
  await h.createUser("owner", { email: "owner@x.com", displayName: "所有者" });
  for (const u of USERS) await h.createUser(u, { email: `${u}@x.com`, displayName: u });
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });

  const rng = makeRng(42); // 旧三表成员
  const doorRng = makeRng(7); // scope 门角色（独立流，刻意与成员不相关）
  const roles = ["viewer", "commenter", "editor"];

  // 7 base + 成员（概率 0.6）；每库一枚门角色（scope visible，概率 0.5）。
  for (let b = 0; b < N_BASE; b++) {
    const id = `s20_b${b}`;
    await h.prisma.base.create({ data: { id, name: `base${b}`, createdBy: "owner" } });
    bases.push(id);
    const node = nodeId("base", id);

    // 每库一枚门角色 + visible=1 scope 行：enter 的唯一合法来源。
    const doorRole = `s20_dr_b${b}`;
    await h.prisma.role.create({ data: { id: doorRole, workspaceId: "ws_default", name: `door base${b}`, isSystem: 0, permissions: "[]" } });
    await h.prisma.roleLibraryScope.create({ data: { roleId: doorRole, libraryKind: "base", libraryId: id, canManage: 0, visible: 1 } });

    for (const u of USERS) {
      const isLegacy = rng() < 0.6;
      if (isLegacy) {
        await h.prisma.member.create({ data: { id: `s20_m_${b}_${u}`, baseId: id, userId: u, role: roles[b % 3]! } });
      }
      const hasDoor = doorRng() < 0.5;
      if (hasDoor) {
        await h.prisma.roleAssignment.create({ data: { roleId: doorRole, subjectType: "user", subjectId: u, scopeType: "workspace", createdBy: "seed" } });
        markInto(doorAllow, node, u);
      }
      tallyDoor(isLegacy, hasDoor);
    }
  }
  // 7 kb + kb 成员（概率 0.5）+ 门角色（概率 0.5）；前 6 个 kb 各 1 doc（doc acl 概率 0.35）。
  for (let k = 0; k < N_KB; k++) {
    const id = `s20_k${k}`;
    await h.prisma.knowledgeBase.create({ data: { id, name: `kb${k}`, createdBy: "owner" } });
    kbs.push(id);
    const kbNode = nodeId("kb", id);

    const doorRole = `s20_dr_k${k}`;
    await h.prisma.role.create({ data: { id: doorRole, workspaceId: "ws_default", name: `door kb${k}`, isSystem: 0, permissions: "[]" } });
    await h.prisma.roleLibraryScope.create({ data: { roleId: doorRole, libraryKind: "kb", libraryId: id, canManage: 0, visible: 1 } });

    const kbMembers = new Set<string>();
    const doorMembers = new Set<string>();
    for (const u of USERS) {
      const isLegacy = rng() < 0.5;
      if (isLegacy) {
        await h.prisma.kbMember.create({ data: { id: `s20_km_${k}_${u}`, kbId: id, userId: u, role: roles[k % 3]! } });
        kbMembers.add(u);
      }
      const hasDoor = doorRng() < 0.5;
      if (hasDoor) {
        await h.prisma.roleAssignment.create({ data: { roleId: doorRole, subjectType: "user", subjectId: u, scopeType: "workspace", createdBy: "seed" } });
        markInto(doorAllow, kbNode, u);
        doorMembers.add(u);
      }
      tallyDoor(isLegacy, hasDoor);
    }

    if (k < N_DOC) {
      const did = `s20_d${k}`;
      await h.prisma.kbDoc.create({ data: { id: did, kbId: id, kind: "doc", title: `doc${k}`, content: "", createdBy: "owner", updatedBy: "owner" } });
      docs.push({ id: did, kb: id });
      const docNode = nodeId("doc", did);
      for (const u of USERS) {
        if (kbMembers.has(u)) markInto(contentAllow, docNode, u); // 旧 kb 成员 -> 继承 content r
        if (doorMembers.has(u)) markInto(contentAllow, docNode, u); // kb scope visible -> kb 投 r，doc 继承
        if (rng() < 0.35) {
          await h.prisma.kbDocAcl.create({ data: { id: `s20_ac_${k}_${u}`, docId: did, userId: u, role: "viewer" } });
          markInto(contentAllow, docNode, u);
        }
      }
    }
  }
  // 直接 prisma 建实体不经过 HTTP 写点，需先同步 nav 节点（生产路径写点已同事务同步）。
  const { syncNavFromEntitiesTx } = await import("../../nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  // 等价升级：把旧三表活行投影到 auth_policies；S 段同步把门角色 scope:role 投影到库节点 enter。
  const fixes = await applyAuthzReconcileFixes(h.prisma);
  expect(fixes.created).toBeGreaterThan(0);
}, 180000);

afterAll(async () => {
  await h.cleanup();
});

/** owner 调用头的记忆化缓存（见 engineAllows 内的说明）。 */
let ownerHeaders: Record<string, string> | null = null;

/** owner 调 effective 查 target 对节点的库门/内容动作（owner 仅作调用方，不影响 target 判定）。 */
async function engineAllows(
  user: string, node: string, action: "r" | "enter",
): Promise<boolean> {
  // owner 头记忆化：400 格会让原写法重签 400 次 JWT（与判定无关的纯开销）。
  // token 只在单个 it 内存活、远长于测试时长，故按调用方固定签一次即安全。
  ownerHeaders ??= await h.auth("owner");
  const res = await h.app.request(`/api/v1/nodes/${node}/effective?userId=${user}`, { headers: ownerHeaders });
  if (res.status === 404 || res.status === 403) return false;
  expect(res.status, `${user}@${node}`).toBe(200);
  const body = await json<{ perAction: Array<{ action: string; allowed: boolean }> }>(res);
  // base/kb 库节点可能不呈现内容 r，缺项即 false。
  return body.perAction.find((p) => p.action === action)?.allowed ?? false;
}

describe("20 主体 x 20 节点：doc r==内容投影，base/kb enter==scope 门投影", () => {
  // 惰性在 it 内构造（describe 回调体在 collect 期求值，早于 beforeAll 填 bases/kbs/docs）。
  const buildNodes = (): Array<{ kind: "base" | "kb" | "doc"; id: string }> => [
    ...bases.map((id) => ({ kind: "base" as const, id: nodeId("base", id) })),
    ...kbs.map((id) => ({ kind: "kb" as const, id: nodeId("kb", id) })),
    ...docs.map((d) => ({ kind: "doc" as const, id: nodeId("doc", d.id) })),
  ];

  it("节点数恰为 20，门/内容 oracle 各自非平凡，且门身份与旧成员不同源", () => {
    const allNodes = buildNodes();
    expect(allNodes).toHaveLength(20);

    let contentCells = 0;
    for (const d of docs) contentCells += contentAllow.get(nodeId("doc", d.id))?.size ?? 0;
    expect(contentCells).toBeGreaterThan(0);
    expect(contentCells).toBeLessThan(N_USER * N_DOC);

    const libNodes = [
      ...bases.map((id) => nodeId("base", id)),
      ...kbs.map((id) => nodeId("kb", id)),
    ];
    let doorCells = 0;
    for (const n of libNodes) doorCells += doorAllow.get(n)?.size ?? 0;
    expect(doorCells).toBeGreaterThan(0);
    expect(doorCells).toBeLessThan(N_USER * (N_BASE + N_KB));

    // 关键非平凡性：四象限都出现，锁死 enter 跟 scope 走、不跟旧成员走。
    expect(quad.both).toBeGreaterThan(0);
    expect(quad.legacyOnly).toBeGreaterThan(0);
    expect(quad.doorOnly).toBeGreaterThan(0);
    expect(quad.neither).toBeGreaterThan(0);
  });

  // 显式放宽本单例预算：400 格逐对真 HTTP × 每次约 30-40 次串行 SQLite 往返，空闲态实测约 3-4s，
  // 全量并行下 CPU/IO 争用可放大 2-3× 越过 5s 默认预算。断言路径确定性（固定 seed、无 Date.now/Math.random），
  // 超时轮只是同一序列被截断的前缀，属**负载**而非正确性，故按需放宽单例预算（不动全局 testTimeout）。
  it("400 格逐对全等（确定性选种，不抽样）", { timeout: 30000 }, async () => {
    const allNodes = buildNodes();
    const mismatches: string[] = [];
    for (const u of USERS) {
      for (const n of allNodes) {
        const want = n.kind === "doc"
          ? (contentAllow.get(n.id)?.has(u) ?? false)
          : (doorAllow.get(n.id)?.has(u) ?? false);
        // base/kb 库节点对应库门 enter，doc 内容节点对应 r。
        const got = await engineAllows(u, n.id, n.kind === "doc" ? "r" : "enter");
        if (got !== want) mismatches.push(`${u}@${n.kind}:${n.id} want=${want} got=${got}`);
      }
    }
    expect(mismatches, `漂移格:\n${mismatches.slice(0, 20).join("\n")}`).toEqual([]);
  });
});
