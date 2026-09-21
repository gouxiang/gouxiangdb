// M4/S10 enforce 翻转演练（计划 §7-S10 行680 + §4.8/ADR-0037）：
// off -> shadow（旧测试全绿、双零）-> on 语义（引擎为权威时 AC 对抗集全绿）
// -> 反向 shadow（旧结果仅对比、drift 分类计数正确）-> off 回滚（旧行为逐值恢复、A-5 权威行保留）。
//
// 关键事实（测试内锁定，防误翻）：S10 末七守只有 shadow 对拍缝，无「以引擎为准」生产分支，
// AUTHZ_ENFORCE_READY=false，env=on 被 effectiveAuthzMode 降级 shadow。故本演练：
//   - off/shadow 两态跑真实 HTTP 七守（真 app/真 JWT/真迁移临时库），断言旧行为与 driftRegistry；
//   - 「on 语义」在测试内以 adapter.engineDecideResource 为权威重放七守同上下文，证明一旦接 enforce，
//     AC 对抗集（授权者 allow/无关系者 deny）在引擎裁决下全绿；同时断言生产 env=on 物理上仍走旧结果，
//     即当前没有任何一条请求会因翻 env 而被引擎真拒绝（安全姿态事实，不许静默改变）；
//   - 反向 shadow 用测试内独立 DriftRegistry 对 (旧 HTTP 布尔, 引擎布尔) 分类，验证双零与人工注入计数；
//   - 全程不改任何生产码、不翻 AUTHZ_ENFORCE_READY；env 在用例间显式置位/还原。
//
// 七守覆盖：requireCanView(r) / requireCanEditData(u) / requireCanComment(comment) /
// requireCanManageSchema(manage_schema) / requireCanManageBase(manage_share) /
// requireKb(kb r) / requireDocAccess(doc r/u)。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { driftRegistry, DriftRegistry, classifyDrift } from "../shadow.js";
import { applyAuthzReconcileFixes } from "../reconcile.js";
import { AUTHZ_ENFORCE_READY, effectiveAuthzMode } from "../../../configAuthz.js";
import type { ResourceAction } from "@gx/shared-types";

// 动态 import 纪律：adapter 顶层 import db 单例，须等 setupCharHarness 注入临时库后再 import。
let h: CharHarness;
let engineDecideResource: typeof import("../adapter.js").engineDecideResource;
let baseId: string;
let tableId: string;
let kbId: string;
let docId: string;
let baseNodeId: string;

const USERS = ["f_owner", "f_editor", "f_viewer", "f_stranger"] as const;
type U = (typeof USERS)[number];

// 七守同上下文探针：resource ref（adapter 形态）+ 旧守卫对该主体的 allow 期望（来自夹具事实）。
interface Probe {
  guard: string;
  action: ResourceAction;
  ref: { resourceType: "base" | "kb" | "doc"; resourceId: string };
  old: Record<U, boolean>;
}
let probes: Probe[] = [];

// 只读端点：200=旧 allow，403=旧 deny（stranger 403/404 都算 deny）。
async function httpStatus(user: U, method: string, url: string, body?: unknown): Promise<number> {
  const headers: Record<string, string> = await h.auth(user);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status;
}

beforeAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  h = await setupCharHarness("gx-m4-s10-flip-");
  ({ engineDecideResource } = await import("../adapter.js"));
  for (const u of USERS) await h.createUser(u);
  // 权限核心模型（二）：库门判定收归「角色 × 库」。owner 挂超级管理员（建库硬规则），
  // editor / viewer 各挂一枚视野角色，档位对拍下面 probes 里的旧期望矩阵。
  await h.grantRole("f_owner");
  await h.prisma.role.create({ data: { id: "f_role_view", workspaceId: "ws_default", name: "flip 只读", isSystem: 0, permissions: "[]" } });
  await h.prisma.role.create({ data: { id: "f_role_edit", workspaceId: "ws_default", name: "flip 编辑", isSystem: 0, permissions: "[]" } });
  for (const [u, roleId] of [["f_viewer", "f_role_view"], ["f_editor", "f_role_edit"]] as const) {
    await h.prisma.roleAssignment.create({
      data: { roleId, subjectType: "user", subjectId: u, scopeType: "workspace", createdBy: "seed" },
    });
  }

  const b = await h.app.request("/api/bases", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("f_owner")) },
    body: JSON.stringify({ name: "flip base" }),
  });
  baseId = (await json<{ base: { id: string } }>(b)).base.id;
  await h.prisma.member.create({ data: { baseId, userId: "f_editor", role: "editor" } });
  await h.prisma.member.create({ data: { baseId, userId: "f_viewer", role: "viewer" } });
  const t = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth("f_owner") });
  tableId = (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id;

  const k = await h.app.request("/api/kb", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("f_owner")) },
    body: JSON.stringify({ name: "flip kb" }),
  });
  kbId = (await json<{ knowledgeBase: { id: string } }>(k)).knowledgeBase.id;
  await h.prisma.kbMember.create({ data: { kbId, userId: "f_viewer", role: "viewer" } });
  const d = await h.app.request(`/api/kb/${kbId}/docs`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(await h.auth("f_owner")) },
    body: JSON.stringify({ kind: "doc", title: "d" }),
  });
  docId = (await json<{ doc: { id: string } }>(d)).doc.id;
  await h.prisma.kbDocAcl.create({ data: { docId, userId: "f_editor", role: "editor" } });

  // 角色 × 库 视野：editor 那份逐表勾到 u（改数据），不勾可管理（改结构/分享仍拒）。
  await h.prisma.roleLibraryScope.createMany({
    data: [
      { roleId: "f_role_view", libraryKind: "base", libraryId: baseId, canManage: 0, visible: 1 },
      { roleId: "f_role_view", libraryKind: "kb", libraryId: kbId, canManage: 0, visible: 1 },
      { roleId: "f_role_edit", libraryKind: "base", libraryId: baseId, canManage: 0, visible: 1,
        config: JSON.stringify({ tables: { [tableId]: { read: true, create: true, update: true, delete: false } }, fields: {} }) },
      { roleId: "f_role_edit", libraryKind: "kb", libraryId: kbId, canManage: 0, visible: 1 },
    ],
  });
  // 引擎侧对齐：editor 在旧三表里没有 kb 成员行，现在凭角色视野进得去 kb，
  // 故给 kb 节点补一条 r，否则 shadow 下每处 requireKb 都是 OVERDENY。
  const kbNodeId = (await h.prisma.navNode.findUniqueOrThrow({
    where: { workspaceId_resourceType_resourceId: { workspaceId: "ws_default", resourceType: "kb", resourceId: kbId } },
    select: { id: true },
  })).id;
  await h.prisma.authPolicy.create({
    data: { id: "flip_kbr_editor", workspaceId: "ws_default", nodeId: kbNodeId,
      subjectType: "user", subjectId: "f_editor", actions: "r", createdBy: "t" },
  });

  const fixes = await applyAuthzReconcileFixes(h.prisma);
  expect(fixes.created).toBeGreaterThan(0);
  baseNodeId = (await h.prisma.navNode.findUniqueOrThrow({
    where: { workspaceId_resourceType_resourceId: { workspaceId: "ws_default", resourceType: "base", resourceId: baseId } },
    select: { id: true },
  })).id;

  probes = [
    { guard: "requireCanView", action: "r", ref: { resourceType: "base", resourceId: baseId },
      old: { f_owner: true, f_editor: true, f_viewer: true, f_stranger: false } },
    { guard: "requireCanEditData", action: "u", ref: { resourceType: "base", resourceId: baseId },
      old: { f_owner: true, f_editor: true, f_viewer: false, f_stranger: false } },
    { guard: "requireCanComment", action: "comment", ref: { resourceType: "base", resourceId: baseId },
      old: { f_owner: true, f_editor: true, f_viewer: false, f_stranger: false } },
    { guard: "requireCanManageSchema", action: "manage_schema", ref: { resourceType: "base", resourceId: baseId },
      old: { f_owner: true, f_editor: false, f_viewer: false, f_stranger: false } },
    { guard: "requireCanManageBase", action: "manage_share", ref: { resourceType: "base", resourceId: baseId },
      old: { f_owner: true, f_editor: false, f_viewer: false, f_stranger: false } },
    { guard: "requireKb", action: "r", ref: { resourceType: "kb", resourceId: kbId },
      old: { f_owner: true, f_editor: true, f_viewer: true, f_stranger: false } },
    { guard: "requireDocAccess", action: "r", ref: { resourceType: "doc", resourceId: docId },
      old: { f_owner: true, f_editor: true, f_viewer: true, f_stranger: false } },
  ];
}, 120000);

afterAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  await h.cleanup();
});

beforeEach(() => driftRegistry.reset());
afterEach(() => {
  delete process.env.GX_AUTHZ_ENGINE;
  vi.restoreAllMocks();
});

/** 七族只读探针的旧 HTTP 状态码快照：owner 200、stranger 403/404。 */
async function readSnapshot(): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const u of USERS) {
    out[u] = [
      await httpStatus(u, "GET", `/api/tables?baseId=${baseId}`),
      await httpStatus(u, "GET", `/api/fields?tableId=${tableId}`),
      await httpStatus(u, "GET", `/api/kb/${kbId}`),
      await httpStatus(u, "GET", `/api/kb/docs/${docId}`),
    ];
  }
  return out;
}

describe("翻转演练 1/5 off 基线：旧守卫为准，引擎零接入", () => {
  it("七族读探针 owner 200 / stranger 403|404；drift compared=0（零查询硬证据见 5/5 末，spy 放最末避免污染 delegate）", async () => {
    process.env.GX_AUTHZ_ENGINE = "off";
    const snap = await readSnapshot();
    expect(snap.f_owner!.every((s) => s === 200)).toBe(true);
    expect(snap.f_stranger!.every((s) => s === 403 || s === 404)).toBe(true);
    expect(driftRegistry.snapshot().compared).toBe(0);
  });
});

describe("翻转演练 2/5 shadow：旧结果逐值不变，对拍双零", () => {
  it("同一批读探针状态码与 off 快照全等；overDeny/overAllow/errors=0 且 compared>0", async () => {
    process.env.GX_AUTHZ_ENGINE = "off";
    const offSnap = await readSnapshot();
    process.env.GX_AUTHZ_ENGINE = "shadow";
    const shadowSnap = await readSnapshot();
    expect(shadowSnap).toEqual(offSnap);
    const s = driftRegistry.snapshot();
    expect(s.overDeny).toBe(0);
    expect(s.overAllow).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.compared).toBeGreaterThan(0);
  });
});

describe("翻转演练 3/5 on 语义：门未翻转的事实 + 引擎为权威时 AC 全绿", () => {
  it("READY=false 锁定，env=on 生产物理降级 shadow；引擎布尔与七守旧期望 28 格全等", async () => {
    // 门控事实：S10 不翻默认、无 enforce 接线。
    expect(AUTHZ_ENFORCE_READY).toBe(false);
    expect(effectiveAuthzMode({ GX_AUTHZ_ENGINE: "on" })).toBe("shadow");

    process.env.GX_AUTHZ_ENGINE = "off";
    const offSnap = await readSnapshot();
    process.env.GX_AUTHZ_ENGINE = "on";
    // 物理上 on 降级 shadow：HTTP 旧结果不变（没有请求会因 env=on 被引擎真拒绝）。
    expect(await readSnapshot()).toEqual(offSnap);

    // on 语义（测试内以引擎为权威）：七守 x 四主体，引擎布尔必须与旧守卫期望全等。
    let compared = 0;
    for (const p of probes) {
      for (const u of USERS) {
        const { engineAllowed } = await engineDecideResource(u, p.ref, p.action, h.prisma);
        expect(engineAllowed, `${p.guard}/${u}`).toBe(p.old[u]);
        compared++;
      }
    }
    expect(compared).toBe(28);
  });
});

describe("翻转演练 4/5 反向 shadow：等价双零，人工 OVERALLOW/OVERDENY 分类与旧结果不受影响", () => {
  it("测试内独立 registry：等价序列双零；注入越权行 overAllow=1 旧 HTTP 仍 403；删投影 overDeny=1 旧 HTTP 仍 200", async () => {
    process.env.GX_AUTHZ_ENGINE = "on"; // 生产降级 shadow；反向计数在测试内独立 registry 做。
    const reverse = new DriftRegistry(50);
    for (const p of probes) {
      for (const u of USERS) {
        const { engineAllowed } = await engineDecideResource(u, p.ref, p.action, h.prisma);
        const kind = classifyDrift(p.old[u], engineAllowed);
        reverse.noteCompared();
        if (kind) reverse.record({
          ts: "t", kind, guard: p.guard, action: p.action, nodeId: null,
          userHash: u, oldAllowed: p.old[u], engineAllowed,
        });
      }
    }
    const zero = reverse.snapshot();
    expect(zero.compared).toBe(28);
    expect(zero.overDeny + zero.overAllow).toBe(0);

    // OVERALLOW：给 stranger 在 base 节点插 r -> 引擎 allow、旧 deny；生产未接 enforce，HTTP 仍 403。
    await h.prisma.authPolicy.create({
      data: { id: "flip_overallow", workspaceId: "ws_default", nodeId: baseNodeId, subjectType: "user", subjectId: "f_stranger", actions: "r", createdBy: "t" },
    });
    const oa = await engineDecideResource("f_stranger", { resourceType: "base", resourceId: baseId }, "r", h.prisma);
    expect(oa.engineAllowed).toBe(true);
    expect(classifyDrift(false, true)).toBe("DRIFT_OVERALLOW");
    expect(await httpStatus("f_stranger", "GET", `/api/tables?baseId=${baseId}`)).toBe(403);
    await h.prisma.authPolicy.delete({ where: { id: "flip_overallow" } });

    // OVERDENY：删 editor 的 base 投影 -> 引擎 deny、旧成员表仍 allow，HTTP 200。
    const pol = await h.prisma.authPolicy.findFirstOrThrow({
      where: { nodeId: baseNodeId, subjectType: "user", subjectId: "f_editor" }, select: { id: true },
    });
    await h.prisma.authPolicy.delete({ where: { id: pol.id } });
    const od = await engineDecideResource("f_editor", { resourceType: "base", resourceId: baseId }, "r", h.prisma);
    expect(od.engineAllowed).toBe(false);
    expect(classifyDrift(true, false)).toBe("DRIFT_OVERDENY");
    expect(await httpStatus("f_editor", "GET", `/api/tables?baseId=${baseId}`)).toBe(200);

    // 还原投影（重放 reconcile），恢复双零前提。
    await applyAuthzReconcileFixes(h.prisma);
  });
});

describe("翻转演练 5/5 回 off：旧行为逐值恢复，引擎零接入，A-5 权威行保留", () => {
  it("状态码回 off 快照、auth_policies 零查询；角色授予行 off 下 decide 仍 allow（重开即恢复）", async () => {
    // A-5 不可映射授权（角色授予，旧表无行）。
    await h.prisma.role.create({ data: { id: "flip_role_ro", workspaceId: "ws_default", name: "flip_role_ro", isSystem: 0, permissions: "[]" } });
    await h.prisma.roleAssignment.create({
      data: { roleId: "flip_role_ro", subjectType: "user", subjectId: "f_stranger", scopeType: "workspace", createdBy: "t" },
    });
    await h.prisma.authPolicy.create({
      data: { id: "flip_role_grant", workspaceId: "ws_default", nodeId: baseNodeId, subjectType: "role", subjectId: "flip_role_ro", actions: "r", createdBy: "t" },
    });

    process.env.GX_AUTHZ_ENGINE = "shadow";
    const shadowSnap = await readSnapshot();
    driftRegistry.reset(); // 清掉 shadow 读探针累积的对拍计数，再验证 off 零接入
    process.env.GX_AUTHZ_ENGINE = "off";
    expect(await readSnapshot()).toEqual(shadowSnap); // 回 off 旧行为逐值恢复
    // 角色授予不可映射旧三表：stranger 旧守卫仍 deny（off 下不生效），但权威行保留、引擎仍可求值。
    expect(await httpStatus("f_stranger", "GET", `/api/tables?baseId=${baseId}`)).toBe(403);
    const eng = await engineDecideResource("f_stranger", { resourceType: "base", resourceId: baseId }, "r", h.prisma);
    expect(eng.engineAllowed).toBe(true); // 重开 on 即恢复，无数据迁移
    expect(await h.prisma.authPolicy.count({ where: { id: "flip_role_grant" } })).toBe(1);
    expect(await h.prisma.member.count({ where: { userId: "f_stranger" } })).toBe(0);

    // off 零接入硬证据（放文件最末：vi.spyOn Prisma delegate restore 后会使该方法失效，
    // 与 shadow-integration 同款坑，故其后不得再跑任何引擎/authPolicy 调用）。
    const delegates = h.prisma as unknown as Record<string, Record<string, unknown>>;
    const spies = ["findUnique", "findFirst", "findMany", "count"].map((m) =>
      vi.spyOn(delegates.authPolicy!, m as never) as unknown as ReturnType<typeof vi.fn>);
    expect(await httpStatus("f_viewer", "GET", `/api/tables?baseId=${baseId}`)).toBe(200);
    expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
    expect(driftRegistry.snapshot().compared).toBe(0);
  });
});
